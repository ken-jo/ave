import "../../../../test/renderer/setup.js";
import { assert, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "../../../data/settings-defaults.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";
import { SettingsEditorProvider, useSettingsEditor } from "../context/SettingsEditorContext.js";
import { useSettingsOrchestration } from "../hooks/use-settings-orchestration.js";
import type { AppSettings, AveApi } from "../types.js";
import { WebTab } from "../tabs/WebTab.js";
import { t } from "../../../i18n/runtime.js";
import { requiredFixture } from "../../../__tests__/support/required-fixture.js";

describe("secret setting resets", () => {
  it("shows a stored key in Modified even when another provider is selected and deletes only through its owner", async () => {
    const { api } = makeMockAveApi({ settings: structuredClone(DEFAULT_SETTINGS) });
    let present = true;
    api.hasWebApiKey.mockImplementation(async (provider: string) => provider === "tavily" && present);
    api.deleteWebApiKey.mockImplementation(async () => { present = false; return { ok: true }; });
    window.aveApi = api as never;
    const view = render(<SettingsEditorProvider api={api as never} modifiedOnly><WebTab api={api as never}
      webProvider="duckduckgo" setWebProvider={vi.fn()} hasWebKey={false} setHasWebKey={vi.fn()}
      webKeyInput="" setWebKeyInput={vi.fn()} onSaved={vi.fn()} onSaveKey={async () => true} saving={false} /></SettingsEditorProvider>);
    const row = await waitFor(() => { const node = view.container.querySelector<HTMLElement>('[data-settings-actions="web-api-key"] [data-setting-id="webSearch.apiKey.tavily"]'); assert(node); return node; });
    expect(row.dataset.settingModified).toBe("true");
    const reset = row.querySelector<HTMLButtonElement>("button"); assert(reset);
    fireEvent.click(reset);
    await waitFor(() => expect(api.deleteWebApiKey).toHaveBeenCalledExactlyOnceWith("tavily"));
    await waitFor(() => expect(view.container.querySelector('[data-settings-actions="web-api-key"] [data-setting-id="webSearch.apiKey.tavily"]')).toBeNull());
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
  it("keeps a stored secret marked modified when its owner refuses deletion", async () => {
    const { api } = makeMockAveApi({ settings: structuredClone(DEFAULT_SETTINGS) });
    api.hasWebApiKey.mockImplementation(async (provider: string) => provider === "tavily");
    api.deleteWebApiKey.mockResolvedValue({ ok: false, error: "secret-store-unavailable" });
    window.aveApi = api as never;
    const view = render(<SettingsEditorProvider api={api as never} modifiedOnly><WebTab api={api as never}
      webProvider="tavily" setWebProvider={vi.fn()} hasWebKey setHasWebKey={vi.fn()}
      webKeyInput="" setWebKeyInput={vi.fn()} onSaved={vi.fn()} onSaveKey={async () => true} saving={false} /></SettingsEditorProvider>);
    const row = await waitFor(() => { const node = view.container.querySelector<HTMLElement>('[data-settings-actions="web-api-key"] [data-setting-id="webSearch.apiKey.tavily"]'); assert(node); return node; });
    const reset = row.querySelector<HTMLButtonElement>("button"); assert(reset);
    fireEvent.click(reset);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(row.dataset.settingModified).toBe("true");
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
  it("retries defaults and secret-presence hydration through one recovery action", async () => {
    const { api } = makeMockAveApi({ settings: structuredClone(DEFAULT_SETTINGS) });
    api.getSettingsDefaults.mockRejectedValueOnce(new Error("Temporary defaults read failure"));
    window.aveApi = api as never;
    const view = render(<SettingsEditorProvider api={api as never} modifiedOnly><WebTab api={api as never}
      webProvider="tavily" setWebProvider={vi.fn()} hasWebKey={false} setHasWebKey={vi.fn()}
      webKeyInput="" setWebKeyInput={vi.fn()} onSaved={vi.fn()} onSaveKey={async () => true} saving={false} /></SettingsEditorProvider>);
    const retry = await view.findByRole("button", { name: /Retry|다시 시도|settingsEditor.retry/ });
    const before = api.hasWebApiKey.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(api.getSettingsDefaults).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.hasWebApiKey.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  });
});

function WebSettings({ api }: { api: AveApi }) {
  const s = useSettingsOrchestration(api, vi.fn());
  const editor = useSettingsEditor();
  return <>
    <WebTab api={api} webProvider={s.webProvider} setWebProvider={s.setWebProvider} hasWebKey={s.hasWebKey} setHasWebKey={s.setHasWebKey}
      webKeyInput={s.webKeyInput} setWebKeyInput={s.setWebKeyInput} onSaved={vi.fn()} onSaveKey={s.saveWebApiKey} saving={s.saving} />
    <button type="button" onClick={() => { void editor?.reset("webSearch.provider"); }}>reset provider</button>
  </>;
}

function keyInput(container: HTMLElement): HTMLInputElement {
  return requiredFixture(container.querySelector<HTMLInputElement>("#web-api-key-input"));
}

describe("Web provider reset", () => {
  function mount(provider: AppSettings["webSearch"]["provider"]) {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.webSearch.provider = provider;
    const { api } = makeMockAveApi({ settings });
    api.hasWebApiKey.mockImplementation(async (id: string) => id === "tavily");
    window.aveApi = api as never;
    const view = render(<SettingsEditorProvider api={api as never} modifiedOnly={false}><WebSettings api={api as unknown as AveApi} /></SettingsEditorProvider>);
    return { api, view };
  }

  it("moves the selected provider and its key field to the stored default after a reset", async () => {
    const { api, view } = mount("tavily");
    const tavily = await view.findByRole("button", { name: "Tavily AI" });
    await waitFor(() => expect(tavily.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(keyInput(view.container).placeholder).toBe(t("webTab.replaceKeyPlaceholder")));
    fireEvent.change(keyInput(view.container), { target: { value: "unsaved-key" } });
    fireEvent.click(view.getByRole("button", { name: "reset provider" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ webSearch: { provider: DEFAULT_SETTINGS.webSearch.provider } }));
    const stored = (await api.getSettings()) as AppSettings;
    expect(stored.webSearch.provider).toBe(DEFAULT_SETTINGS.webSearch.provider);
    await waitFor(() => expect(view.getByRole("button", { name: "DuckDuckGo" }).getAttribute("aria-pressed")).toBe("true"));
    expect(tavily.getAttribute("aria-pressed")).toBe("false");
    const key = keyInput(view.container);
    expect(key.value).toBe("");
    expect(key.dataset.settingId).toBe("webSearch.apiKey.duckduckgo");
    await waitFor(() => expect(key.placeholder).not.toBe(t("webTab.replaceKeyPlaceholder")));
  });

  it("follows a provider change saved by another window", async () => {
    const { api, view } = mount("duckduckgo");
    await waitFor(() => expect(view.getByRole("button", { name: "DuckDuckGo" }).getAttribute("aria-pressed")).toBe("true"));
    await api.updateSettings({ webSearch: { provider: "tavily" } });
    await waitFor(() => expect(view.getByRole("button", { name: "Tavily AI" }).getAttribute("aria-pressed")).toBe("true"));
    const key = keyInput(view.container);
    expect(key.dataset.settingId).toBe("webSearch.apiKey.tavily");
    await waitFor(() => expect(key.placeholder).toBe(t("webTab.replaceKeyPlaceholder")));
  });
});

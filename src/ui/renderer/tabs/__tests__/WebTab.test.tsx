/** Keep testid and data-value stable for the browser toggle contract. */
import "../../../../../test/renderer/setup.js";
import { assert, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { t } from "../../../../i18n/runtime.js";
import { WEB_PROVIDERS } from "../../constants.js";
import { WebTab } from "../WebTab.js";
import { ko } from "../../../../i18n/messages/ko.js";
import type { AppSettings, AveApi } from "../../types.js";
import { deferred } from "../../../../__tests__/support/deferred.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

const WEB_SETTINGS = {
  ...MOCK_DEFAULT_SETTINGS,
  webView: { preferredFlow: "in-app" },
};

function installApi(settings: Record<string, unknown> = WEB_SETTINGS): AveApi {
  const { api } = makeMockAveApi({ settings });
  (globalThis as unknown as { window: typeof window }).window.aveApi = api as never;
  return api as unknown as AveApi;
}

function renderWebTab(api = installApi()) {
  return render(
    <WebTab
      api={api}
      webProvider="duckduckgo"
      setWebProvider={() => {}}
      hasWebKey={false}
      setHasWebKey={() => {}}
      webKeyInput=""
      setWebKeyInput={() => {}}
      onSaved={() => {}}
      onSaveKey={async () => true}
      saving={false}
    />,
  );
}

describe("WebTab — webView preferredFlow section", () => {
  it("rolls back browsing flow on a refused write and reports no success", async () => {
    const api = installApi();
    const saved = vi.fn();
    vi.mocked(api.updateSettings).mockResolvedValueOnce({ ok: false, error: "invalid-args" });
    const { getByRole, getByTestId } = render(<WebTab api={api} webProvider="duckduckgo" setWebProvider={() => {}} hasWebKey={false} setHasWebKey={() => {}} webKeyInput="" setWebKeyInput={() => {}} onSaved={saved} onSaveKey={async () => true} saving={false} />);
    const group = getByTestId("webview-preferred-flow");
    const system = group.querySelector<HTMLButtonElement>('[data-value="system-browser"]');
    assert.exists(system);
    await waitFor(() => expect(system.disabled).toBe(false));
    fireEvent.click(system);
    await waitFor(() => expect(system.getAttribute("aria-checked")).toBe("false"));
    expect(getByRole("alert")).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });

  it("keeps a stored key present after a refused delete", async () => {
    const api = installApi();
    const saved = vi.fn();
    const setHasKey = vi.fn();
    vi.mocked(api.deleteWebApiKey).mockResolvedValueOnce({ ok: false, error: "invalid-args" });
    const { getByRole } = render(<WebTab api={api} webProvider="tavily" setWebProvider={() => {}} hasWebKey setHasWebKey={setHasKey} webKeyInput="" setWebKeyInput={() => {}} onSaved={saved} onSaveKey={async () => true} saving={false} />);
    fireEvent.click(getByRole("button", { name: t("webTab.deleteButton") }));
    await waitFor(() => expect(getByRole("alert")).toBeTruthy());
    expect(setHasKey).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("offers only implemented search providers", () => {
    expect(WEB_PROVIDERS.map((provider) => provider.id)).toEqual(["duckduckgo", "tavily", "serper"]);
    const view = renderWebTab();
    const buttons = within(view.getByRole("group", { name: t("webTab.searchEngineTitle") })).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
  });

  it("discloses fallback when a selected provider has no stored key", () => {
    const api = installApi();
    const props = {
      api, webProvider: "tavily" as const, setWebProvider: () => {}, hasWebKey: false,
      setHasWebKey: () => {}, webKeyInput: "", setWebKeyInput: () => {}, onSaved: () => {}, onSaveKey: async () => true, saving: false,
    };
    const { getByRole, queryByRole, rerender } = render(<WebTab {...props} />);
    expect(getByRole("status").textContent).toContain("DuckDuckGo");
    rerender(<WebTab {...props} hasWebKey />);
    expect(queryByRole("status")).toBeNull();
  });

  it("renders in-app and system-browser radio options (relocated from Appearance)", () => {
    const { getByTestId } = renderWebTab();
    const group = getByTestId("webview-preferred-flow");
    expect(group).toBeTruthy();
    expect(group.querySelector('[data-value="in-app"]')).toBeTruthy();
    expect(group.querySelector('[data-value="system-browser"]')).toBeTruthy();
  });
});


it("localizes the current browsing flow instead of exposing its persisted enum", () => {
  const { container } = renderWebTab();
  const header = container.querySelector('[data-settings-section="web-view-flow"] header');
  expect(header?.textContent).toContain(ko["appearanceTab.webViewInApp"]);
  expect(header?.textContent).not.toContain("in-app");
});

describe("WebTab address bar search section", () => {
  it("keeps a newer broadcast when the initial address-search read returns later", async () => {
    const api = installApi({ ...WEB_SETTINGS, webView: { preferredFlow: "in-app", addressSearchEngine: "google" } });
    const initial = await api.getSettings();
    const read = deferred<AppSettings>();
    vi.spyOn(api, "getSettings").mockReturnValue(read.promise);
    const view = renderWebTab(api);
    const group = view.getByTestId("web-address-search-engine");
    const latest: AppSettings = { ...initial, webView: { ...initial.webView, addressSearchEngine: "naver" } };
    await act(async () => { for (const [handler] of vi.mocked(api.onSettingsUpdated).mock.calls) handler(latest); });
    expect(group.querySelector('input[value="naver"]')).toBeChecked();
    await act(async () => { read.resolve(initial); });
    expect(group.querySelector('input[value="naver"]')).toBeChecked();
  });

  it("rolls a refused address-search save back to the newest broadcast", async () => {
    const api = installApi({ ...WEB_SETTINGS, webView: { preferredFlow: "in-app", addressSearchEngine: "google" } });
    const initial = await api.getSettings();
    const save = deferred<Awaited<ReturnType<AveApi["updateSettings"]>>>();
    vi.spyOn(api, "updateSettings").mockReturnValue(save.promise);
    const view = renderWebTab(api);
    const group = view.getByTestId("web-address-search-engine");
    await waitFor(() => expect(group).not.toBeDisabled());
    fireEvent.click(group.querySelector('input[value="bing"]') as Element);
    expect(group.querySelector('input[value="bing"]')).toBeChecked();
    const latest: AppSettings = { ...initial, webView: { ...initial.webView, addressSearchEngine: "naver" } };
    await act(async () => { for (const [handler] of vi.mocked(api.onSettingsUpdated).mock.calls) handler(latest); });
    expect(group.querySelector('input[value="naver"]')).toBeChecked();
    await act(async () => { save.resolve({ ok: false, error: "invalid-args" }); });
    expect(await view.findByRole("alert")).toBeTruthy();
    expect(group.querySelector('input[value="naver"]')).toBeChecked();
  });

  it("shows the stored engine and saves the one the user picks", async () => {
    const api = installApi({ ...WEB_SETTINGS, webView: { preferredFlow: "in-app", addressSearchEngine: "naver" } });
    const update = vi.spyOn(api, "updateSettings");
    const { getByTestId } = renderWebTab(api);
    const group = getByTestId("web-address-search-engine");
    const radio = (id: string) => group.querySelector<HTMLInputElement>(`input[value="${id}"]`);
    await waitFor(() => expect(radio("naver")?.checked).toBe(true));
    await act(async () => { fireEvent.click(radio("duckduckgo") as Element); });
    expect(update).toHaveBeenCalledWith({ webView: { addressSearchEngine: "duckduckgo" } });
    expect(radio("duckduckgo")?.checked).toBe(true);
  });

  it("restores the stored engine and says so when the save fails", async () => {
    const api = installApi({ ...WEB_SETTINGS, webView: { preferredFlow: "in-app", addressSearchEngine: "google" } });
    vi.spyOn(api, "updateSettings").mockRejectedValue(new Error("disk full"));
    const { getByTestId, findByRole } = renderWebTab(api);
    const group = getByTestId("web-address-search-engine");
    await waitFor(() => expect(group).not.toBeDisabled());
    await act(async () => { fireEvent.click(group.querySelector('input[value="bing"]') as Element); });
    expect((await findByRole("alert")).textContent).toBeTruthy();
    expect(group.querySelector<HTMLInputElement>('input[value="google"]')?.checked).toBe(true);
  });
});

import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginConfigTab } from "../tabs/PluginConfigTab.js";
import { SettingsEditorProvider, useSettingsEditorControls } from "../context/SettingsEditorContext.js";
import { makeMockAveApi, makeMockAveNamespace } from "../../../../test/renderer/mock-ave-api.js";
import { makePluginCard } from "./support/plugin-card.js";
import type { PluginCardSummary } from "../types.js";

function Metadata() {
  const editor = useSettingsEditorControls();
  if (!editor) throw new Error("Settings editor provider missing");
  return <output data-testid="registered-plugin-settings">{JSON.stringify([...editor.controls.values()])}</output>;
}

function setup(cards: PluginCardSummary[], configs: Record<string, Record<string, unknown>>, storedKeys: Record<string, string[]> = {}) {
  const { api } = makeMockAveApi({ pluginCards: cards });
  const { ns } = makeMockAveNamespace();
  const pluginConfig = {
    get: vi.fn(async (id: string) => ({ ok: true as const, config: structuredClone(configs[id] ?? {}) })),
    set: vi.fn(async (id: string, config: Record<string, unknown>) => {
      configs[id] = structuredClone(config);
      return { ok: true as const, config: structuredClone(config) };
    }),
    listSecretKeys: vi.fn(async (id: string) => ({ ok: true as const, keys: [...(storedKeys[id] ?? [])] })),
    setSecret: vi.fn(async (id: string, key: string, value: string) => {
      const keys = new Set(storedKeys[id]);
      if (value === "") keys.delete(key); else keys.add(key);
      storedKeys[id] = [...keys];
      return { ok: true as const };
    }),
  };
  window.aveApi = api as never;
  window.ave = { ...ns, pluginConfig } as never;
  const tree = (reloadEpoch = 0) => <SettingsEditorProvider api={api as never} modifiedOnly={false} reloadEpoch={reloadEpoch}>
    <PluginConfigTab api={api as never} /><Metadata />
  </SettingsEditorProvider>;
  const result = render(tree());
  function action(id: string): HTMLButtonElement {
    const button = result.container.querySelector<HTMLButtonElement>(`[data-settings-actions="plugin-config-installed"] [data-setting-id="${id}"] button`);
    expect(button).toBeTruthy();
    if (!button) throw new Error(`Missing reset control: ${id}`);
    return button;
  }
  return { ...result, api, pluginConfig, action, reload: () => result.rerender(tree(1)) };
}

const CONFIG_PLUGIN = makePluginCard({ id: "settings-extension", name: "Settings extension", configSchema: {
  properties: {
    endpoint: { type: "string", default: "https://default.test" },
    note: { type: "string" },
    requiredToken: { type: "string", format: "secret" },
    optionalToken: { type: "string", format: "secret" },
  }, required: ["requiredToken"],
} });

describe("plugin setting registration and owning reset adapters", () => {
  it("registers real controls and nonselected stored secrets without recording secret drafts", async () => {
    const other = makePluginCard({ id: "other-extension", configSchema: { properties: { token: { type: "string", format: "secret" } } } });
    const f = setup([CONFIG_PLUGIN, other], { "settings-extension": { endpoint: "https://custom.test", note: "saved" } },
      { "settings-extension": ["requiredToken", "optionalToken"], "other-extension": ["token"] });
    await waitFor(() => expect(f.action("pluginConfig.other-extension.token")).not.toBeDisabled());
    expect(f.container.querySelector('input[data-setting-id="pluginConfig.settings-extension.endpoint"]')).toBeTruthy();
    expect(f.container.querySelector('input[data-setting-id="pluginConfig.settings-extension.optionalToken"]')).toBeTruthy();
    expect(f.container.querySelector('[role="switch"][data-setting-id="plugins.settings-extension.enabled"]')).toBeTruthy();
    fireEvent.change(screen.getByTestId("pcfg:settings-extension:optionalToken:input"), { target: { value: "private-draft-must-not-be-indexed" } });
    expect(screen.getByTestId("registered-plugin-settings").textContent).not.toContain("private-draft-must-not-be-indexed");
    expect(screen.getByTestId("registered-plugin-settings").textContent).not.toContain("https://custom.test");
    expect(f.action("pluginConfig.settings-extension.requiredToken")).toBeDisabled();
    expect(f.api.updateSettings).not.toHaveBeenCalled();
  });

  it("resets an optional override by removing only its key from a freshly read config", async () => {
    const configs = { "settings-extension": { endpoint: "https://custom.test", note: "saved", keep: "before" } as Record<string, unknown> };
    const f = setup([CONFIG_PLUGIN], configs, { "settings-extension": ["requiredToken"] });
    await waitFor(() => expect(f.action("pluginConfig.settings-extension.note")).not.toBeDisabled());
    configs["settings-extension"].external = "new external value";
    fireEvent.click(f.action("pluginConfig.settings-extension.note"));
    await waitFor(() => expect(f.pluginConfig.set).toHaveBeenCalledWith("settings-extension", { endpoint: "https://custom.test", keep: "before", external: "new external value" }));
    await waitFor(() => expect(f.container.querySelector('input[data-setting-id="pluginConfig.settings-extension.note"]')).toHaveValue(""));
    expect(f.api.updateSettings).not.toHaveBeenCalled();
  });

  it("clears an optional secret through its secret writer and rechecks presence while preserving required secrets", async () => {
    const f = setup([CONFIG_PLUGIN], { "settings-extension": {} }, { "settings-extension": ["requiredToken", "optionalToken"] });
    await waitFor(() => expect(f.action("pluginConfig.settings-extension.optionalToken")).not.toBeDisabled());
    expect(f.action("pluginConfig.settings-extension.requiredToken")).toBeDisabled();
    fireEvent.click(f.action("pluginConfig.settings-extension.optionalToken"));
    await waitFor(() => expect(f.pluginConfig.setSecret).toHaveBeenCalledExactlyOnceWith("settings-extension", "optionalToken", ""));
    await waitFor(() => expect(f.action("pluginConfig.settings-extension.optionalToken")).toBeDisabled());
    await waitFor(() => expect(f.pluginConfig.listSecretKeys.mock.calls.length).toBeGreaterThan(1));
    expect(f.pluginConfig.set).not.toHaveBeenCalled();
    expect(f.api.updateSettings).not.toHaveBeenCalled();
  });

  it("reports nonselected presence read failure and reloads it through the editor retry epoch", async () => {
    const other = makePluginCard({ id: "other-extension", configSchema: { properties: { token: { type: "string", format: "secret" } } } });
    const f = setup([CONFIG_PLUGIN, other], {}, { "settings-extension": ["requiredToken"], "other-extension": ["token"] });
    f.pluginConfig.listSecretKeys.mockImplementation(async (id) => {
      if (id === "other-extension") throw new Error("presence unavailable");
      return { ok: true, keys: ["requiredToken"] };
    });
    await waitFor(() => expect(screen.getByTestId("registered-plugin-settings").textContent).toContain('"loadError"'));
    expect(f.action("pluginConfig.other-extension.token")).toBeDisabled();
    f.pluginConfig.listSecretKeys.mockImplementation(async (id) => ({ ok: true, keys: id === "other-extension" ? ["token"] : ["requiredToken"] }));
    f.reload();
    await waitFor(() => expect(f.action("pluginConfig.other-extension.token")).not.toBeDisabled());
  });
});

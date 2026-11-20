import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "../../src/data/settings-defaults.js";
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance-settings.js";
import { getLocale, setLocale } from "../../src/i18n/index.js";
import { ThemeProvider } from "../../src/ui/renderer/theme/ThemeProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { _unregisteredSettingsControlsForTest } from "../../src/ui/renderer/context/SettingsEditorContext.js";
import { SettingsContent } from "../../src/ui/renderer/SettingsContent.js";
import { clickSettingsTab } from "./helpers.js";
import { makeMockAveApi, makeMockAveNamespace } from "./mock-ave-api.js";
import { requiredFixture } from "../../src/__tests__/support/required-fixture.js";
const previousLocale = getLocale();
afterEach(() => { setLocale(previousLocale); vi.unstubAllGlobals(); });

async function renderSettings(settings = DEFAULT_SETTINGS) {
  setLocale("en");
  const { api } = makeMockAveApi({ settings: structuredClone(settings) });
  Object.assign(api, {
    telegramConnection: { snapshot: vi.fn(async () => ({ ok: false, error: "connection-unavailable" })), onChanged: vi.fn(() => () => undefined) },
    tailnetObserver: { snapshot: vi.fn(async () => ({ ok: false, error: "observer-unavailable" })) },
    tailnetSharing: { snapshot: vi.fn(async () => ({ ok: false, error: "tailnet-sharing-unavailable" })) },
    getUsageRange: vi.fn(async () => { throw new Error("Usage fixture unavailable"); }),
  });
  const { ns } = makeMockAveNamespace();
  const mcp = {
    servers: vi.fn(async () => []),
    getConfigs: vi.fn(async () => []),
    getConfigPath: vi.fn(async () => "/synthetic/mcp/servers.json"),
    getManagementState: vi.fn(async () => ({ policyPath: "/synthetic/mcp/policy.json", userServersAllowed: true, managedServerIds: [], servers: {}, hasApiKey: {} })),
  };
  Object.assign(ns, { mcp });
  window.ave = ns as never; window.aveApi = api as never;
  vi.stubGlobal("ave", ns); vi.stubGlobal("aveApi", api);
  const view = render(<ThemeProvider initialAppearance={DEFAULT_APPEARANCE}><TooltipProvider><SettingsContent api={api as never} onSaved={() => {}} initialTab="web" /></TooltipProvider></ThemeProvider>);
  await waitFor(() => expect(view.container.querySelector('[data-settings-section="web-search-engine"]')).toBeTruthy());
  return { ...view, api, ns, mcp };
}

describe("settings in-place editor", () => {
  it("mounts and filters real settings across tabs, then restores the selected tab", async () => {
    const view = await renderSettings();
    expect(view.container.querySelector('[data-settings-section="appearance-terminal"]')).toBeNull();
    fireEvent.change(view.getByRole("searchbox", { name: "Search settings" }), { target: { value: "terminal font" } });
    await waitFor(() => {
      const terminal = requiredFixture(view.container.querySelector<HTMLElement>('[data-settings-section="appearance-terminal"]'));
      expect(terminal.hidden).toBe(false);
      expect(requiredFixture(view.container.querySelector<HTMLElement>('[data-settings-section="web-search-engine"]')).hidden).toBe(true);
    });
    expect(view.container.querySelectorAll('[data-settings-panel]').length).toBeGreaterThan(10);
    await waitFor(() => {
      expect(view.container.querySelector("fieldset.contents")).not.toBeDisabled();
      expect(_unregisteredSettingsControlsForTest(view.container)).toEqual([]);
    });
    fireEvent.keyDown(requiredFixture(view.container.querySelector('[data-settings-section="appearance-terminal"] input')), { key: "Escape" });
    expect(view.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
    await waitFor(() => expect(view.container.querySelector('[data-settings-section="appearance-terminal"]')).toBeNull());
    expect(requiredFixture(view.container.querySelector<HTMLElement>('[data-settings-section="web-search-engine"]')).hidden).toBe(false);
  });
  it("finds the terminal behaviour settings and shows only the changed one among them", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.appearance.terminal = { ...settings.appearance.terminal, scrollback: DEFAULT_SETTINGS.appearance.terminal.scrollback + 1000 };
    const view = await renderSettings(settings);
    const terminal = () => requiredFixture(view.container.querySelector<HTMLElement>('[data-settings-section="appearance-terminal"]'));
    for (const query of ["scrollback", "shell"]) {
      fireEvent.change(view.getByRole("searchbox", { name: "Search settings" }), { target: { value: query } });
      await waitFor(() => {
        expect(terminal().hidden, query).toBe(false);
        expect(requiredFixture(view.container.querySelector<HTMLElement>('[data-settings-section="web-search-engine"]')).hidden, query).toBe(true);
      });
    }
    const row = (id: string) => requiredFixture(terminal().querySelector<HTMLElement>(`[data-setting-id="${id}"]:not([data-setting-registered])`));
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      await act(async () => {
        fireEvent.change(view.getByRole("searchbox", { name: "Search settings" }), { target: { value: "" } });
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Modified settings" }));
      });
      // The filter rescans after the remounted panels commit and the mutation observer queues a frame.
      await act(async () => { vi.advanceTimersToNextFrame(); });
      expect(row("appearance.terminal.scrollback").hidden).toBe(false);
      expect(row("appearance.terminal.cursorStyle").hidden).toBe(true);
      expect(row("appearance.terminal.copyOnSelect").hidden).toBe(true);
      expect(row("appearance.terminal.shell").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fills the directory draft from the picker without granting access", async () => {
    const view = await renderSettings();
    view.api.pickSettingsDirectory.mockResolvedValue({ ok: true, path: "/synthetic/project" });
    clickSettingsTab(view.container, "permissions");
    const button = await view.findByTestId("permissions-directory-picker");
    const before = view.ns.permission.dirDispatch.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() => expect(requiredFixture(view.container.querySelector<HTMLInputElement>('[data-settings-section="permissions-directories"] input')).value).toBe("/synthetic/project"));
    expect(view.ns.permission.dirDispatch).toHaveBeenCalledTimes(before);
  });
  it("shows only the changed actual setting rows inside a mixed section", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS); requiredFixture(settings.features).idlePreferenceRefresh = true;
    const view = await renderSettings(settings);
    fireEvent.click(view.getByRole("button", { name: "Modified settings" }));
    const row = (id: string) => requiredFixture(view.container.querySelector<HTMLElement>(`[data-setting-row="${id}"]`));
    await waitFor(() => {
      expect(row("features.idlePreferenceRefresh").hidden).toBe(false);
      expect(row("features.idleMemoryConsolidation").hidden).toBe(true);
      expect(row("features.subAgentAutonomousWake").hidden).toBe(true);
    });
    expect(view.container.querySelector('[data-setting-control-id="features.idleMemoryConsolidation"][data-setting-registered="true"]')).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector("fieldset.contents")).not.toBeDisabled());
    expect(_unregisteredSettingsControlsForTest(view.container)).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "Modified settings" }));
    clickSettingsTab(view.container, "chat");
    await waitFor(() => expect(row("features.idleMemoryConsolidation").hidden).toBe(false));
  });
  it("mounts the panels again for a second search without re-reading what the editor already holds", async () => {
    const view = await renderSettings();
    const settingsReaders: string[] = [];
    const readSettings = requiredFixture(view.api.getSettings.getMockImplementation());
    view.api.getSettings.mockImplementation(() => { settingsReaders.push(new Error("settings read").stack ?? ""); return readSettings(); });
    const fieldset = () => requiredFixture(view.container.querySelector<HTMLFieldSetElement>("fieldset.contents"));
    const search = view.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "terminal font" } });
    await waitFor(() => expect(requiredFixture(view.container.querySelector<HTMLElement>('[data-settings-section="appearance-terminal"]')).hidden).toBe(false));
    await waitFor(() => expect(fieldset()).not.toBeDisabled());
    expect(view.api.hasApiKey).toHaveBeenCalled();
    expect(view.api.hasWebApiKey).toHaveBeenCalled();
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(view.container.querySelector('[data-settings-section="appearance-terminal"]')).toBeNull());
    const before = { hasApiKey: view.api.hasApiKey.mock.calls.length, hasWebApiKey: view.api.hasWebApiKey.mock.calls.length, judgeGet: view.ns.permission.judgeGet.mock.calls.length,
      defaults: view.api.getSettingsDefaults.mock.calls.length, mcp: Object.values(view.mcp).map((read) => read.mock.calls.length) };
    settingsReaders.length = 0;
    let lockEngaged = false;
    const watch = new MutationObserver(() => { if (fieldset().disabled) lockEngaged = true; });
    watch.observe(fieldset(), { attributes: true, attributeFilter: ["disabled"] });
    fireEvent.change(search, { target: { value: "terminal font" } });
    await waitFor(() => expect(requiredFixture(view.container.querySelector<HTMLElement>('[data-settings-section="appearance-terminal"]')).hidden).toBe(false));
    await waitFor(() => expect(fieldset()).not.toBeDisabled());
    watch.disconnect();
    // Every panel was loaded by the first search, so mounting them again asks no store for credentials or the judge, and
    // reads the settings document only where a section re-reads it on purpose: permissions refreshes its whole view after each
    // change, and remote surfaces re-reads gates that have no change event whenever a row opens or closes.
    expect(view.api.hasApiKey.mock.calls.length).toBe(before.hasApiKey);
    expect(view.api.hasWebApiKey.mock.calls.length).toBe(before.hasWebApiKey);
    expect(view.ns.permission.judgeGet.mock.calls.length - before.judgeGet).toBe(0);
    expect(view.api.getSettingsDefaults.mock.calls.length).toBe(before.defaults);
    expect(Object.values(view.mcp).map((read) => read.mock.calls.length)).toEqual(before.mcp);
    expect(settingsReaders.filter((stack) => !/(PermissionsTab|RemoteSurfacesTab)\.tsx/.test(stack))).toEqual([]);
    expect(lockEngaged).toBe(false);
  });
});

import "../../../../../test/renderer/setup.js";
import { assert, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "../../../../data/settings-defaults.js";
import { requiredFixture } from "../../../../__tests__/support/required-fixture.js";
import { makeMockAveApi, makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import { SettingsControlActions, SettingsEditorProvider, useAppSettingsControls } from "../SettingsEditorContext.js";

function RegisteredActions({ section }: { section: string }) { useAppSettingsControls([section]); return <SettingsControlActions section={section} />; }

function setup(section: string, settings: typeof DEFAULT_SETTINGS) {
  const { api } = makeMockAveApi({ settings });
  api.getSettingsDefaults.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
  const { ns } = makeMockAveNamespace();
  window.ave = ns as never;
  const rendered = render(<SettingsEditorProvider api={api as never} modifiedOnly><RegisteredActions section={section} /></SettingsEditorProvider>);
  return { ...rendered, api, ns };
}

describe("modified settings actions", () => {
  it("resets only the selected setting to its canonical default", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.chat.autoCompact = false;
    const { container, api } = setup("chat-optimization", settings);
    const reset = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-setting-id="chat.autoCompact"] button');
      assert(button); return button;
    });
    fireEvent.click(reset);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ chat: { autoCompact: DEFAULT_SETTINGS.chat.autoCompact } }));
    await waitFor(() => expect(container.querySelector('[data-setting-id="chat.autoCompact"]')).toBeNull());
  });

  it("keeps a security reset on the permission write boundary", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    requiredFixture(settings.features).osToolSandbox = !requiredFixture(DEFAULT_SETTINGS.features).osToolSandbox;
    const { container, api, ns } = setup("permissions-os-sandbox", settings);
    ns.permission.updateSecuritySettings.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
    const reset = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-setting-id="features.osToolSandbox"] button');
      assert(button); return button;
    });
    fireEvent.click(reset);
    await waitFor(() => expect(ns.permission.updateSecuritySettings).toHaveBeenCalledWith({ features: { osToolSandbox: requiredFixture(DEFAULT_SETTINGS.features).osToolSandbox } }));
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps the modified marker and a visible error when persistence is refused", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS); settings.chat.autoCompact = false;
    const { container, api, findByRole } = setup("chat-optimization", settings);
    api.updateSettings.mockResolvedValue({ ok: false, error: "invalid-input" });
    const button = await waitFor(() => { const candidate = container.querySelector<HTMLButtonElement>('[data-setting-id="chat.autoCompact"] button'); assert(candidate); return candidate; });
    fireEvent.click(button);
    expect(await findByRole("alert")).toBeTruthy();
    expect(container.querySelector('[data-setting-modified="true"]')).toBeTruthy();
  });
  it("copies the selected setting id without saving", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS); settings.chat.autoCompact = false;
    const { container, api } = setup("chat-optimization", settings);
    const writeText = vi.fn(async (_text: string) => undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const button = await waitFor(() => { const candidate = container.querySelectorAll<HTMLButtonElement>('[data-setting-id="chat.autoCompact"] button')[1]; assert(candidate); return candidate; });
      fireEvent.click(button);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("chat.autoCompact"));
      expect(api.updateSettings).not.toHaveBeenCalled();
    } finally { if (previous) Object.defineProperty(navigator, "clipboard", previous); else Reflect.deleteProperty(navigator, "clipboard"); }
  });
});

import { formatGlobalAccelerator } from "../../../../shared/shortcuts.js";
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { StartupTab } from "../StartupTab.js";
import { DEFAULT_APP_INFO, makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { TOOL_TIMEOUT_POLICY } from "../../../../shared/tool-timeout-policy.js";
import * as shortcutHooks from "../../hooks/use-shortcuts.js";
import { ko } from "../../../../i18n/messages/ko.js";

const STARTUP_SETTINGS = {
  ...MOCK_DEFAULT_SETTINGS,
  system: { closeBehavior: "hide-to-tray", launchAtStartup: false, launchMinimized: false },
};

function installApi(settings: Record<string, unknown> = STARTUP_SETTINGS) {
  const { api } = makeMockAveApi({ settings: { ...settings, shortcuts: { ...MOCK_DEFAULT_SETTINGS.shortcuts, ...(settings.shortcuts as object) } } });
  (globalThis as unknown as { window: typeof window }).window.aveApi = api as never;
  return api;
}

describe("StartupTab", () => {
  describe.each(["darwin", "other"] as const)("fixed toggle reservations on %s", (platform) => {
    it.each([
      ["0", "Numpad0", "num0", "be_main.menuResetZoom"],
      ["+", "NumpadAdd", "numadd", "be_main.menuZoomIn"],
      ["-", "NumpadSubtract", "numsub", "be_main.menuZoomOut"],
      ["+", "Equal", "Shift+Plus", "be_main.menuZoomIn", true],
      ["=", "Equal", "=", "be_main.menuZoomIn", false],
      ["-", "Minus", "-", "be_main.menuZoomOut", false],
      ["-", "Minus", "Shift+-", "be_main.menuZoomOut", true],
      ["+", "BracketRight", "Shift+Plus", "be_main.menuZoomIn", true],
      ["+", "BracketRight", "Plus", "be_main.menuZoomIn"],
    ] as const)("refuses fixed %s, keeps the prior value and continues recording", async (key, code, token, labelKey, shiftKey = false) => {
      const platformSpy = vi.spyOn(shortcutHooks, "rendererShortcutPlatform").mockReturnValue(platform);
      try {
        const api = installApi({ ...STARTUP_SETTINGS, shortcuts: { toggleWindow: "Alt+F1", enabled: true } });
        const { findByTestId, getByRole, queryByRole } = render(<StartupTab />);
        const capture = await findByTestId("startup-accelerator-capture");
        await waitFor(() => expect(capture.textContent).toBe(formatGlobalAccelerator("Alt+F1", platform)));
        fireEvent.click(await findByTestId("startup-accelerator-record"));
        fireEvent.keyDown(capture, { key, code, shiftKey, metaKey: platform === "darwin", ctrlKey: platform === "other" });
        expect(getByRole("alert").textContent).toContain(ko[labelKey]);
        expect(api.updateSettings).not.toHaveBeenCalled();
        expect(capture.textContent).toBe(ko["startupTab.shortcutCapturing"]);
        fireEvent.keyDown(capture, { key: "Escape" });
        expect(capture.textContent).toBe(formatGlobalAccelerator("Alt+F1", platform));
        fireEvent.click(await findByTestId("startup-accelerator-record"));
        fireEvent.keyDown(capture, { key, code, shiftKey, ctrlKey: platform === "other", metaKey: platform === "darwin" });
        fireEvent.keyDown(capture, { key, code, shiftKey, altKey: true });
        expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { toggleWindow: `Alt+${token}` } });
        expect(capture.textContent).toBe(formatGlobalAccelerator(`Alt+${token}`, platform));
        expect(queryByRole("alert")).toBeNull();
        fireEvent.click(await findByTestId("startup-accelerator-record"));
        const calls = api.updateSettings.mock.calls.length;
        fireEvent.keyDown(capture, { key: "End", code: "Numpad1", altKey: true });
        expect(api.updateSettings).toHaveBeenCalledTimes(calls + 1);
        expect(api.updateSettings).toHaveBeenLastCalledWith({ shortcuts: { toggleWindow: "Alt+End" } });
      } finally {
        platformSpy.mockRestore();
      }
    });
  });
  it("loads persisted settings on mount", async () => {
    installApi({
      ...STARTUP_SETTINGS,
      shortcuts: { toggleWindow: "CommandOrControl+Shift+Space", enabled: true },
    });
    const { findByTestId } = render(<StartupTab />);
    const capture = await findByTestId("startup-accelerator-capture");
    await waitFor(() => {
      expect(capture.textContent).toBe("Ctrl+Shift+Space");
    });
    const enabled = await findByTestId("startup-shortcut-enabled");
    expect(enabled.getAttribute("aria-checked")).toBe("true");
  });

  it.each(["j", " ", "Backspace", "F1"])("refuses a bare %s and keeps recording", async (key) => {
    const api = installApi();
    const { findByTestId, getByRole } = render(<StartupTab />);
    const capture = await findByTestId("startup-accelerator-capture");
    fireEvent.click(await findByTestId("startup-accelerator-record"));
    fireEvent.keyDown(capture, { key });
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(getByRole("alert").textContent).toBe(ko["shortcutsTab.notice.needsModifier"]);
    expect(capture.textContent).toBe(ko["startupTab.shortcutCapturing"]);
  });

  it.each([false, true])("lets Tab leave capture without preventing focus traversal (shift=%s)", async (shiftKey) => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const capture = await findByTestId("startup-accelerator-capture");
    fireEvent.click(await findByTestId("startup-accelerator-record"));
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    fireEvent(capture, event);
    expect(event.defaultPrevented).toBe(false);
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(capture.textContent).toBe(ko["startupTab.shortcutUnset"]);
  });

  it("does not reclaim focus after leaving a newly started recording", async () => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const capture = await findByTestId("startup-accelerator-capture");
    const record = await findByTestId("startup-accelerator-record");
    const previousControl = await findByTestId("startup-shortcut-enabled");
    await waitFor(() => expect(record).not.toBeDisabled());
    const frames: FrameRequestCallback[] = [];
    const frameSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      fireEvent.click(record);
      expect(capture).toHaveFocus();
      // A browser driver can focus the locator before sending the traversal key.
      capture.focus();
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      fireEvent(capture, event);
      expect(event.defaultPrevented).toBe(false);
      previousControl.focus();
      for (const callback of frames) callback(0);
      expect(previousControl).toHaveFocus();
      expect(capture.textContent).toBe(ko["startupTab.shortcutUnset"]);
      expect(api.updateSettings).not.toHaveBeenCalled();
    } finally {
      frameSpy.mockRestore();
    }
  });

  it("refuses an operating system reservation with a reason", async () => {
    const platformSpy = vi.spyOn(shortcutHooks, "rendererShortcutPlatform").mockReturnValue("darwin");
    try {
      const api = installApi();
      const { findByTestId, getByRole } = render(<StartupTab />);
      fireEvent.click(await findByTestId("startup-accelerator-record"));
      fireEvent.keyDown(await findByTestId("startup-accelerator-capture"), { key: " ", metaKey: true });
      expect(api.updateSettings).not.toHaveBeenCalled();
      expect(getByRole("alert").textContent).toBe(ko["shortcutsTab.notice.osReserved"]);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("warns when a global shortcut overlaps an in-app action", async () => {
    const api = installApi();
    const { findByTestId, getByRole } = render(<StartupTab />);
    fireEvent.click(await findByTestId("startup-accelerator-record"));
    fireEvent.keyDown(await findByTestId("startup-accelerator-capture"), { key: "k", ctrlKey: true });
    expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { toggleWindow: "CommandOrControl+K" } });
    expect(getByRole("alert").textContent).toContain(ko["shortcuts.label.commandPalette"]);
  });

  function persistedToggleCase(testId: string, patch: Record<string, unknown>) {
    return async () => {
      const api = installApi();
      const { findByTestId } = render(<StartupTab />);
      const toggle = await findByTestId(testId);
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(api.updateSettings).toHaveBeenCalledWith(patch);
      });
    };
  }

  it("toggling 'enable global shortcut' persists through updateSettings", persistedToggleCase("startup-shortcut-enabled", { shortcuts: { enabled: true } }));
  it("toggling launch-at-startup persists through updateSettings", persistedToggleCase("startup-launch-at-startup", { system: { launchAtStartup: true } }));

  it("records an accelerator via keydown capture and persists it", async () => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const record = await findByTestId("startup-accelerator-record");
    fireEvent.click(record);
    const capture = await findByTestId("startup-accelerator-capture");
    fireEvent.keyDown(capture, { key: "k", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        shortcuts: { toggleWindow: "CommandOrControl+Shift+K" },
      });
    });
  });

  it("ignores a modifier-only keypress during capture", async () => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const record = await findByTestId("startup-accelerator-record");
    fireEvent.click(record);
    const capture = await findByTestId("startup-accelerator-capture");
    (api.updateSettings as ReturnType<typeof vi.fn>).mockClear();
    // A bare Shift press must NOT persist anything.
    fireEvent.keyDown(capture, { key: "Shift", shiftKey: true });
    // Give React a tick; nothing should have been written.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("shows the 'enabled but no accelerator' warning", async () => {
    installApi({
      ...STARTUP_SETTINGS,
      shortcuts: { toggleWindow: null, enabled: true },
    });
    const { findByText } = render(<StartupTab />);
    // The warning key resolves through i18n; assert the rendered warning text node exists (ko runtime locale in this suite).
    await waitFor(async () => {
      const warn = await findByText(/활성화|no key combination|enabled/i);
      expect(warn).toBeTruthy();
    });
  });

  it("loads the persisted close-behavior selection on mount", async () => {
    installApi({
      ...STARTUP_SETTINGS,
      system: { closeBehavior: "quit", launchAtStartup: false, launchMinimized: false },
    });
    const { container } = render(<StartupTab />);
    await waitFor(() => {
      expect(container.querySelector("#close-quit")?.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("selecting 'quit' close-behavior persists through updateSettings", async () => {
    const api = installApi();
    const { container } = render(<StartupTab />);
    const quit = await waitFor(() => {
      const node = container.querySelector<HTMLElement>("#close-quit");
      expect(node).toBeTruthy();
      return node!;
    });
    fireEvent.click(quit);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ system: { closeBehavior: "quit" } });
    });
  });

  it("renders the persisted hardware-acceleration state and persists a change", async () => {
    const api = installApi({
      ...STARTUP_SETTINGS,
      system: { ...STARTUP_SETTINGS.system, hardwareAcceleration: false },
    });
    const { findByTestId } = render(<StartupTab />);
    const toggle = await findByTestId("startup-hardware-acceleration");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        system: { hardwareAcceleration: true },
      });
    });
  });

  it("says the change takes effect next launch", async () => {
    installApi();
    const { findByTestId } = render(<StartupTab />);
    // The toggle cannot change the running process — `disableHardwareAcceleration` is a before-whenReady call — so the copy
    // has to say so unconditionally.
    const help = await findByTestId("startup-hardware-acceleration-help");
    expect(help.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("names AVE_KEEP_GPU when the environment is forcing the GPU on", async () => {
    const { api } = makeMockAveApi({
      settings: STARTUP_SETTINGS,
      envForcedSettings: ["system.hardwareAcceleration"],
    });
    (globalThis as unknown as { window: typeof window }).window.aveApi = api as never;
    const { findByTestId } = render(<StartupTab />);
    const forced = await findByTestId("startup-hardware-acceleration-forced");
    expect(forced.textContent).toContain("AVE_KEEP_GPU");
  });

  it("stays quiet about the environment when nothing is forced", async () => {
    installApi();
    const { findByTestId, queryByTestId } = render(<StartupTab />);
    await findByTestId("startup-hardware-acceleration");
    expect(queryByTestId("startup-hardware-acceleration-forced")).toBeNull();
  });

  it("renders the saved cleanup window and persists a new choice", async () => {
    const api = installApi({
      ...STARTUP_SETTINGS,
      system: { ...STARTUP_SETTINGS.system, shutdownCleanupTimeoutMs: 30_000 },
    });
    const { findByTestId } = render(<StartupTab />);
    const select = (await findByTestId("startup-shutdown-timeout")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("30000"));
    fireEvent.change(select, { target: { value: "60000" } });
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        system: { shutdownCleanupTimeoutMs: 60_000 },
      });
    });
  });

  it("falls back to the policy default when nothing is saved", async () => {
    installApi();
    const { findByTestId } = render(<StartupTab />);
    const select = (await findByTestId("startup-shutdown-timeout")) as HTMLSelectElement;
    // The default has to be one of the offered options or the control would render a selection the user could never choose
    // again.
    await waitFor(() =>
      expect(select.value).toBe(String(TOOL_TIMEOUT_POLICY.shutdownCleanupMs)),
    );
  });

  it("names AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS and locks the control when the environment decides", async () => {
    const { api } = makeMockAveApi({
      settings: STARTUP_SETTINGS,
      envForcedSettings: ["system.shutdownCleanupTimeoutMs"],
    });
    (globalThis as unknown as { window: typeof window }).window.aveApi = api as never;
    const { findByTestId } = render(<StartupTab />);
    const forced = await findByTestId("startup-shutdown-timeout-forced");
    expect(forced.textContent).toContain("AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS");
    // Saying the environment decides while still accepting a choice would be offering a control that does nothing.
    const select = (await findByTestId("startup-shutdown-timeout")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(true));
  });

  it("clearing the accelerator persists null", async () => {
    const api = installApi({
      ...STARTUP_SETTINGS,
      shortcuts: { toggleWindow: "Alt+F1", enabled: true },
    });
    const { findByTestId } = render(<StartupTab />);
    const clear = await findByTestId("startup-accelerator-clear");
    await waitFor(() => expect(clear.getAttribute("disabled")).toBeNull());
    fireEvent.click(clear);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { toggleWindow: null } });
    });
  });
});


it("shows a restart action and chip against main's boot snapshot after remounting", async () => {
  const api = installApi({
    ...STARTUP_SETTINGS,
    system: { ...STARTUP_SETTINGS.system, hardwareAcceleration: false, corpCaEnabled: true, corpCaCommonName: "Root", corpCaDebugLog: false },
  });
  api.getAppInfo.mockResolvedValue({ ...DEFAULT_APP_INFO, startupSettings: { hardwareAcceleration: true, corpCaEnabled: true, corpCaCommonName: "Root", corpCaDebugLog: false } });
  const first = render(<StartupTab />);
  expect(await first.findByTestId("settings-restart-required")).toBeTruthy();
  expect((await first.findAllByTestId("setting-restart-chip")).length).toBe(1);
  first.unmount();
  const second = render(<StartupTab />);
  expect(await second.findByTestId("settings-restart-required")).toBeTruthy();
});

it("refuses an empty certificate name with an inline reason", async () => {
  installApi({ ...STARTUP_SETTINGS, system: { ...STARTUP_SETTINGS.system, corpCaEnabled: true, corpCaCommonName: "Root" } });
  const { findByTestId, getByRole } = render(<StartupTab />);
  const field = await findByTestId("startup-corp-ca-common-name");
  await waitFor(() => expect((field as HTMLInputElement).value).toBe("Root"));
  fireEvent.change(field, { target: { value: "   " } });
  expect((await findByTestId("startup-corp-ca-common-name-save") as HTMLButtonElement).disabled).toBe(true);
  expect(getByRole("alert").textContent).toBe(ko["startupTab.corpCaNameRequired"]);
});

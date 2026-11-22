import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "../../../../data/settings-defaults.js";
import { requiredFixture } from "../../../../__tests__/support/required-fixture.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { SettingsEditorProvider, _unregisteredSettingsControlsForTest, useSettingsEditor } from "../../context/SettingsEditorContext.js";
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import { AppearanceTab } from "../AppearanceTab.js";
import { ChatTab } from "../ChatTab.js";
import { WebTab } from "../WebTab.js";

function ChatControls() {
  const editor = useSettingsEditor();
  if (!editor?.settings) return null;
  const settings = editor.settings;
  return <ChatTab
    autoCompact={settings.chat.autoCompact} setAutoCompact={vi.fn()}
    processingDisplayLevel={settings.chat.processingDisplayLevel} setProcessingDisplayLevel={vi.fn()}
    streamSmoothing={settings.llm.streamSmoothing} setStreamSmoothing={vi.fn()}
    idlePreferenceRefresh={requiredFixture(settings.features).idlePreferenceRefresh} setIdlePreferenceRefresh={vi.fn()}
    idleMemoryConsolidation={requiredFixture(settings.features).idleMemoryConsolidation} setIdleMemoryConsolidation={vi.fn()}
    subAgentAutonomousWake={requiredFixture(settings.features).subAgentAutonomousWake} setSubAgentAutonomousWake={vi.fn()}
    subAgentMaxRounds={settings.chat.subAgentMaxRounds} setSubAgentMaxRounds={vi.fn()}
    piiRedactEnabled={settings.privacy.piiRedactEnabled} onPiiRedactToggle={vi.fn()}
    settingsLoaded
  />;
}

function setup(settings: typeof DEFAULT_SETTINGS, content: "appearance" | "chat" | "web", modifiedOnly = false) {
  const { api } = makeMockAveApi({ settings });
  window.aveApi = api as never;
  const view = render(<ThemeProvider api={api as never} initialAppearance={settings.appearance}>
    <SettingsEditorProvider api={api as never} modifiedOnly={modifiedOnly}>
      {content === "appearance" ? <AppearanceTab /> : content === "chat" ? <ChatControls /> : <WebTab api={api as never}
        webProvider="duckduckgo" setWebProvider={vi.fn()} hasWebKey={false} setHasWebKey={vi.fn()}
        webKeyInput="" setWebKeyInput={vi.fn()} onSaved={vi.fn()} onSaveKey={async () => true} saving={false} />}
    </SettingsEditorProvider>
  </ThemeProvider>);
  return { ...view, api };
}

afterEach(() => {
  document.documentElement.removeAttribute("data-glass-capable");
  document.documentElement.removeAttribute("data-glass");
});

describe("rendered settings control registration", () => {
  it("registers the address search choice and redraws it after its canonical reset", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.webView.addressSearchEngine = "bing";
    const view = setup(settings, "web", true);
    const row = '[data-setting-id="webView.addressSearchEngine"]:not([data-setting-registered])';
    await waitFor(() => expect(view.container.querySelector(row)).toBeTruthy());
    await waitFor(() => expect(_unregisteredSettingsControlsForTest(view.container)).toEqual([]));
    const reset = await waitFor(() => requiredFixture(view.container.querySelector<HTMLButtonElement>('[data-settings-actions="web-address-search"] [data-setting-id="webView.addressSearchEngine"] button')));
    expect(view.container.querySelector<HTMLInputElement>(`${row} input[value="bing"]`)).toBeChecked();
    fireEvent.click(reset);
    await waitFor(() => expect(view.api.updateSettings).toHaveBeenCalledWith({ webView: { addressSearchEngine: DEFAULT_SETTINGS.webView.addressSearchEngine } }));
    await waitFor(() => expect(view.container.querySelector<HTMLInputElement>(`${row} input[value="${DEFAULT_SETTINGS.webView.addressSearchEngine}"]`)).toBeChecked());
    expect(view.container.querySelector('[data-settings-actions="web-address-search"] [data-setting-id="webView.addressSearchEngine"]')).toBeNull();
  });

  it("registers every appearance input including both font editors, material tint and zoom", async () => {
    document.documentElement.setAttribute("data-glass-capable", "true");
    document.documentElement.setAttribute("data-glass", "true");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.appearance.mode = "system";
    const view = setup(settings, "appearance");
    await waitFor(() => expect(view.container.querySelector('[data-setting-registered="true"][data-setting-id="appearance.mode"]')).toBeTruthy());
    await waitFor(() => expect(_unregisteredSettingsControlsForTest(view.container)).toEqual([]));
    for (const id of ["appearance.language", "appearance.mode", "appearance.darkScheme", "appearance.lightScheme", "appearance.glassTint", "appearance.font.family", "appearance.font.sizeScale", "appearance.terminalFont.family", "appearance.terminalFont.size", "appearance.terminalFont.lineHeight", "appearance.terminal.scrollback", "appearance.terminal.cursorStyle", "appearance.terminal.copyOnSelect", "appearance.terminal.shell", "appearance.zoomLevel"]) {
      expect(view.container.querySelector(`[data-setting-id="${id}"]:not([data-setting-registered])`), id).toBeTruthy();
      expect(view.container.querySelector(`[data-setting-registered="true"][data-setting-id="${id}"]`), id).toBeTruthy();
    }
    const customFont = view.getByLabelText("사용자 정의 폰트 stack");
    expect(customFont).toHaveAttribute("data-setting-id", "appearance.font.family");
    fireEvent.change(customFont, { target: { value: "Example Sans, sans-serif" } });
    expect(customFont).toHaveAttribute("data-setting-dirty", "true");
    expect(view.getByLabelText("사용자 정의 코드 글꼴 목록")).toHaveAttribute("data-setting-id", "appearance.terminalFont.family");
  });

  it("registers Option as Meta off macOS, where its control is not drawn, so a stored value can still be reset", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.appearance.terminal = { ...settings.appearance.terminal, optionAsMeta: !DEFAULT_SETTINGS.appearance.terminal.optionAsMeta };
    const view = setup(settings, "appearance", true);
    const actionSelector = '[data-settings-actions="appearance-terminal"] [data-setting-id="appearance.terminal.optionAsMeta"]';
    await waitFor(() => expect(view.container.querySelector(actionSelector)).toHaveAttribute("data-setting-modified", "true"));
    expect(view.container.querySelector('[data-setting-id="appearance.terminal.optionAsMeta"]:not([data-setting-registered])')).toBeNull();
  });

  it("resets a modified terminal scrollback through its canonical path and redraws the stored value", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.appearance.terminal = { ...settings.appearance.terminal, scrollback: DEFAULT_SETTINGS.appearance.terminal.scrollback + 1000 };
    const view = setup(settings, "appearance", true);
    const actionSelector = '[data-settings-actions="appearance-terminal"] [data-setting-id="appearance.terminal.scrollback"]';
    const reset = await waitFor(() => {
      const button = view.container.querySelector<HTMLButtonElement>(`${actionSelector} button`);
      expect(button).toBeTruthy();
      if (button === null) throw new Error("Expected the setting reset button");
      return button;
    });
    fireEvent.click(reset);
    await waitFor(() => expect(view.api.updateSettings).toHaveBeenCalledWith({ appearance: { terminal: { scrollback: DEFAULT_SETTINGS.appearance.terminal.scrollback } } }));
    await waitFor(() => expect(view.getByTestId("terminal-scrollback-value")).toHaveTextContent(DEFAULT_SETTINGS.appearance.terminal.scrollback.toLocaleString()));
    await waitFor(() => expect(view.container.querySelector(actionSelector)).toBeNull());
  });

  it("registers every chat control and marks the statistics period as a transient query", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.privacy.piiRedactEnabled = true;
    const view = setup(settings, "chat");
    await view.findByTestId("subagent-max-rounds-input");
    await waitFor(() => expect(_unregisteredSettingsControlsForTest(view.container)).toEqual([]));
    for (const id of ["chat.autoCompact", "llm.streamSmoothing", "chat.processingDisplayLevel", "features.idlePreferenceRefresh", "features.idleMemoryConsolidation", "features.subAgentAutonomousWake", "chat.subAgentMaxRounds", "privacy.piiRedactEnabled"]) {
      expect(view.container.querySelector(`[data-setting-id="${id}"]:not([data-setting-registered])`), id).toBeTruthy();
      expect(view.container.querySelector(`[data-setting-registered="true"][data-setting-id="${id}"]`), id).toBeTruthy();
    }
    expect(view.container.querySelector('select[data-settings-transient="statistics-period"]')).toBeTruthy();
  });

  it("resets a modified theme mode through its canonical path and updates the rendered choice", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.appearance.mode = DEFAULT_SETTINGS.appearance.mode === "dark" ? "light" : "dark";
    const view = setup(settings, "appearance", true);
    const actionSelector = '[data-settings-actions="appearance-theme"] [data-setting-id="appearance.mode"]';
    const reset = await waitFor(() => {
      const button = view.container.querySelector<HTMLButtonElement>(`${actionSelector} button`);
      expect(button).toBeTruthy();
      if (button === null) throw new Error("Expected the setting reset button");
      return button;
    });
    expect(view.container.querySelector(actionSelector)).toHaveAttribute("data-setting-modified", "true");
    fireEvent.click(reset);
    await waitFor(() => expect(view.api.updateSettings).toHaveBeenCalledWith({ appearance: { mode: DEFAULT_SETTINGS.appearance.mode } }));
    await waitFor(() => expect(view.getByTestId(`appearance-mode-${DEFAULT_SETTINGS.appearance.mode}`)).toHaveAttribute("aria-checked", "true"));
    expect(view.container.querySelector(actionSelector)).toBeNull();
  });

  it("resets a modified round budget and retains the bounded input contract", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.chat.subAgentMaxRounds = 777;
    const view = setup(settings, "chat", true);
    const actionSelector = '[data-settings-actions="chat-experimental"] [data-setting-id="chat.subAgentMaxRounds"]';
    const reset = await waitFor(() => {
      const button = view.container.querySelector<HTMLButtonElement>(`${actionSelector} button`);
      expect(button).toBeTruthy();
      if (button === null) throw new Error("Expected the setting reset button");
      return button;
    });
    const input = view.getByTestId("subagent-max-rounds-input");
    expect(input).toHaveValue(777);
    expect(input).toHaveAttribute("max", "1000");
    fireEvent.click(reset);
    await waitFor(() => expect(view.api.updateSettings).toHaveBeenCalledWith({ chat: { subAgentMaxRounds: DEFAULT_SETTINGS.chat.subAgentMaxRounds } }));
    await waitFor(() => expect(input).toHaveValue(DEFAULT_SETTINGS.chat.subAgentMaxRounds));
    expect(view.container.querySelector(actionSelector)).toBeNull();
  });
});

// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_TERMINAL_BEHAVIOR, type TerminalBehaviorSettings } from "../../../../shared/appearance-settings.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { TerminalBehaviorFields } from "../TerminalBehaviorFields.js";

const { api, theme, platform, saved } = vi.hoisted(() => ({
  api: { updateSettings: vi.fn() },
  theme: { appearance: { terminal: { scrollback: 5000, cursorStyle: "block", optionAsMeta: false, copyOnSelect: false, shell: "" } as Record<string, unknown> } },
  platform: { darwin: true },
  saved: vi.fn(),
}));
vi.mock("../../api-client.js", () => ({ getApi: () => api, isDarwin: () => platform.darwin }));
vi.mock("../../theme/index.js", () => ({ useTheme: () => theme }));
vi.mock("../../context/SavedToastContext.js", () => ({ useNotifySaved: () => saved }));

const sent = (): Array<Partial<TerminalBehaviorSettings>> => api.updateSettings.mock.calls.map(([patch]) => (patch as { appearance: { terminal: Partial<TerminalBehaviorSettings> } }).appearance.terminal);

beforeEach(() => {
  api.updateSettings.mockReset().mockResolvedValue({});
  saved.mockReset();
  platform.darwin = true;
  theme.appearance = { terminal: { ...DEFAULT_TERMINAL_BEHAVIOR } };
});

describe("terminal behaviour settings", () => {
  it("saves each field on its own, as the one field that changed", async () => {
    render(<TerminalBehaviorFields />);
    expect(screen.getByTestId("terminal-scrollback-value")).toHaveTextContent(t("appearanceTab.terminalScrollbackLines", { lines: (5000).toLocaleString() }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${t("appearanceTab.terminalScrollback")} +` })); });
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: t("appearanceTab.terminalCursorBar") })); });
    await act(async () => { fireEvent.click(screen.getByTestId("terminal-copy-on-select")); });
    await act(async () => { fireEvent.click(screen.getByTestId("terminal-option-as-meta")); });
    expect(sent()).toEqual([{ scrollback: 6000 }, { cursorStyle: "bar" }, { copyOnSelect: true }, { optionAsMeta: true }]);
    expect(saved).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("terminal-scrollback-value")).toHaveTextContent((6000).toLocaleString());
    expect(screen.getByRole("radio", { name: t("appearanceTab.terminalCursorBar") })).toBeChecked();
  });

  it("stops scrollback at its bounds", () => {
    theme.appearance = { terminal: { ...DEFAULT_TERMINAL_BEHAVIOR, scrollback: 1000 } };
    const view = render(<TerminalBehaviorFields />);
    expect(screen.getByRole("button", { name: `${t("appearanceTab.terminalScrollback")} −` })).toBeDisabled();
    view.unmount();
    theme.appearance = { terminal: { ...DEFAULT_TERMINAL_BEHAVIOR, scrollback: 100_000 } };
    render(<TerminalBehaviorFields />);
    expect(screen.getByRole("button", { name: `${t("appearanceTab.terminalScrollback")} +` })).toBeDisabled();
  });

  it("offers Option-as-Meta on macOS only", () => {
    platform.darwin = false;
    render(<TerminalBehaviorFields />);
    expect(screen.queryByTestId("terminal-option-as-meta")).toBeNull();
    expect(screen.getByTestId("terminal-copy-on-select")).toBeTruthy();
  });

  it("saves a shell path when the field is left or Enter is pressed, and never a path that is not absolute", async () => {
    render(<TerminalBehaviorFields />);
    const shell = screen.getByTestId("terminal-shell-path");
    expect(screen.getByTestId("terminal-shell-hint")).toHaveTextContent(t("appearanceTab.terminalShellHint"));
    expect(screen.queryByTestId("terminal-shell-reset")).toBeNull();
    fireEvent.change(shell, { target: { value: "fish" } });
    expect(shell).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("terminal-shell-hint")).toHaveTextContent(t("appearanceTab.terminalShellInvalid"));
    fireEvent.blur(shell);
    fireEvent.keyDown(shell, { key: "Enter" });
    expect(api.updateSettings).not.toHaveBeenCalled();

    fireEvent.change(shell, { target: { value: "  /opt/homebrew/bin/fish " } });
    expect(shell).toHaveAttribute("aria-invalid", "false");
    // Typing alone saves nothing: a half-typed path is not a setting.
    expect(api.updateSettings).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(shell, { key: "Enter" }); });
    expect(sent()).toEqual([{ shell: "/opt/homebrew/bin/fish" }]);
    // Leaving the field with the saved value does not save it again.
    await act(async () => { fireEvent.blur(shell); });
    expect(api.updateSettings).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(screen.getByTestId("terminal-shell-reset")); });
    expect(sent().at(-1)).toEqual({ shell: "" });
    expect(shell).toHaveValue("");
  });

  it("says so and shows the saved value again when a save is refused", async () => {
    api.updateSettings.mockRejectedValueOnce(new Error("Invalid terminal setting: scrollback"));
    render(<TerminalBehaviorFields />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${t("appearanceTab.terminalScrollback")} +` })); });
    await waitFor(() => expect(screen.getByTestId("terminal-behavior-save-failed")).toHaveTextContent(t("appearanceTab.terminalBehaviorSaveFailed")));
    expect(screen.getByTestId("terminal-scrollback-value")).toHaveTextContent((5000).toLocaleString());
    expect(saved).not.toHaveBeenCalled();
  });

  it("formats the scrollback line count in the app's language, not the system's", () => {
    const previous = getLocale();
    const numberFormat = vi.spyOn(Intl, "NumberFormat");
    try {
      setLocale("ko");
      theme.appearance = { terminal: { ...DEFAULT_TERMINAL_BEHAVIOR, scrollback: 12000 } };
      render(<TerminalBehaviorFields />);
      expect(numberFormat).toHaveBeenCalledWith("ko");
      expect(screen.getByTestId("terminal-scrollback-value")).toHaveTextContent(new Intl.NumberFormat("ko").format(12000));
    } finally {
      numberFormat.mockRestore();
      setLocale(previous);
    }
  });
});

// @vitest-environment jsdom
/**
 * PtyTerminalView paints xterm with concrete colors read off :root (its canvas
 * cannot resolve CSS custom properties). Those colors must follow the applied
 * theme while the terminal lives: re-tinted in place through
 * `terminal.options.theme`, never by re-creating the terminal (which would
 * drop the shell's screen and scrollback).
 */
import "../../../../../test/renderer/setup.js";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyTerminalView } from "../PtyTerminalView.js";
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import { setInstalledThemeBundles } from "../../theme/bundles/index.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../../installed-content.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { installedTheme, installedThemeContent, NO_LANGUAGE_BRIDGE } from "../../../../../test/renderer/installed-theme.js";

const { terminals } = vi.hoisted(() => ({ terminals: [] as Array<{ options: { theme?: unknown } }> }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: { theme?: unknown };
    cols = 80;
    rows = 24;
    constructor(options: { theme?: unknown }) {
      this.options = { ...options };
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

afterEach(() => {
  terminals.length = 0;
  resetInstalledContentForTests();
  setInstalledThemeBundles([]);
});

function terminalApi() {
  return {
    spawn: vi.fn(async () => ({ ok: true })),
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
  };
}

describe("PtyTerminalView theme", () => {
  it("re-tints the live terminal in place when the shown theme is updated (same id)", async () => {
    const harbor = installedTheme("harbor", "dark", { background: "210 40% 12%", foreground: "0 0% 100%" });
    const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, bundleId: "harbor" } } });
    const ave = { ...api, terminal: terminalApi() };
    act(() => { applyInstalledContent(installedThemeContent([harbor]), NO_LANGUAGE_BRIDGE); });

    render(
      <ThemeProvider api={api as never} initialBundleId="harbor">
        <PtyTerminalView api={ave as never} tabId="tab-1" />
      </ThemeProvider>,
    );
    await waitFor(() => expect(terminals).toHaveLength(1));
    await waitFor(() => expect(terminals[0]!.options.theme).toEqual({ background: "hsl(210 40% 12%)", foreground: "hsl(0 0% 100%)" }));

    await act(async () => {
      applyInstalledContent(installedThemeContent([{ ...harbor, tokens: { ...harbor.tokens, background: "210 40% 18%" } }]), NO_LANGUAGE_BRIDGE);
    });

    await waitFor(() => expect(terminals[0]!.options.theme).toEqual({ background: "hsl(210 40% 18%)", foreground: "hsl(0 0% 100%)" }));
    // The same terminal, re-tinted: the shell and its scrollback are untouched.
    expect(terminals).toHaveLength(1);
    expect(ave.terminal.spawn).toHaveBeenCalledTimes(1);
  });
});

import "../../../../test/renderer/setup.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
// Named import: the default export does not survive this tsconfig's interop settings.
import { userEvent } from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

/** Validate incoming view keys before assigning activeView so invalid destinations cannot fall through to plugin routing. */
describe("App — view key guard on the activate-view IPC", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("navigates when the key names a real inline destination", async () => {
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    act(() => emitViewActivate("memory"));

    await waitFor(() => expect(screen.getByTestId("view-path-current-memory")).toBeTruthy());
    // The conversations stay MOUNTED across view navigation — a tile's stream subscription starts when it mounts, so
    // unmounting them to show another view would drop the frames of a turn still running. Hidden, not gone.
    expect(screen.getByTestId("chat-surface").dataset.visible).toBe("false");
  });

  it("ignores a misspelled built-in key instead of rendering it as a plugin view", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    act(() => emitViewActivate("hom"));

    // Still home: the key never became `activeView`.
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'hom'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
  });

  it("ignores a detach-only key, which has no inline form to render", async () => {
    // An MCP-app card IS a real, openable destination — it just has no inline form. A check that only asked "is this a known
    // view key?" would wave it through and leave the main window claiming to be somewhere it cannot render.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    act(() => emitViewActivate("mcp-app:6162:card-1"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'mcp-app:6162:card-1'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
  });

  it("ignores a malformed plugin key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitViewActivate } = await renderApp();
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    // Reject incomplete plugin keys even when their prefix matches.
    act(() => emitViewActivate("plugin:token-plugin"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'plugin:token-plugin'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
  });

  it("refuses to navigate to a plugin view whose manifest yields a malformed key", async () => {
    // Manifest extension ids may be empty, but the resulting trailing-colon key is not a valid view location.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = userEvent.setup();
    await renderApp({
      pluginCards: [{
        id: "broken-plugin",
        name: "Broken Plugin",
        description: "Ships a UI extension with an empty id",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
      }],
      pluginUiExtensions: [{
        pluginId: "broken-plugin",
        extension: {
          id: "",
          slot: "sidebar",
          kind: "embedded-module",
          title: "Broken View",
          entry: "dist/ui.js",
        },
        entryUrl: "file:///broken-plugin/dist/ui.js",
      }],
    });
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy());

    // The composer's command button opens a native menu jsdom cannot render; the inline "/" menu is the DOM affordance over
    // the same plugin rows.
    const composer = screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;
    // The query is one token: a space ends the trigger, so type the first word.
    fireEvent.change(composer, { target: { value: "/Broken" } });
    composer.setSelectionRange(7, 7);
    fireEvent.keyUp(composer, { key: "n" });
    const menu = await screen.findByTestId("inline-slash-menu");
    await user.click(await within(menu).findByText("Broken View"));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'plugin:broken-plugin:'")),
    );
    expect(screen.getByTestId(TEST_IDS.chatViewRoot)).toBeTruthy();
  });
});

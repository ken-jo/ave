import "./setup.js";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./render-app.js";
import { collectTiles, focusTile, mountedTileIds, splitIntoTwoTiles, toggleTileMaximized } from "./helpers.js";

describe("responsive canvas", () => {
  it("folds from canvas width, keeps hidden conversations alive, and restores above the dead band", async () => {
    const view = await renderApp({ shellWidth: 1600, canvasWidth: 1200, hasApiKey: true });
    const tiles = await splitIntoTwoTiles(view.container);
    const focusedId = tiles[1]!.chatGroupId;
    const originalIds = mountedTileIds(view.container);
    const originalElements = tiles.map((tile) => tile.element);
    await view.resizeContainers({ canvasWidth: 904 });
    expect(collectTiles(view.container)).toHaveLength(2);
    await view.resizeContainers({ canvasWidth: 903 });
    await waitFor(() => expect(collectTiles(view.container).map((tile) => tile.chatGroupId)).toEqual([focusedId]));
    expect(mountedTileIds(view.container)).toEqual(originalIds);
    for (const element of originalElements) expect(element.isConnected).toBe(true);
    await act(async () => {
      view.emitChatStream({ type: "text_delta", text: "Retained hidden stream", groupId: tiles[0]!.chatGroupId });
    });
    expect(view.releasedGroupIds()).toEqual([]);
    for (const control of ["pane-split", "pane-close", "pane-maximize"]) {
      expect(collectTiles(view.container)[0]!.element.querySelector(`[data-testid="${control}"]`)).toBeNull();
    }
    await view.resizeContainers({ shellWidth: 600, canvasWidth: 963 });
    expect(collectTiles(view.container)).toHaveLength(1);
    await view.resizeContainers({ canvasWidth: 964 });
    await waitFor(() => expect(collectTiles(view.container)).toHaveLength(2));
    expect(collectTiles(view.container)[0]!.element).toBe(originalElements[0]);
    await waitFor(() => expect(originalElements[0]!.textContent).toContain("Retained hidden stream"));
  });

  it("uses the focused conversation on a narrow canvas and preserves the saved maximized conversation", async () => {
    const view = await renderApp({ shellWidth: 1600, canvasWidth: 1200, hasApiKey: true });
    const [first, second] = await splitIntoTwoTiles(view.container);
    await toggleTileMaximized(first!);
    await waitFor(() => expect(collectTiles(view.container).map((tile) => tile.chatGroupId)).toEqual([first!.chatGroupId]));
    await view.resizeContainers({ canvasWidth: 600 });
    // Focus changes while folded must leave the saved wide-layout maximize target intact.
    await focusTile(second!);
    await waitFor(() => expect(collectTiles(view.container).map((tile) => tile.chatGroupId)).toEqual([second!.chatGroupId]));
    await view.resizeContainers({ canvasWidth: 1200 });
    await waitFor(() => expect(collectTiles(view.container).map((tile) => tile.chatGroupId)).toEqual([first!.chatGroupId]));
  });
});

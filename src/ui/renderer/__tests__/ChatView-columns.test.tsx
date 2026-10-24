import "../../../../test/renderer/setup.js";
import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";
import * as surfaceMoves from "../preview/surface-moves.js";
import type { ChatThumbnailColumnProps } from "../components/chat-thumbnail-column.js";

const probe = vi.hoisted(() => ({ moves: null as surfaceMoves.SurfaceMoves | null, onOpenTab: null as ChatThumbnailColumnProps["onOpenTab"] | null }));
vi.mock("../components/chat-thumbnail-column.js", async () => {
  const { useSurfaceMoves } = await import("../preview/surface-moves.js");
  return { ChatThumbnailColumn: (props: ChatThumbnailColumnProps) => {
    probe.moves = useSurfaceMoves();
    probe.onOpenTab = props.onOpenTab;
    return null;
  } };
});

afterEach(() => { vi.restoreAllMocks(); probe.moves = null; probe.onOpenTab = null; });

describe("ChatView missing thumbnail tabs", () => {
  it("quietly ignores a missing tab when moving it into the work panel", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.paneThumbnailToggle))!);
    await act(async () => {});
    expect(probe.moves).not.toBeNull();
    expect(() => probe.moves!.tabToSide("browser:missing", "main")).not.toThrow();
    expect(container.querySelector(testIdSelector(TEST_IDS.panePanelToggle))?.getAttribute("aria-pressed")).toBe("false");
  });

  it("quietly ignores a missing tab when the view has no surface-move host", async () => {
    vi.spyOn(surfaceMoves, "useSurfaceMoves").mockReturnValue(null);
    const { container } = await renderApp({ hasApiKey: true });
    fireEvent.click(container.querySelector(testIdSelector(TEST_IDS.paneThumbnailToggle))!);
    await act(async () => {});
    expect(probe.onOpenTab).not.toBeNull();
    expect(() => probe.onOpenTab!("browser:missing")).not.toThrow();
  });
});

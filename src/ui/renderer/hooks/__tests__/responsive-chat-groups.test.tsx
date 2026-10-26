import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useChatGroups } from "../../components/PaneFrame.js";
import { ErrorBoundary } from "../../components/ErrorBoundary.js";
import { t } from "../../../../i18n/runtime.js";

function canvasGroups() {
  let callback: ResizeObserverCallback;
  let observed: Element;
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: ResizeObserverCallback) { callback = cb; }
    observe(element: Element) { observed = element; }
    disconnect() {}
  });
  const canvas = document.createElement("div");
  const hook = renderHook(() => useChatGroups(canvas));
  return {
    ...hook,
    width(width: number) {
      act(() => callback([
        { target: observed, contentRect: { width }, contentBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry,
      ], {} as ResizeObserver));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("responsive conversation groups", () => {
  it("observes the replacement canvas after content recovery and unfolds its retained groups", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const observations = new Map<Element, ResizeObserverCallback>();
    const disconnected = new Set<Element>();
    vi.stubGlobal("ResizeObserver", class {
      private element: Element | undefined;
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element) {
        this.element = element;
        observations.set(element, this.callback);
      }
      disconnect() {
        if (this.element) {
          observations.delete(this.element);
          disconnected.add(this.element);
        }
      }
    });
    let groups: ReturnType<typeof useChatGroups>;
    function Canvas({ failed, onElement }: { failed: boolean; onElement: (element: HTMLDivElement | null) => void }) {
      if (failed) throw new Error("Canvas content failed");
      return <div ref={onElement} data-testid="recovery-canvas" />;
    }
    function Harness() {
      const [failed, setFailed] = useState(false);
      const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null);
      groups = useChatGroups(canvasElement);
      return <>
        <button onClick={() => setFailed(true)}>Fail content</button>
        <ErrorBoundary fallback="Canvas unavailable" onReset={() => setFailed(false)}>
          <Canvas failed={failed} onElement={setCanvasElement} />
        </ErrorBoundary>
      </>;
    }
    const view = render(<Harness />);
    const firstCanvas = view.getByTestId("recovery-canvas");
    const firstResize = observations.get(firstCanvas)!;
    const resize = (element: Element, width: number) => act(() => {
      observations.get(element)?.([
        { target: element, contentBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry,
      ], {} as ResizeObserver);
    });
    resize(firstCanvas, 1200);
    act(() => groups.split("main", "row"));
    resize(firstCanvas, 600);
    expect(groups!.isSingleTile).toBe(true);
    expect(groups!.groups).toHaveLength(2);
    fireEvent.click(view.getByText("Fail content"));
    expect(view.queryByTestId("recovery-canvas")).toBeNull();
    fireEvent.click(view.getByText(t("errorBoundary.retryButton")));
    const replacementCanvas = view.getByTestId("recovery-canvas");
    expect(replacementCanvas).not.toBe(firstCanvas);
    expect(observations.has(replacementCanvas)).toBe(true);
    expect(disconnected.has(firstCanvas)).toBe(true);
    resize(replacementCanvas, 1200);
    expect(groups!.groups).toHaveLength(2);
    expect(groups!.groups.filter((group) => !group.hidden)).toHaveLength(2);
    expect(groups!.isSingleTile).toBe(false);
    expect(groups!.canSplit).toBe(true);
    act(() => firstResize([
      { target: firstCanvas, contentBoxSize: [{ inlineSize: 600 }] } as unknown as ResizeObserverEntry,
    ], {} as ResizeObserver));
    expect(groups!.isSingleTile).toBe(false);
    view.unmount();
    expect(observations.size).toBe(0);
    vi.mocked(console.error).mockRestore();
  });

  it("folds the focused tile while retaining the maximized choice and hidden groups", () => {
    const view = canvasGroups();
    view.width(1200);
    act(() => view.result.current.split("main", "row"));
    const secondId = view.result.current.focusedId;
    act(() => view.result.current.toggleMaximize("main"));
    view.width(600);
    act(() => view.result.current.focus(secondId));
    expect(view.result.current.groups.filter((group) => !group.hidden).map((group) => group.id)).toEqual([secondId]);
    expect(view.result.current.groups).toHaveLength(2);
    expect(view.result.current.maximizedId).toBe("main");
    expect(view.result.current.canSplit).toBe(false);
    expect(view.result.current.canMaximize).toBe(false);
    expect(view.result.current.closable).toBe(false);
    view.width(964);
    expect(view.result.current.groups.filter((group) => !group.hidden).map((group) => group.id)).toEqual(["main"]);
    expect(view.result.current.maximizedId).toBe("main");
    expect(view.result.current.focusedId).toBe("main");
  });

  it("refuses narrow adoption when only the saved maximized group is idle", () => {
    const view = canvasGroups();
    view.width(1600);
    act(() => view.result.current.split("main", "row"));
    const maximizedId = view.result.current.focusedId;
    act(() => view.result.current.split("main", "row"));
    act(() => view.result.current.split("main", "row"));
    act(() => view.result.current.toggleMaximize(maximizedId));
    view.width(360);
    act(() => view.result.current.focus("main"));
    act(() => {
      expect(view.result.current.adopt("main", (id) => id === maximizedId, { width: 360, height: 900 })).toBeNull();
    });
    expect(view.result.current.groups.some((group) => group.id === maximizedId)).toBe(true);
    view.width(1600);
    expect(view.result.current.groups.filter((group) => !group.hidden).map((group) => group.id)).toEqual([maximizedId]);
    expect(view.result.current.focusedId).toBe(maximizedId);
  });

  it("refuses split, close and maximize actions while the independent canvas is folded", () => {
    const view = canvasGroups();
    view.width(1200);
    act(() => view.result.current.split("main", "row"));
    const before = view.result.current.tree;
    view.width(360);
    act(() => {
      view.result.current.split("main", "column");
      view.result.current.close("main");
      view.result.current.toggleMaximize("main");
    });
    expect(view.result.current.tree).toEqual(before);
    expect(view.result.current.maximizedId).toBeNull();
    expect(view.result.current.openPane("main", { width: 360, height: 900 })).toBeNull();
  });
});

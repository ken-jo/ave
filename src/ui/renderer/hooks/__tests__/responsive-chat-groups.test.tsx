import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { useChatGroups } from "../../components/PaneFrame.js";

function canvasGroups() {
  let callback: ResizeObserverCallback;
  let observed: Element;
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: ResizeObserverCallback) { callback = cb; }
    observe(element: Element) { observed = element; }
    disconnect() {}
  });
  const hook = renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(document.createElement("div"));
    return useChatGroups(ref);
  });
  return {
    ...hook,
    width(width: number) {
      act(() => callback([
        { target: observed, contentRect: { width }, contentBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry,
      ], {} as ResizeObserver));
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("responsive conversation groups", () => {
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

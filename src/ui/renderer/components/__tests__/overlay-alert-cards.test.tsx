// @vitest-environment jsdom
/**
 * Alert cards in the overlay queue.
 *
 * An alert is a plugin's insertion card the host rendered from the kind's
 * declared templates. It sits in its priority band — high above normal above
 * low — a re-raise of the same identity refreshes the card and moves it to the
 * top of its band, and main can withdraw a card it staged.
 */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { OverlayCardRegion } from "../OverlayCardRegion.js";
import {
  OverlayContextProvider,
  useOverlayContext,
  type OverlayItem,
  type OverlayPriority,
} from "../../context/OverlayContext.js";

function alertItem(alertId: string, priority?: OverlayPriority, summary = `summary ${alertId}`): OverlayItem {
  return {
    id: `alert:${alertId}`,
    source: { kind: "alert", pluginId: "fixturemail", kindId: "reply", alertId },
    title: "Mail needing a reply",
    summary,
    running: false,
    pendingPrompt: `prompt ${alertId}`,
    primaryActionLabel: "Draft a reply",
    createdAt: "2026-09-26T00:00:00.000Z",
    ...(priority ? { priority } : {}),
  };
}

function pluginItem(eventId: string): OverlayItem {
  return {
    id: `plugin:${eventId}`,
    source: { kind: "plugin", pluginId: "fixturemail", eventId },
    title: "suggestion",
    summary: "a staged suggestion",
    running: false,
    pendingPrompt: "do the thing",
    createdAt: "2026-09-26T00:00:00.000Z",
  };
}

function mount(onPluginPrimaryAction = vi.fn()) {
  const addFireRef = createRef<((item: OverlayItem) => void) | null>();
  const dismissRef = createRef<((id: string) => void) | null>();
  let queue: readonly OverlayItem[] = [];
  function QueueProbe() {
    queue = useOverlayContext().queue;
    return null;
  }
  render(
    <TooltipProvider>
      <OverlayContextProvider onOpenSession={() => true} addFireRef={addFireRef} dismissRef={dismissRef}>
        <QueueProbe />
        <OverlayCardRegion
          chatGroupId="main"
          actionChatGroupId="main"
          overlayCardTile={() => ({ chatGroupId: "main", orphaned: false })}
          onPluginPrimaryAction={onPluginPrimaryAction}
        />
      </OverlayContextProvider>
    </TooltipProvider>,
  );
  return {
    add: (item: OverlayItem) => act(() => addFireRef.current?.(item)),
    withdraw: (id: string) => act(() => dismissRef.current?.(id)),
    ids: () => queue.map((item) => item.id),
    queue: () => queue,
  };
}

describe("alert cards in the overlay queue", () => {
  it.each(["urgent", "toString", "__proto__", 3, null])("ranks malformed priority %s as normal below high", (priority) => {
    const q = mount();
    q.add(alertItem("high", "high"));
    q.add({ ...alertItem("malformed"), priority: priority as OverlayPriority });
    expect(q.ids()).toEqual(["alert:malformed", "alert:high"]);
    expect(screen.getByText("summary high")).toBeTruthy();
    expect(screen.queryByText("summary malformed")).toBeNull();
  });

  it("orders alerts high above normal above low, oldest first within a band", () => {
    const q = mount();
    q.add(alertItem("a", "low"));
    q.add(alertItem("b", "high"));
    q.add(alertItem("c"));
    q.add(alertItem("d", "high"));
    q.add(alertItem("e", "low"));
    // The queue runs from the bottom band up; the region shows the last card.
    expect(q.ids()).toEqual(["alert:a", "alert:e", "alert:c", "alert:b", "alert:d"]);
  });

  it("counts every other card as normal, so their arrival order is unchanged", () => {
    const q = mount();
    q.add(pluginItem("1"));
    q.add(alertItem("hi", "high"));
    // A priority on a card that is not an alert is not read.
    q.add({ ...pluginItem("2"), priority: "high" });
    q.add(alertItem("lo", "low"));
    expect(q.ids()).toEqual(["alert:lo", "plugin:1", "plugin:2", "alert:hi"]);
  });

  it("refreshes a re-raised alert in place of the old card, at the top of its band", () => {
    const q = mount();
    q.add(alertItem("a"));
    q.add(alertItem("b"));
    q.add({ ...alertItem("a", "normal", "refreshed"), id: "alert:a-2" });
    expect(q.ids()).toEqual(["alert:b", "alert:a-2"]);
    expect(q.queue().at(-1)?.summary).toBe("refreshed");
  });

  it("lets main withdraw a card it staged", () => {
    const q = mount();
    q.add(alertItem("a"));
    q.add(alertItem("b"));
    q.withdraw("alert:a");
    expect(q.ids()).toEqual(["alert:b"]);
  });

  it("renders an alert as an insertion card whose confirm hands it to the tile", () => {
    const onPluginPrimaryAction = vi.fn();
    const q = mount(onPluginPrimaryAction);
    q.add(alertItem("a", "high"));
    expect(screen.getByText("summary a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Draft a reply" }));
    expect(onPluginPrimaryAction).toHaveBeenCalledWith("alert:a", "main");
    expect(q.ids()).toEqual([]);
  });
});

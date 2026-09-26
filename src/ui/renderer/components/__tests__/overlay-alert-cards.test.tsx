// @vitest-environment jsdom
/**
 * Alert cards in the overlay queue.
 *
 * An alert is a plugin's insertion card the host rendered from the kind's
 * declared templates. It sits in its priority band — high above normal above
 * low — a re-raise of the same identity refreshes the card and moves it to the
 * top of its band, and main can withdraw a card it staged. Closing an alert
 * card is reported, so main keeps its identity closed.
 */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../../../i18n/index.js";
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

function mount(onPluginPrimaryAction = vi.fn(), onAlertDismiss = vi.fn()) {
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
          onAlertDismiss={onAlertDismiss}
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

function expectPluginIdentity(pluginId: string, name?: string) {
  const id = screen.getByTestId("plugin-provenance-id");
  const fullId = t("alerts.pluginIdOnly", { id: pluginId });
  expect(id.textContent?.trim()).toBe(fullId);
  expect(id.getAttribute("title")).toBe(fullId);
  expect(id.getAttribute("aria-label")).toBe(fullId);
  const displayName = screen.queryByTestId("plugin-provenance-name");
  if (name) {
    expect(displayName?.textContent).toBe(name);
    expect(displayName?.className).toContain("opacity-60");
    expect(id.textContent).not.toContain(name);
  } else {
    expect(displayName).toBeNull();
  }
}

describe("alert cards in the overlay queue", () => {
  it("shows distinct canonical ids when names and kind titles match", () => {
    const q = mount();
    q.add({ ...alertItem("mail", undefined, "Plugin: fixturecalendar"), pluginDisplayName: "Mail tools" });
    q.add({
      ...alertItem("calendar", undefined, "Plugin: fixturemail"),
      source: { kind: "alert", pluginId: "fixturecalendar", kindId: "reply", alertId: "calendar" },
      pluginDisplayName: "Mail tools",
    });
    expectPluginIdentity("fixturecalendar", "Mail tools");
    fireEvent.click(screen.getByTestId("overlay-card-prev"));
    expectPluginIdentity("fixturemail", "Mail tools");
  });

  it("identifies plugin suggestions and onboarding proposals under plugin-authored titles", () => {
    const q = mount();
    q.add({ ...pluginItem("suggestion"), title: "Built-in notice", pluginDisplayName: "Ave" });
    expectPluginIdentity("fixturemail", "Ave");
    q.add({
      id: "proposal:fixturecalendar:first-task",
      source: { kind: "proposal", pluginId: "fixturecalendar", proposalId: "first-task", action: { kind: "composer", prompt: "Review this" } },
      title: "Built-in notice",
      summary: "A proposed action",
      running: false,
      createdAt: "2026-09-26T00:00:00.000Z",
      pluginDisplayName: "Ave",
    });
    expectPluginIdentity("fixturecalendar", "Ave");
    fireEvent.click(screen.getByTestId("overlay-card-prev"));
    expectPluginIdentity("fixturemail", "Ave");
  });

  it("falls back to the canonical id for a plugin card without a display name", () => {
    const q = mount();
    q.add(pluginItem("legacy"));
    expectPluginIdentity("fixturemail");
  });

  it("keeps the full id visible and accessible when two maximum-length ids differ at the end", () => {
    const q = mount();
    const head = `plugin-${"x".repeat(56)}`;
    const firstId = `${head}a`;
    const secondId = `${head}b`;
    q.add({
      ...pluginItem("first"),
      source: { kind: "plugin", pluginId: firstId, eventId: "first" },
      pluginDisplayName: "Enterprise Calendar and Scheduling Tools",
    });
    q.add({
      ...pluginItem("second"),
      source: { kind: "plugin", pluginId: secondId, eventId: "second" },
      pluginDisplayName: "Enterprise Calendar and Scheduling Tools",
    });
    expectPluginIdentity(secondId, "Enterprise Calendar and Scheduling Tools");
    expect(screen.getByTestId("plugin-provenance-id").className).toContain("break-all");
    fireEvent.click(screen.getByTestId("overlay-card-prev"));
    expectPluginIdentity(firstId, "Enterprise Calendar and Scheduling Tools");
  });

  it("separates a host-looking display name from the canonical id", () => {
    const q = mount();
    q.add({ ...pluginItem("spoof"), pluginDisplayName: "Plugin: lyra-mail · Ave Lyra Mail" });
    expectPluginIdentity("fixturemail", "Plugin: lyra-mail · Ave Lyra Mail");
  });

  it("identifies a host alert as built-in rather than a plugin notice", () => {
    const q = mount();
    q.add({ ...alertItem("host"), source: { kind: "alert", pluginId: "@host", kindId: "due-soon", alertId: "host" } });
    expect(screen.getByText(t("alerts.builtInNotice"))).toBeTruthy();
    expect(screen.queryByTestId("plugin-provenance-id")).toBeNull();
  });
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

  it("reports an alert card the user closed, and not a plugin card", () => {
    const onAlertDismiss = vi.fn();
    const q = mount(vi.fn(), onAlertDismiss);
    q.add(pluginItem("1"));
    fireEvent.click(screen.getByTestId("routine-card-dismiss"));
    expect(onAlertDismiss).not.toHaveBeenCalled();
    q.add(alertItem("a"));
    fireEvent.click(screen.getByTestId("routine-card-dismiss"));
    expect(onAlertDismiss).toHaveBeenCalledWith("alert:a");
    expect(q.ids()).toEqual([]);
  });
});

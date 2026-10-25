// @vitest-environment jsdom
/** The lane owns positioning and occupants do not; jsdom can verify that structure but cannot measure overlap. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { FloatingRightLane } from "../FloatingRightLane.js";
import { OverlayCardRegion } from "../OverlayCardRegion.js";
import {
  OverlayContextProvider,
  type OverlayItem,
} from "../../context/OverlayContext.js";

const PLUGIN_ITEM: OverlayItem = {
  id: "plugin-lane-test",
  source: { kind: "plugin", pluginId: "demo", eventId: "e1" },
  title: "demo-alert",
  summary: "a staged alert",
  running: false,
  pendingPrompt: "do the thing",
  createdAt: "2026-08-23T00:00:00.000Z",
};

function renderLane() {
  const addFireRef = createRef<((item: OverlayItem) => void) | null>();
  const view = render(
    <TooltipProvider>
      <OverlayContextProvider onOpenSession={() => true} addFireRef={addFireRef}>
        <FloatingRightLane>
          <OverlayCardRegion
            chatGroupId="main"
            actionChatGroupId="main"
            overlayCardTile={() => ({ chatGroupId: "main", orphaned: false })}
            onPluginPrimaryAction={vi.fn()}
          />
        </FloatingRightLane>
      </OverlayContextProvider>
    </TooltipProvider>,
  );
  act(() => {
    addFireRef.current?.(PLUGIN_ITEM);
  });
  return view;
}

describe("FloatingRightLane", () => {
  it("stacks its occupants instead of piling them at one point", () => {
    renderLane();

    const lane = screen.getByTestId("floating-right-lane");
    const card = screen.getByTestId("overlay-card-region");

    // In the lane — a sibling that escaped it would be back to positioning itself.
    expect(lane.contains(card)).toBe(true);
    expect(lane.className).toContain("flex-col");
  });

  it("keeps each occupant inside the same inset on both pane edges", () => {
    renderLane();

    const lane = screen.getByTestId("floating-right-lane");
    const card = screen.getByTestId("overlay-card-region");

    expect(lane.classList.contains("inset-x-4")).toBe(true);
    expect(card.classList.contains("max-w-full")).toBe(true);
  });

  it("bounds the lane vertically and lets card gestures scroll to actions", () => {
    renderLane();

    const lane = screen.getByTestId("floating-right-lane");
    const card = screen.getByTestId("overlay-card-region");

    expect(lane.classList.contains("bottom-4")).toBe(true);
    expect(lane.classList.contains("overflow-y-auto")).toBe(true);
    expect(lane.classList.contains("touch-pan-y")).toBe(true);
    expect(lane.classList.contains("[&>*]:shrink-0")).toBe(true);
    expect(lane.contains(card)).toBe(true);
  });

  function renderWheelSurface() {
    render(
      <div data-approval-scope>
        <div className="ave-chat-scroll"><div data-radix-scroll-area-viewport="" data-testid="transcript" style={{ lineHeight: "20px" }} /></div>
        <FloatingRightLane>
          <section data-testid="approval-lane-card">
            <div data-testid="card-scroll" style={{ overflowY: "auto" }}>
              <button type="button">Approval action</button>
            </div>
          </section>
        </FloatingRightLane>
      </div>,
    );
    const lane = screen.getByTestId("floating-right-lane");
    const cardScroll = screen.getByTestId("card-scroll");
    const transcript = screen.getByTestId("transcript");
    const button = screen.getByRole("button", { name: "Approval action" });
    Object.defineProperties(transcript, { clientHeight: { value: 200 }, scrollHeight: { value: 2000 } });
    Object.defineProperties(cardScroll, { clientHeight: { value: 100 }, scrollHeight: { value: 500, configurable: true } });
    Object.defineProperties(lane, { clientHeight: { value: 200 }, scrollHeight: { value: 400, configurable: true } });
    transcript.scrollTop = 1000;
    return { lane, cardScroll, transcript, button };
  }

  it("keeps a scrollable card or lane as the wheel target at both boundaries", () => {
    const { lane, cardScroll, transcript, button } = renderWheelSurface();

    fireEvent.wheel(button, { deltaY: 350 });
    expect(transcript.scrollTop).toBe(1000);

    cardScroll.scrollTop = 400;
    fireEvent.wheel(button, { deltaY: 350 });
    expect(transcript.scrollTop).toBe(1000);

    Object.defineProperty(lane, "scrollHeight", { value: 200, configurable: true });
    fireEvent.wheel(button, { deltaY: 350 });
    expect(transcript.scrollTop).toBe(1000);

    Object.defineProperty(lane, "scrollHeight", { value: 400, configurable: true });
    lane.scrollTop = 200;
    fireEvent.wheel(button, { deltaY: 350 });
    expect(transcript.scrollTop).toBe(1000);

    cardScroll.scrollTop = 0;
    lane.scrollTop = 0;
    fireEvent.wheel(button, { deltaY: -350 });
    expect(transcript.scrollTop).toBe(1000);

    Object.defineProperty(cardScroll, "scrollHeight", { value: 100 });
    lane.scrollTop = 200;
    fireEvent.wheel(button, { deltaY: 350 });
    expect(transcript.scrollTop).toBe(1000);
    lane.scrollTop = 0;
    fireEvent.wheel(button, { deltaY: -350 });
    expect(transcript.scrollTop).toBe(1000);

    Object.defineProperty(lane, "scrollHeight", { value: 200 });
    fireEvent.wheel(button, { deltaY: 350 });
    expect(transcript.scrollTop).toBe(1350);
  });

  it("reserves modifier-wheel gestures for the browser", () => {
    const { lane, cardScroll, transcript, button } = renderWheelSurface();
    Object.defineProperty(cardScroll, "scrollHeight", { value: 100 });
    Object.defineProperty(lane, "scrollHeight", { value: 200 });

    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
      fireEvent.wheel(button, { deltaY: 120, [modifier]: true });
      expect(transcript.scrollTop).toBe(1000);
    }
    fireEvent.wheel(button, { deltaY: 120 });
    expect(transcript.scrollTop).toBe(1120);
  });

  it("preserves fractional wheel input and normalizes line and page units", () => {
    const { lane, cardScroll, transcript, button } = renderWheelSurface();
    Object.defineProperty(cardScroll, "scrollHeight", { value: 100 });
    Object.defineProperty(lane, "scrollHeight", { value: 200 });
    let scrollTop = 1000;
    Object.defineProperty(transcript, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.round(value); },
    });

    for (let index = 0; index < 20; index += 1) fireEvent.wheel(button, { deltaY: 0.25 });
    expect(transcript.scrollTop).toBe(1005);
    for (let index = 0; index < 20; index += 1) fireEvent.wheel(button, { deltaY: -0.25 });
    expect(transcript.scrollTop).toBe(1000);

    fireEvent.wheel(button, { deltaY: 2, deltaMode: 1 });
    expect(transcript.scrollTop).toBe(1040);
    fireEvent.wheel(button, { deltaY: 1, deltaMode: 2 });
    expect(transcript.scrollTop).toBe(1240);

    transcript.scrollTop = 750;
    fireEvent.wheel(button, { deltaY: 0.25 });
    expect(transcript.scrollTop).toBe(750);
    fireEvent.wheel(button, { deltaY: 0.75 });
    expect(transcript.scrollTop).toBe(751);

    transcript.scrollTop = 1000;
    for (const deltaY of [30, 15.5, 5.25, 1.25, 0.5, 0.25]) {
      fireEvent.wheel(button, { deltaY });
    }
    expect(transcript.scrollTop).toBe(1053);
  });

  it("does not cancel a forwarded wheel from a passive listener", () => {
    const { lane, cardScroll, button } = renderWheelSurface();
    Object.defineProperty(cardScroll, "scrollHeight", { value: 100 });
    Object.defineProperty(lane, "scrollHeight", { value: 200 });
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    const preventDefault = vi.spyOn(wheel, "preventDefault");
    fireEvent(button, wheel);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("leaves positioning to the lane — the occupant does not anchor itself", () => {
    renderLane();

    const className = screen.getByTestId("overlay-card-region").className;
    expect(className, "overlay-card-region must not position itself").not.toMatch(/\babsolute\b/);
    expect(className, "overlay-card-region must not set its own layer").not.toMatch(/\bz-\d/);
  });

  it("carries no tool-activity surface — that lives in the work panel now", () => {
    renderLane();

    const lane = screen.getByTestId("floating-right-lane");
    expect(lane.querySelector("[data-testid='chat-side-panel-launcher-tool-activity']")).toBeNull();
    expect(lane.querySelector("[data-testid='tool-activity-open-tab']")).toBeNull();
  });

  it("keeps the overlay card's own dismiss control reachable", () => {
    renderLane();

    // Keep card controls reachable inside the shared lane.
    const card = screen.getByTestId("overlay-card-region");
    const dismiss = screen.getByTestId("routine-card-dismiss");
    expect(card.contains(dismiss)).toBe(true);
  });
});

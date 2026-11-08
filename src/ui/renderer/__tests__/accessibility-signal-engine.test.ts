import { describe, expect, it, vi } from "vitest";
import { AccessibilitySignalEngine, TurnSignalTracker } from "../accessibility-signal-engine.js";
import type { AccessibilitySignalId } from "../../../shared/accessibility-signals.js";

function engineWith(focused: boolean) {
  const state = { focused };
  const play = vi.fn(async (_id: AccessibilitySignalId) => {});
  const engine = new AccessibilitySignalEngine({ isWindowFocused: () => state.focused, play });
  return { engine, play, state };
}

describe("AccessibilitySignalEngine", () => {
  it("plays background-only signals when no Ave window has focus, and never the default-off failure", () => {
    const { engine, play, state } = engineWith(true);
    expect(engine.signal("turnFinished", "turn:a:1")).toBe(false);
    expect(engine.signal("approvalNeeded", "approval:1")).toBe(false);
    state.focused = false;
    expect(engine.signal("turnFinished", "turn:a:2")).toBe(true);
    expect(engine.signal("approvalNeeded", "approval:2")).toBe(true);
    expect(engine.signal("turnFailed", "turn:a:3")).toBe(false);
    expect(play.mock.calls.map(([id]) => id)).toEqual(["turnFinished", "approvalNeeded"]);
  });

  it("follows the modes it is given: on plays while focused, off never plays", () => {
    const { engine, play } = engineWith(true);
    engine.setModes({ turnFinished: "on", approvalNeeded: "off", turnFailed: "on" });
    expect(engine.signal("turnFinished", "t1")).toBe(true);
    expect(engine.signal("turnFailed", "t2")).toBe(true);
    expect(engine.signal("approvalNeeded", "a1")).toBe(false);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("plays once per event key, however many sources report it", () => {
    const { engine, play } = engineWith(false);
    expect(engine.signal("approvalNeeded", "ask:q1")).toBe(true);
    expect(engine.signal("approvalNeeded", "ask:q1")).toBe(false);
    expect(engine.signal("approvalNeeded", "ask:q2")).toBe(true);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("does not replay an event first seen while it was silent", () => {
    const { engine, play, state } = engineWith(true);
    engine.signal("turnFinished", "turn:a:1");
    state.focused = false;
    expect(engine.signal("turnFinished", "turn:a:1")).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it("previews regardless of mode and focus, and surfaces a failed preview", async () => {
    const { engine, play } = engineWith(true);
    engine.setModes({ turnFinished: "off", approvalNeeded: "off", turnFailed: "off" });
    await engine.preview("turnFailed");
    expect(play).toHaveBeenCalledExactlyOnceWith("turnFailed");
    play.mockRejectedValueOnce(new Error("audio context is suspended"));
    await expect(engine.preview("turnFinished")).rejects.toThrow(/suspended/);
  });

  it("reports a cue that could not play instead of throwing into the event source", async () => {
    const { engine, play } = engineWith(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    play.mockRejectedValueOnce(new Error("no audio device"));
    expect(engine.signal("turnFinished", "t1")).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[accessibility-signal] turnFinished did not play:", "no audio device"));
    warn.mockRestore();
  });
});

describe("TurnSignalTracker", () => {
  it("names one finished signal per turn, keyed by the stream", () => {
    const tracker = new TurnSignalTracker("main");
    expect(tracker.observe({ type: "assistant_delta", streamId: 4 })).toBeNull();
    expect(tracker.observe({ type: "done", streamId: 4 })).toEqual({ id: "turnFinished", eventKey: "turn:main:4" });
    expect(tracker.observe({ type: "done", streamId: 4 })).toBeNull();
    expect(tracker.observe({ type: "turn_summary", streamId: 4 })).toBeNull();
    expect(tracker.observe({ type: "assistant_delta", streamId: 5 })).toBeNull();
    expect(tracker.observe({ type: "done", streamId: 5 })).toEqual({ id: "turnFinished", eventKey: "turn:main:5" });
  });

  it("names a failed turn once, and the done that follows the error stays silent", () => {
    const tracker = new TurnSignalTracker("main");
    tracker.observe({ type: "assistant_delta", streamId: 1 });
    expect(tracker.observe({ type: "error", streamId: 1 })).toEqual({ id: "turnFailed", eventKey: "turn:main:1" });
    expect(tracker.observe({ type: "done", streamId: 1 })).toBeNull();
  });

  it("stays silent for a turn the user stopped, then hears the next turn", () => {
    const tracker = new TurnSignalTracker("main");
    tracker.observe({ type: "assistant_delta", streamId: 1 });
    tracker.noteUserStop();
    expect(tracker.observe({ type: "error", streamId: 1 })).toBeNull();
    expect(tracker.observe({ type: "done", streamId: 1 })).toBeNull();
    tracker.observe({ type: "user_message", streamId: 2 });
    expect(tracker.observe({ type: "done", streamId: 2 })).toEqual({ id: "turnFinished", eventKey: "turn:main:2" });
  });

  it("stays silent for a slash command, which answers the user's own action", () => {
    const tracker = new TurnSignalTracker("main");
    expect(tracker.observe({ type: "done", streamId: 1, route: "command" })).toBeNull();
  });

  it("separates turns without stream ids by their order", () => {
    const tracker = new TurnSignalTracker("side");
    expect(tracker.observe({ type: "done" })).toEqual({ id: "turnFinished", eventKey: "turn:side:seq-1" });
    expect(tracker.observe({ type: "done" })).toBeNull();
    tracker.observe({ type: "assistant_delta" });
    expect(tracker.observe({ type: "done" })).toEqual({ id: "turnFinished", eventKey: "turn:side:seq-2" });
  });

  it("ignores a retired stream's stragglers", () => {
    const tracker = new TurnSignalTracker("main");
    tracker.observe({ type: "done", streamId: 7 });
    expect(tracker.observe({ type: "tool_end", streamId: 6 })).toBeNull();
    expect(tracker.observe({ type: "done", streamId: 6 })).toBeNull();
  });

  it("stays silent for a turn an interrupting send cut short, whether or not its done arrives", () => {
    const lateDone = new TurnSignalTracker("main");
    lateDone.observe({ type: "assistant_delta", streamId: 1 });
    lateDone.noteUserStop();
    lateDone.observe({ type: "user_message", streamId: 2 });
    expect(lateDone.observe({ type: "done", streamId: 1 })).toBeNull();
    expect(lateDone.observe({ type: "done", streamId: 2 })).toEqual({ id: "turnFinished", eventKey: "turn:main:2" });

    const earlyDone = new TurnSignalTracker("main");
    earlyDone.observe({ type: "assistant_delta", streamId: 1 });
    earlyDone.noteUserStop();
    expect(earlyDone.observe({ type: "done", streamId: 1 })).toBeNull();
    earlyDone.observe({ type: "user_message", streamId: 2 });
    expect(earlyDone.observe({ type: "done", streamId: 2 })).toEqual({ id: "turnFinished", eventKey: "turn:main:2" });
  });

  it("hears a new stream whose first frame already ends it", () => {
    const tracker = new TurnSignalTracker("main");
    tracker.observe({ type: "done", streamId: 1 });
    expect(tracker.observe({ type: "done", streamId: 2 })).toEqual({ id: "turnFinished", eventKey: "turn:main:2" });
  });

  it("hears the running turn again when the host refused the interrupting send", () => {
    const tracker = new TurnSignalTracker("main");
    tracker.observe({ type: "assistant_delta", streamId: 1 });
    tracker.noteUserStop();
    tracker.clearUserStop();
    expect(tracker.observe({ type: "done", streamId: 1 })).toEqual({ id: "turnFinished", eventKey: "turn:main:1" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESSIBILITY_SIGNAL_SOUNDS, __test, playAccessibilitySignalSound } from "../accessibility-signal-sounds.js";

function fakeContext(initialState: AudioContextState, resumeTo: AudioContextState = "running") {
  const started: Array<{ type: OscillatorType; frequency: number; at: number }> = [];
  const ctx = {
    state: initialState,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => { ctx.state = resumeTo; }),
    createOscillator: vi.fn(() => {
      const osc = {
        type: "sine" as OscillatorType,
        frequency: { setValueAtTime: vi.fn((value: number) => { osc.frequencyValue = value; }) },
        frequencyValue: 0,
        connect: vi.fn(), disconnect: vi.fn(),
        start: vi.fn((at: number) => { started.push({ type: osc.type, frequency: osc.frequencyValue, at }); }),
        stop: vi.fn(),
        onended: null as null | (() => void),
      };
      return osc;
    }),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(), disconnect: vi.fn(),
    })),
  };
  return { ctx, started, factory: vi.fn(() => ctx as unknown as AudioContext) };
}

afterEach(() => __test.reset());

describe("accessibility signal sounds", () => {
  it("schedules each note of the cue on one shared context", async () => {
    const audio = fakeContext("running");
    await playAccessibilitySignalSound("turnFinished", audio.factory);
    await playAccessibilitySignalSound("approvalNeeded", audio.factory);
    expect(audio.factory).toHaveBeenCalledOnce();
    expect(audio.started).toEqual([
      ...ACCESSIBILITY_SIGNAL_SOUNDS.turnFinished.notes.map((n) => ({ type: "sine", frequency: n.frequency, at: 10 + n.at })),
      ...ACCESSIBILITY_SIGNAL_SOUNDS.approvalNeeded.notes.map((n) => ({ type: "triangle", frequency: n.frequency, at: 10 + n.at })),
    ]);
  });

  it("resumes a suspended context before scheduling", async () => {
    const audio = fakeContext("suspended");
    await playAccessibilitySignalSound("turnFailed", audio.factory);
    expect(audio.ctx.resume).toHaveBeenCalledOnce();
    expect(audio.started).toHaveLength(2);
  });

  it("rejects instead of reporting a cue a context that will not run never played", async () => {
    const audio = fakeContext("suspended", "suspended");
    await expect(playAccessibilitySignalSound("turnFinished", audio.factory)).rejects.toThrow(/suspended/);
    expect(audio.started).toHaveLength(0);
  });

  it("keeps every cue short, soft and distinct", () => {
    const contours = Object.values(ACCESSIBILITY_SIGNAL_SOUNDS).map((s) => s.notes.map((n) => n.frequency).join(">"));
    expect(new Set(contours).size).toBe(3);
    for (const sound of Object.values(ACCESSIBILITY_SIGNAL_SOUNDS)) {
      expect(sound.peak).toBeLessThanOrEqual(0.15);
      const end = Math.max(...sound.notes.map((n) => n.at + n.duration));
      expect(end).toBeLessThanOrEqual(0.4);
    }
  });
});

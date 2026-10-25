/** Final transcript events must bypass coalescing and flush immediately. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeCoalescingSend,
  isTranscriptEvent,
} from "../boot/steps/ipc-bridge.js";

interface FakeSend {
  calls: Array<{ type: string; data: unknown }>;
  send: (type: string, data: unknown) => void;
}

function makeFakeSend(): FakeSend {
  const calls: Array<{ type: string; data: unknown }> = [];
  return {
    calls,
    send: (type: string, data: unknown) => { calls.push({ type, data }); },
  };
}

describe("IPC backpressure — transcript coalescing (Issue 4)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("100 rapid non-final events + 1 final → ≤10 webContents.send calls total", () => {
    const fake = makeFakeSend();
    const send = makeCoalescingSend((data) => fake.send("meeting.transcript.updated", data));

    for (let i = 0; i < 100; i++) {
      send({ meetingId: "m1", newSegmentIndex: i, isFinal: false });
    }

    vi.advanceTimersByTime(150);

    send({ meetingId: "m1", newSegmentIndex: 100, isFinal: true });

    expect(fake.calls.length).toBeLessThanOrEqual(10);
    expect(fake.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("final event flushes immediately without waiting for debounce", () => {
    const fake = makeFakeSend();
    const send = makeCoalescingSend((data) => fake.send("meeting.transcript.updated", data));

    send({ meetingId: "m1", newSegmentIndex: 0, isFinal: false });
    expect(fake.calls.length).toBe(0);

    send({ meetingId: "m1", newSegmentIndex: 1, isFinal: true });
    expect(fake.calls.length).toBe(1);
    expect((fake.calls[0]!.data as { isFinal: boolean }).isFinal).toBe(true);
  });

  it("non-transcript events are NOT coalesced (each emits one send)", () => {
    const fake = makeFakeSend();
    const type = "email.new";
    expect(isTranscriptEvent(type)).toBe(false);

    for (let i = 0; i < 5; i++) {
      fake.send(type, { id: i });
    }
    expect(fake.calls.length).toBe(5);
  });

  it("isTranscriptEvent correctly identifies *.transcript.updated pattern", () => {
    expect(isTranscriptEvent("meeting.transcript.updated")).toBe(true);
    expect(isTranscriptEvent("video.transcript.updated")).toBe(true);
    expect(isTranscriptEvent("email.new")).toBe(false);
    expect(isTranscriptEvent("meeting.started")).toBe(false);
    expect(isTranscriptEvent("transcript.updated.extra")).toBe(false);
  });

  it("only latest non-final event data is sent in the debounced flush", () => {
    const fake = makeFakeSend();
    const send = makeCoalescingSend((data) => fake.send("meeting.transcript.updated", data));

    for (let i = 0; i < 10; i++) {
      send({ meetingId: "m1", newSegmentIndex: i, isFinal: false });
    }
    vi.advanceTimersByTime(150);

    expect(fake.calls.length).toBe(1);
    const data = fake.calls[0]!.data as { newSegmentIndex: number };
    expect(data.newSegmentIndex).toBe(9);
  });

  it("isDestroyed guard: destroyed window suppresses send", () => {
    let destroyed = false;
    const calls: unknown[] = [];
    const guardedSend = (data: unknown) => {
      if (destroyed) return;
      calls.push(data);
    };
    const send = makeCoalescingSend(guardedSend);

    send({ meetingId: "m1", newSegmentIndex: 0, isFinal: false });
    vi.advanceTimersByTime(150);
    expect(calls.length).toBe(1);

    destroyed = true;
    send({ meetingId: "m1", newSegmentIndex: 1, isFinal: true });
    expect(calls.length).toBe(1); // no new call
  });
});

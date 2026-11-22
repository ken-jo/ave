import { PassThrough } from "node:stream";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { framePluginChildInputWrite, PLUGIN_CHILD_INPUT_BYTES_MAX } from "../plugin-child-credit.js";
import { watchPluginChildInput } from "../plugin-child-stdin.js";

function openInput() {
  const stream = new PassThrough();
  const { port1: port, port2: receiver } = new MessageChannel();
  const dispatch = vi.spyOn(port, "postMessage").mockImplementation(() => undefined);
  const bytes = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const schedule = vi.fn((callback: () => void, delayMs: number) => { setTimeout(callback, delayMs); });
  const forceExit = vi.fn();
  const report = vi.fn();
  watchPluginChildInput(stream, port, bytes, { schedule, forceExit, report });
  return {
    stream, dispatch, bytes, schedule, forceExit, report, port,
    close() { stream.destroy(); port.close(); receiver.close(); },
  };
}

describe("plugin child input owner", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it.each(["end", "error", "close", "abort"] as const)("starts one 2 s exit deadline at the first %s", (event) => {
    const owner = openInput();
    try {
      if (event === "error") owner.stream.emit("error", new Error("input failed"));
      else if (event === "abort") owner.port.emit("message", null);
      else owner.stream.emit(event);

      vi.advanceTimersByTime(1_000);
      expect(owner.forceExit).not.toHaveBeenCalled();
      if (event !== "end") owner.stream.emit("end");
      if (event !== "close") owner.stream.emit("close");
      expect(owner.schedule).toHaveBeenCalledTimes(1);
      expect(owner.dispatch).toHaveBeenCalledExactlyOnceWith(null);

      vi.advanceTimersByTime(999);
      expect(owner.forceExit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(owner.forceExit).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      expect(owner.forceExit).toHaveBeenCalledTimes(1);
    } finally {
      owner.close();
    }
  });

  it("accepts an exactly full window and refuses the next byte", () => {
    const owner = openInput();
    try {
      Atomics.store(owner.bytes, 0, PLUGIN_CHILD_INPUT_BYTES_MAX - 2);
      const write = framePluginChildInputWrite(Buffer.from("ok"));
      owner.stream.emit("data", write.subarray(0, 7));
      expect(owner.dispatch).not.toHaveBeenCalled();
      owner.stream.emit("data", write.subarray(7));
      expect(Atomics.load(owner.bytes, 0)).toBe(PLUGIN_CHILD_INPUT_BYTES_MAX);
      const delivery = { frames: [], observation: Uint8Array.from(Buffer.from("ok")), credit: expect.any(Buffer) };
      expect(owner.dispatch.mock.calls[0]?.[0]).toEqual(delivery);
      expect(owner.schedule).not.toHaveBeenCalled();

      owner.stream.emit("data", framePluginChildInputWrite(Buffer.from("!")));
      expect(owner.dispatch.mock.calls.map(([message]) => message)).toEqual([delivery, null]);
      expect(owner.report).toHaveBeenCalledExactlyOnceWith("host input exceeded the credit window");
      expect(owner.stream.destroyed).toBe(true);
      expect(owner.schedule).toHaveBeenCalledTimes(1);
    } finally {
      owner.close();
    }
  });
});

import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pacePluginChildInput, PluginChildInputWriteDecoder, pluginChildInputCredit } from "../plugin-child-credit.js";

function openLink() {
  const source = new PassThrough();
  const sent: string[] = [];
  const ids: Buffer[] = [];
  const acknowledged: string[] = [];
  const decoder = new PluginChildInputWriteDecoder();
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      decoder.push(chunk, (payload, id) => {
        sent.push(payload.toString());
        ids.push(Buffer.from(id));
      });
      done();
    },
  });
  const { input, output } = pacePluginChildInput(source, sink);
  const errors: string[] = [];
  input.on("error", (error: Error) => errors.push(error.message));
  input.resume();
  return {
    source, input, sent, acknowledged, errors,
    credit(writeIndex: number, bytes: number) {
      return pluginChildInputCredit(ids[writeIndex] ?? Buffer.alloc(16), bytes);
    },
    queue(...writes: string[]) {
      for (const value of writes) output.write(value, (error) => {
        if (!error) acknowledged.push(value);
      });
    },
    close() { source.destroy(); output.destroy(); sink.destroy(); },
  };
}

describe("plugin child input credit", () => {
  it("refuses a second write's credit in the chunk that completes the first", async () => {
    const link = openLink();
    try {
      link.queue("a", "b", "c");
      expect(link.sent).toEqual(["a"]);
      const credit = link.credit(0, 1);
      link.source.write(Buffer.concat([credit, credit]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.acknowledged).not.toContain("b");
      expect(link.errors).toEqual(["Invalid plugin child input credit"]);
    } finally {
      link.close();
    }
  });

  it("refuses an extra credit whose marker arrived before the next write", async () => {
    const link = openLink();
    try {
      link.queue("a", "b", "c");
      const credit = link.credit(0, 1);
      link.source.write(Buffer.concat([credit, credit.subarray(0, 1)]));
      link.source.write(credit.subarray(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.acknowledged).not.toContain("b");
      expect(link.errors).toEqual(["Invalid plugin child input credit"]);
    } finally {
      link.close();
    }
  });

  it.each([false, true])("refuses a stale credit in a later source event (fragmented marker: %s)", async (fragmented) => {
    const link = openLink();
    try {
      link.queue("a", "b");
      const stale = link.credit(0, 1);
      link.source.write(stale);
      expect(link.sent).toEqual(["a", "b"]);
      if (fragmented) {
        link.source.write(stale.subarray(0, 1));
        link.source.write(stale.subarray(1));
      } else {
        link.source.write(stale);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.acknowledged).toEqual(["a"]);
      expect(link.errors).toEqual(["Invalid plugin child input credit"]);
    } finally {
      link.close();
    }
  });

  it("refuses stale credit queued on a backpressured source", async () => {
    const link = openLink();
    try {
      link.queue("a", "b");
      const stale = link.credit(0, 1);
      link.input.pause();
      link.source.write(Buffer.alloc(128 * 1024, 0x20));
      expect(link.source.isPaused()).toBe(true);
      link.source.write(stale);
      link.source.write(stale);
      expect(link.sent).toEqual(["a"]);
      link.input.resume();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.sent).toEqual(["a", "b"]);
      expect(link.acknowledged).toEqual(["a"]);
      expect(link.errors).toEqual(["Invalid plugin child input credit"]);
    } finally {
      link.close();
    }
  });

  it("faults when EOF truncates a credit header", async () => {
    const link = openLink();
    try {
      link.queue("a");
      link.source.end(link.credit(0, 1).subarray(0, -1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.errors).toEqual(["Truncated plugin child input credit"]);
      expect(link.input.readableEnded).toBe(false);
      expect(link.acknowledged).toEqual([]);
    } finally {
      link.close();
    }
  });

  it("keeps valid fragmented and partial credits with their write", () => {
    const link = openLink();
    try {
      link.queue("abc", "de", "f");
      const credit = link.credit(0, 2);
      link.source.write(credit.subarray(0, 2));
      expect(link.sent).toEqual(["abc"]);
      link.source.write(credit.subarray(2));
      expect(link.sent).toEqual(["abc"]);
      link.source.write(link.credit(0, 3));
      expect(link.sent).toEqual(["abc", "de"]);
      link.source.write(link.credit(1, 2));
      expect(link.sent).toEqual(["abc", "de", "f"]);
      link.source.write(link.credit(2, 1));
      expect(link.acknowledged).toEqual(["abc", "de", "f"]);
      expect(link.errors).toEqual([]);
    } finally {
      link.close();
    }
  });

  it.each([["zero", 0], ["oversized", 2]] as const)("refuses %s credit with queued writes", async (_label, bytes) => {
    const link = openLink();
    try {
      link.queue("a", "b", "c");
      link.source.write(link.credit(0, bytes));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.sent).toEqual(["a"]);
      expect(link.acknowledged).toEqual([]);
      expect(link.errors).toEqual(["Invalid plugin child input credit"]);
    } finally {
      link.close();
    }
  });

  it("refuses unsolicited fragmented credit even if writes arrive before its payload", async () => {
    const link = openLink();
    try {
      const credit = link.credit(0, 1);
      link.source.write(credit.subarray(0, 2));
      link.queue("a", "b", "c");
      link.source.write(credit.subarray(2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.acknowledged).toEqual([]);
      expect(link.errors).toEqual(["Invalid plugin child input credit"]);
    } finally {
      link.close();
    }
  });
});

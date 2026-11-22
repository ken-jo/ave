import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pacePluginChildInput, pluginChildInputCredit } from "../plugin-child-credit.js";

function openLink() {
  const source = new PassThrough();
  const sent: string[] = [];
  const acknowledged: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      sent.push(chunk.toString());
      done();
    },
  });
  const { input, output } = pacePluginChildInput(source, sink);
  const errors: string[] = [];
  input.on("error", (error: Error) => errors.push(error.message));
  input.resume();
  return {
    source, sent, acknowledged, errors,
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
      link.source.write(Buffer.concat([pluginChildInputCredit(1), pluginChildInputCredit(1)]));
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
      const credit = pluginChildInputCredit(1);
      link.source.write(Buffer.concat([credit, credit.subarray(0, 1)]));
      link.source.write(credit.subarray(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(link.acknowledged).not.toContain("b");
      expect(link.errors).toEqual(["Invalid plugin child input credit"]);
    } finally {
      link.close();
    }
  });

  it("keeps valid fragmented and partial credits with their write", () => {
    const link = openLink();
    try {
      link.queue("abc", "de", "f");
      const credit = pluginChildInputCredit(2);
      link.source.write(credit.subarray(0, 2));
      expect(link.sent).toEqual(["abc"]);
      link.source.write(credit.subarray(2));
      expect(link.sent).toEqual(["abc"]);
      link.source.write(pluginChildInputCredit(1));
      expect(link.sent).toEqual(["abc", "de"]);
      link.source.write(credit);
      expect(link.sent).toEqual(["abc", "de", "f"]);
      link.source.write(pluginChildInputCredit(1));
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
      link.source.write(pluginChildInputCredit(bytes));
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
      const credit = pluginChildInputCredit(1);
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

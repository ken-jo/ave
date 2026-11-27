import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { MxcExtensionChannel } from "../mxc-extension-channel.js";
import { MxcFrameDecoder, MXC_STREAM_CHUNK_BYTES } from "../mxc-extension-protocol.js";
import { MxcProcessContractError } from "../mxc-extension-errors.js";

const GENERATION = "c".repeat(64);
const KEY = Buffer.alloc(32, 7);

describe("bounded supervisor channel writer", () => {
  it("caps queued frames while a slow consumer blocks the pipe", async () => {
    const callbacks: Array<() => void> = [];
    const packets: Buffer[] = [];
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) { packets.push(Buffer.from(chunk)); callbacks.push(callback); } });
    const channel = new MxcExtensionChannel(new PassThrough(), output, GENERATION, KEY, "host");
    const data = Array.from({ length: 4 }, (_unused, index) => Buffer.alloc(MXC_STREAM_CHUNK_BYTES, index).toString("base64"));
    const writes = data.map((chunk) => channel.send({ type: "stdin", data: chunk }));
    await expect(channel.send({ type: "stop" })).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(packets).toHaveLength(1);
    for (const write of writes) {
      callbacks.shift()!(); await write;
      await Promise.resolve();
    }
    const decoder = new MxcFrameDecoder(GENERATION, KEY, "host");
    expect(packets.flatMap((packet) => [...decoder.read(packet)])).toEqual(data.map((chunk, sequence) => ({
      type: "stdin", data: chunk, version: 1, generation: GENERATION, sequence,
    })));
    await channel.end();
  });

  it("throws synchronously on an invalid shell frame and keeps the channel open with its sequence assigned", async () => {
    const packets: Buffer[] = [];
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) { packets.push(Buffer.from(chunk)); callback(); } });
    const channel = new MxcExtensionChannel(new PassThrough(), output, GENERATION, KEY, "host");
    const first = channel.send({ type: "stdin-end" });
    expect(() => {
      void channel.send({ type: "stdin", data: "invalid!" }).catch(() => {});
    }).toThrow(MxcProcessContractError);
    const last = channel.send({ type: "stop" });
    expect(packets).toHaveLength(0);
    await Promise.all([first, last]);
    // The invalid send consumes sequence 1, so inspect the framing before strict sequence validation.
    const frames = packets.map((packet) => JSON.parse(packet.toString("utf8", 4, packet.length - 32)));
    expect(frames.map(({ type, sequence }) => [type, sequence])).toEqual([["stdin-end", 0], ["stop", 2]]);
    await channel.end();
  });

  it("checks Windows extension admission just before writing and preserves the sequence on refusal", async () => {
    const order: string[] = [];
    const packets: Buffer[] = [];
    const firstWrite = deferred<void>();
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        packets.push(Buffer.from(chunk));
        order.push("write");
        if (packets.length === 1) { void firstWrite.promise.then(() => callback()); }
        else callback();
      },
    });
    const channel = new MxcExtensionChannel(new PassThrough(), output, GENERATION, KEY, "host", "windows-extension");
    const error = new MxcProcessContractError("Admission refused");
    const refuse = vi.fn(() => { order.push("refuse"); throw error; });
    const first = channel.send({ type: "stdin-end" });
    const refused = expect(channel.send({ type: "spawn-authorized" }, refuse)).rejects.toBe(error);
    const last = channel.send({ type: "stop" }, () => { order.push("admit"); });
    await Promise.resolve();
    expect(order).toEqual(["write"]);
    firstWrite.resolve();
    await Promise.all([first, refused, last]);
    expect(order).toEqual(["write", "refuse", "admit", "write"]);
    const decoder = new MxcFrameDecoder(GENERATION, KEY, "host", "windows-extension");
    const frames = packets.flatMap((packet) => [...decoder.read(packet)]);
    expect(frames.map(({ type, sequence }) => [type, sequence])).toEqual([["stdin-end", 0], ["stop", 1]]);
    await channel.end();
  });
});

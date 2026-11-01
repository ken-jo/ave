import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
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
    const writes = Array.from({ length: 4 }, () => channel.send({ type: "stdin", data: Buffer.alloc(MXC_STREAM_CHUNK_BYTES).toString("base64") }));
    await expect(channel.send({ type: "stop" })).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(packets).toHaveLength(1);
    for (const write of writes) {
      callbacks.shift()!(); await write;
      await Promise.resolve();
    }
    const decoder = new MxcFrameDecoder(GENERATION, KEY, "host");
    expect(packets.flatMap((packet) => [...decoder.read(packet)])).toHaveLength(4);
    await channel.end();
  });
});

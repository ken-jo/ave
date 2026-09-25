/**
 * The frame bound on the plugin channel, in both directions.
 *
 * Each end reads the other's stdout into a buffer the other end fills. Without
 * a bound, a peer that never writes 0x0A grows that buffer until the reader
 * runs out of memory — on the host side, the Electron main process. The bound
 * is {@link FRAME_BYTES_MAX}, derived from the payload limit, and crossing it
 * ends the channel from whichever side saw it.
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { frameMessage } from "../../../mcp/stdio-framing.js";
import { FramedMessageStream } from "../child-stream-multiplex.js";
import { FRAME_BYTES_MAX, WIRE_BYTES_MAX } from "../host-api-wire.js";
import { PluginChildTransport, type ChildLink } from "../plugin-child-transport.js";
import { servePluginChild } from "../plugin-child-main.js";

/** Let queued stream events drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A JSON object line of exactly `bytes` bytes, newline excluded. */
function lineOf(bytes: number): Buffer {
  const shell = '{"s":""}';
  return Buffer.from(`{"s":"${"x".repeat(bytes - shell.length)}"}\n`, "utf-8");
}

describe("the frame bound", () => {
  it("holds the largest frame the protocol produces: a payload at the limit, twice", () => {
    // A `tools/call` result carries the plugin's value as text content AND as
    // the raw result, so a value at the payload limit crosses twice.
    const encoded = Buffer.alloc(WIRE_BYTES_MAX, 0xff).toString("base64");
    const frame = frameMessage({
      jsonrpc: "2.0",
      id: "00000000-0000-4000-8000-000000000000",
      result: {
        content: [{ type: "text", text: encoded }],
        _meta: { "ave/rawResult": { encoding: "base64", data: encoded } },
      },
    });
    expect(frame.length - 1).toBeLessThanOrEqual(FRAME_BYTES_MAX);
  });

  it("delivers a line exactly at the bound", async () => {
    const input = new PassThrough();
    const messages: unknown[] = [];
    const violations: string[] = [];
    new FramedMessageStream(input, new PassThrough(), (message) => messages.push(message), (reason) =>
      violations.push(reason),
    ).start();
    input.write(lineOf(FRAME_BYTES_MAX));
    await settle();
    expect(messages).toHaveLength(1);
    expect(violations).toEqual([]);
  });

  it("reports a line past the bound once, and stops reading", async () => {
    const input = new PassThrough();
    const messages: unknown[] = [];
    const violations: string[] = [];
    new FramedMessageStream(input, new PassThrough(), (message) => messages.push(message), (reason) =>
      violations.push(reason),
    ).start();
    input.write(Buffer.alloc(FRAME_BYTES_MAX + 1, 0x78));
    await settle();
    input.write(frameMessage({ jsonrpc: "2.0", id: 1, result: null }));
    await settle();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(new RegExp(`exceeded ${FRAME_BYTES_MAX} bytes`));
    // Nothing after the overflow is read: it cannot be trusted to start on a
    // line boundary.
    expect(messages).toEqual([]);
  });
});

describe("the host, reading a child that breaks the bound", () => {
  it("kills the child and fails what was waiting on it", async () => {
    const childStdout = new PassThrough();
    const terminated: string[] = [];
    const link: ChildLink = {
      input: childStdout,
      output: new PassThrough(),
      terminate: (reason) => void terminated.push(reason),
      onGone: () => undefined,
    };
    const transport = new PluginChildTransport({
      pluginId: "boundprobe",
      generationId: "generation-1",
      isActive: () => true,
      log: () => undefined,
      link,
    });
    transport.start();
    const pending = transport.request("ave/instance/start", {});
    childStdout.write(Buffer.alloc(FRAME_BYTES_MAX + 1, 0x78));
    await expect(pending).rejects.toThrow(/exceeded .* bytes/);
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatch(/\[plugin-child-transport\] .*exceeded/);
  });
});

describe("the child, reading a host that breaks the bound", () => {
  it("ends its stdin, which is how the process leaves when the host is gone", async () => {
    const hostToChild = new PassThrough();
    servePluginChild(hostToChild, new PassThrough());
    hostToChild.write(Buffer.alloc(FRAME_BYTES_MAX + 1, 0x78));
    await settle();
    expect(hostToChild.destroyed).toBe(true);
  });
});

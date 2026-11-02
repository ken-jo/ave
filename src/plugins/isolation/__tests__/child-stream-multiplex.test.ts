/** Bound frames in both directions; a peer withholding newline must not grow the reader indefinitely. */
import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { frameMessage } from "../../../mcp/stdio-framing.js";
import { RAW_RESULT_META } from "../../../mcp/protocol-constants.js";
import { FramedMessageStream, OUTBOUND_QUEUE_BYTES_MAX } from "../child-stream-multiplex.js";
import { FRAME_BYTES_MAX, WIRE_BYTES_MAX } from "../host-api-wire.js";
import { PluginChildTransport, type ChildLink } from "../plugin-child-transport.js";
import { servePluginChild } from "../plugin-child-main.js";
import { settleMacrotask as settle } from "../../../__tests__/test-helpers.js";

function lineOf(bytes: number): Buffer {
  const shell = '{"s":""}';
  return Buffer.from(`{"s":"${"x".repeat(bytes - shell.length)}"}\n`, "utf-8");
}

describe("the frame bound", () => {
  it("bounds queued output for a peer that never drains and stops both directions", () => {
    const input = new PassThrough();
    const output = new Writable({ write() { /* deliberately retain the first write */ } });
    const violations: string[] = [];
    const received: unknown[] = [];
    const stream = new FramedMessageStream(input, output, (message) => received.push(message),
      (reason) => violations.push(reason), () => {});
    stream.start();
    const message = { jsonrpc: "2.0", id: "large", result: "x".repeat(FRAME_BYTES_MAX - 100) };
    for (let index = 0; index < 10; index++) stream.send(message);
    const queued = output.writableLength;
    expect(queued).toBeLessThanOrEqual(OUTBOUND_QUEUE_BYTES_MAX);
    expect(violations).toEqual(["Plugin output queue exceeds limit"]);
    stream.forward(frameMessage({ id: 1, result: null }));
    expect(output.writableLength).toBe(queued);
    input.write(frameMessage({ id: 2, method: "ave/host/logEvent", params: {} }));
    expect(received).toEqual([]);
    input.destroy(); output.destroy();
  });

  it("queues two maximal frames plus the headroom exactly, and refuses one byte more", () => {
    const input = new PassThrough();
    const output = new Writable({ write() { /* never drains */ } });
    const violations: string[] = [];
    const stream = new FramedMessageStream(input, output, () => {}, (reason) => violations.push(reason), () => {});
    stream.start();
    const maximal = lineOf(FRAME_BYTES_MAX);
    expect(maximal.length).toBe(FRAME_BYTES_MAX + 1);
    stream.forward(maximal); stream.forward(maximal);
    const headroom = OUTBOUND_QUEUE_BYTES_MAX - 2 * (FRAME_BYTES_MAX + 1);
    expect(headroom).toBe(8 * 1024 * 1024);
    stream.forward(lineOf(headroom - 1));
    expect(output.writableLength).toBe(OUTBOUND_QUEUE_BYTES_MAX);
    expect(violations).toEqual([]);
    stream.forward(Buffer.from("{}\n"));
    expect(violations).toEqual(["Plugin output queue exceeds limit"]);
    expect(output.writableLength).toBe(OUTBOUND_QUEUE_BYTES_MAX);
    expect(OUTBOUND_QUEUE_BYTES_MAX).toBeLessThan(4 * (FRAME_BYTES_MAX + 1));
    input.destroy(); output.destroy();
  });

  it("paces a burst of maximal frames so the queue holds one at a time and the bound is never reached", async () => {
    const input = new PassThrough();
    const held: Array<() => void> = [];
    const delivered: number[] = [];
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
      held.push(() => { delivered.push(chunk.length); callback(); });
    } });
    const violations: string[] = [];
    const stream = new FramedMessageStream(input, output, () => {}, (reason) => violations.push(reason), () => {});
    stream.start();
    // The child's MCP sink: three results finishing together exceed the bound unless they are paced.
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { stream.forwardPaced(chunk, () => callback()); } });
    const maximal = lineOf(FRAME_BYTES_MAX);
    expect(3 * maximal.length).toBeGreaterThan(OUTBOUND_QUEUE_BYTES_MAX);
    for (let index = 0; index < 3; index++) sink.write(maximal);
    let peak = 0;
    while (delivered.length < 3) {
      await settle();
      peak = Math.max(peak, output.writableLength);
      held.shift()?.();
    }
    expect(delivered).toEqual([maximal.length, maximal.length, maximal.length]);
    expect(peak).toBeLessThanOrEqual(maximal.length);
    expect(violations).toEqual([]);
    input.destroy(); output.destroy(); sink.destroy();
  });

  it("delivers large frames across a slow writable in order", async () => {
    const messages: unknown[] = [];
    const input = new PassThrough();
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
      setImmediate(() => { input.write(chunk); callback(); });
    } });
    const violations: string[] = [];
    const stream = new FramedMessageStream(input, output, (message) => messages.push(message),
      (reason) => violations.push(reason), () => {});
    stream.start();
    const frames = Array.from({ length: 3 }, (_, id) => ({ id, result: "한".repeat(256 * 1024) }));
    for (const frame of frames) stream.send(frame);
    await new Promise<void>((resolve) => output.end(resolve));
    expect(messages).toEqual(frames); expect(violations).toEqual([]);
    input.destroy();
  });
  it("holds the largest frame the protocol produces: a payload at the limit, twice", () => {
    // Tool results carry both text and raw values; a payload-sized string can cross twice.
    const encoded = Buffer.alloc(WIRE_BYTES_MAX, 0xff).toString("base64");
    const frame = frameMessage({
      jsonrpc: "2.0",
      id: "00000000-0000-4000-8000-000000000000",
      result: {
        content: [{ type: "text", text: encoded }],
        _meta: { [RAW_RESULT_META]: encoded },
      },
    });
    expect(frame.length - 1).toBeLessThanOrEqual(FRAME_BYTES_MAX);
  });

  it("delivers a line exactly at the bound", async () => {
    const input = new PassThrough();
    const messages: unknown[] = [];
    const violations: string[] = [];
    new FramedMessageStream(input, new PassThrough(), (message) => messages.push(message), (reason) =>
      violations.push(reason), () => {},
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
      violations.push(reason), () => {},
    ).start();
    input.write(Buffer.alloc(FRAME_BYTES_MAX + 1, 0x78));
    await settle();
    input.write(frameMessage({ jsonrpc: "2.0", id: 1, result: null }));
    await settle();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(new RegExp(`exceeded ${FRAME_BYTES_MAX} bytes`));
    // Discard everything after overflow because no remaining line boundary can be trusted.
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
      onFault: () => undefined,
    };
    const transport = new PluginChildTransport({
      pluginId: "boundprobe",
      isActive: () => true,
      log: () => undefined,
      reportUnknownField: () => undefined,
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

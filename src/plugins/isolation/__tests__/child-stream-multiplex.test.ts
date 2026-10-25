/** Bound frames in both directions; a peer withholding newline must not grow the reader indefinitely. */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { frameMessage } from "../../../mcp/stdio-framing.js";
import { RAW_RESULT_META } from "../../../mcp/protocol-constants.js";
import { FramedMessageStream } from "../child-stream-multiplex.js";
import { FRAME_BYTES_MAX, WIRE_BYTES_MAX } from "../host-api-wire.js";
import { PluginChildTransport, type ChildLink } from "../plugin-child-transport.js";
import { servePluginChild } from "../plugin-child-main.js";
import { settleMacrotask as settle } from "../../../__tests__/test-helpers.js";

function lineOf(bytes: number): Buffer {
  const shell = '{"s":""}';
  return Buffer.from(`{"s":"${"x".repeat(bytes - shell.length)}"}\n`, "utf-8");
}

describe("the frame bound", () => {
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

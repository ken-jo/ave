import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { frameMessage, StdioFrameDecoder, StdioFrameOverflowError } from "../stdio-framing.js";
import { nextFramedMessage as nextResponse } from "./test-helpers.js";
import { StdioServerLoop, type StdioRequestHandler } from "../experimental/stdio-server-loop.js";
import { PluginMcpServer, type PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";

const MANIFEST: PluginManifest = {
  id: "com.example.fs",
  name: "FS",
  version: "1.0.0",
  entry: "dist/p.js",
  description: "files",
  tools: ["fs_read"],
  toolSchemas: {
    fs_read: {
      description: "Read a file",
      category: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
} as PluginManifest;

const RC_META = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };

const LINE_MAX = 1024 * 1024;

describe("stdio-framing", () => {
  it("round-trips a message through frame → decode (byte-accurate)", () => {
    const decoder = new StdioFrameDecoder(LINE_MAX);
    const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: { s: "유니코드 🚀" } };
    const out = decoder.push(frameMessage(msg));
    expect(out).toEqual([msg]);
  });

  it("frames a message as its JSON text plus one 0x0A, with no header", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: { s: "line one\nline two" } };
    const framed = frameMessage(msg);
    expect(framed.equals(Buffer.from(`${JSON.stringify(msg)}\n`, "utf-8"))).toBe(true);
    // The embedded newline is escaped by JSON, so the delimiter is the only 0x0A.
    expect(framed.indexOf(0x0a)).toBe(framed.length - 1);
  });

  it("buffers a frame split across chunks, then yields it whole", () => {
    const decoder = new StdioFrameDecoder(LINE_MAX);
    const framed = frameMessage({ jsonrpc: "2.0", id: 7, method: "m" });
    expect(decoder.push(framed.subarray(0, 10))).toEqual([]);
    expect(decoder.push(framed.subarray(10))).toEqual([{ jsonrpc: "2.0", id: 7, method: "m" }]);
  });

  it("decodes a hand-written newline stream whose multi-byte character is split across chunks", () => {
    const decoder = new StdioFrameDecoder(LINE_MAX);
    const stream = Buffer.from('{"jsonrpc":"2.0","id":3,"method":"m","params":{"s":"한"}}\n', "utf-8");
    // Split a UTF-8 code point across chunks to catch premature decoding.
    const cut = stream.indexOf(Buffer.from("한", "utf-8")) + 1;
    expect(decoder.push(stream.subarray(0, cut))).toEqual([]);
    expect(decoder.push(stream.subarray(cut))).toEqual([
      { jsonrpc: "2.0", id: 3, method: "m", params: { s: "한" } },
    ]);
  });

  it("yields multiple frames arriving in one chunk", () => {
    const decoder = new StdioFrameDecoder(LINE_MAX);
    const both = Buffer.concat([
      frameMessage({ jsonrpc: "2.0", id: 1, method: "a" }),
      frameMessage({ jsonrpc: "2.0", id: 2, method: "b" }),
    ]);
    expect(decoder.push(both).map((m) => m.id)).toEqual([1, 2]);
  });

  it("decodes a line ended CRLF, as a peer on Windows may write it", () => {
    const decoder = new StdioFrameDecoder(LINE_MAX);
    expect(decoder.push(Buffer.from('{"id":1}\r\n', "utf-8"))).toEqual([{ id: 1 }]);
  });

  it("reassembles one frame delivered as many 7-byte chunks", () => {
    const decoder = new StdioFrameDecoder(LINE_MAX);
    const msg = { jsonrpc: "2.0", id: 11, method: "m", params: { s: "조각난 프레임 🚀" } };
    const framed = frameMessage(msg);
    const out: Array<Record<string, unknown>> = [];
    for (let at = 0; at < framed.length; at += 7) out.push(...decoder.push(framed.subarray(at, at + 7)));
    expect(out).toEqual([msg]);
    expect(decoder.pendingBytes).toBe(0);
  });

  describe("the line bound", () => {
    const CAP = 64;
    const lineOf = (bytes: number): string => {
      const shell = '{"s":""}';
      return `{"s":"${"x".repeat(bytes - shell.length)}"}`;
    };

    it("decodes a line exactly at the bound", () => {
      const decoder = new StdioFrameDecoder(CAP);
      const line = lineOf(CAP);
      expect(Buffer.byteLength(line)).toBe(CAP);
      expect(decoder.push(Buffer.from(`${line}\n`))).toHaveLength(1);
    });

    it("throws once an unended line passes the bound, and keeps throwing", () => {
      const decoder = new StdioFrameDecoder(CAP);
      expect(decoder.push(Buffer.alloc(CAP, 0x78))).toEqual([]);
      expect(decoder.pendingBytes).toBe(CAP);
      // Exceed the line cap without a delimiter to verify early overflow rejection.
      expect(() => decoder.push(Buffer.from("x"))).toThrow(StdioFrameOverflowError);
      expect(() => decoder.push(frameMessage({ id: 1 }))).toThrow(StdioFrameOverflowError);
      expect(decoder.pendingBytes).toBe(0);
    });

    it("throws for an over-long line even when its newline arrived in the same chunk", () => {
      const decoder = new StdioFrameDecoder(CAP);
      expect(() => decoder.push(Buffer.from(`${lineOf(CAP + 1)}\n`))).toThrow(StdioFrameOverflowError);
    });

    it("copies each byte of a long line once, however many chunks it arrives in", () => {
      // Count copied bytes to catch quadratic chunk joining without timing-dependent assertions.
      const lineBytes = 1024 * 1024;
      const chunkBytes = 4096;
      const decoder = new StdioFrameDecoder(lineBytes);
      const concat = vi.spyOn(Buffer, "concat");
      try {
        const line = Buffer.from(`${lineOf(lineBytes)}\n`);
        const decoded: Array<Record<string, unknown>> = [];
        for (let offset = 0; offset < line.length; offset += chunkBytes) {
          decoded.push(...decoder.push(line.subarray(offset, offset + chunkBytes)));
        }
        expect(decoded).toHaveLength(1);
        const copied = concat.mock.calls.reduce(
          (total, [list]) => total + list.reduce((sum, part) => sum + part.length, 0),
          0,
        );
        expect(copied).toBeLessThanOrEqual(lineBytes);
      } finally {
        concat.mockRestore();
      }
    });

    it("refuses a bound that is not a positive integer", () => {
      expect(() => new StdioFrameDecoder(0)).toThrow(RangeError);
      expect(() => new StdioFrameDecoder(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });
  });

  it("skips a line that is not a JSON object without throwing and recovers on the next line", () => {
    const decoder = new StdioFrameDecoder(LINE_MAX);
    const bad = Buffer.from('{x{\n[1,2]\n"text"\n\nContent-Length: 3\r\n\r\n', "utf-8");
    const good = frameMessage({ jsonrpc: "2.0", id: 9, method: "ok" });
    expect(decoder.push(Buffer.concat([bad, good])).map((m) => m.id)).toEqual([9]);
  });
});

describe("StdioServerLoop — subprocess serving core over real streams", () => {
  function wire(handler: PluginToolDelegate | StdioRequestHandler) {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = typeof handler === "function" ? new PluginMcpServer(MANIFEST, handler) : handler;
    new StdioServerLoop(clientToServer, serverToClient, server, LINE_MAX).start();
    return { clientToServer, serverToClient };
  }

  it("answers server/discover over framed stdio", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "x" }] });
    const { clientToServer, serverToClient } = wire(delegate);

    const pending = nextResponse(serverToClient);
    clientToServer.write(frameMessage({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { ...RC_META } }));

    const res = await pending;
    expect(res.id).toBe(1);
    expect((res.result as { serverInfo: { name: string } }).serverInfo.name).toBe("FS");
  });

  it("dispatches tools/call to the delegate and frames the result", async () => {
    const delegate = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      content: [{ type: "text", text: `read ${(args as { path: string }).path}` }],
    }));
    const { clientToServer, serverToClient } = wire(delegate);

    const pending = nextResponse(serverToClient);
    clientToServer.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fs_read", arguments: { path: "/etc/hosts" }, ...RC_META },
      }),
    );

    const res = await pending;
    expect(delegate).toHaveBeenCalledWith("fs_read", { path: "/etc/hosts" });
    expect(res.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "read /etc/hosts" }],
    });
  });

  it("a thrown handler becomes a JSON-RPC internal-error response, loop survives", async () => {
    const handler: StdioRequestHandler = {
      handle: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    };
    const { clientToServer, serverToClient } = wire(handler);

    const pending = nextResponse(serverToClient);
    clientToServer.write(frameMessage({ jsonrpc: "2.0", id: 5, method: "tools/list" }));

    const res = await pending;
    expect(res.id).toBe(5);
    expect((res.error as { code: number; message: string }).code).toBe(-32603);
    expect((res.error as { message: string }).message).toBe("kaboom");
  });

  it("rejects double start", () => {
    const loop = new StdioServerLoop(
      new PassThrough(),
      new PassThrough(),
      { handle: async () => ({ jsonrpc: "2.0", id: 0, result: {} }) },
      LINE_MAX,
    );
    loop.start();
    expect(() => loop.start()).toThrow(/already started/);
  });
});

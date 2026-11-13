import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAppBridge, type McpAppBridgeDeps } from "../mcp-app-bridge.js";
import type { BridgeWebviewElement } from "../webview-ipc-transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const REQUESTS = [
  ["serverResources", "resources/read", { uri: "ui://cards/other" }],
  ["serverTools", "tools/call", { name: "status", arguments: {} }],
  ["message", "ui/message", { role: "user", content: [{ type: "text", text: "draft" }] }],
  ["updateModelContext", "ui/update-model-context", { structuredContent: { selected: 1 } }],
  ["downloadFile", "ui/download-file", { contents: [{ type: "resource", resource: { uri: "file:///report.txt", text: "report", mimeType: "text/plain" } }] }],
  ["openLinks", "ui/open-link", { url: "https://example.com" }],
] as const;

afterEach(() => vi.unstubAllGlobals());

async function connect(declaration?: unknown) {
  const readUiResource = vi.fn(async () => ({ html: "<p>other</p>" }));
  vi.stubGlobal("ave", { mcp: { readUiResource } });
  window.ave = (globalThis as unknown as { ave: Window["ave"] }).ave;
  const deps: McpAppBridgeDeps = {
    onResize: vi.fn(),
    openLink: vi.fn(async () => ({ ok: true })),
    callTool: vi.fn(async () => ({ ok: true, result: "status" } as const)),
    postMessage: vi.fn(async () => ({ ok: true, disposition: "queued" } as const)),
    getDisplayMode: () => "inline",
    applyDisplayMode: async () => "inline",
    downloadFile: vi.fn(async () => ({ ok: true, disposition: "saved" } as const)),
    updateModelContext: vi.fn(async () => ({ ok: true, disposition: "stored" } as const)),
  };
  const send = vi.fn();
  const element: BridgeWebviewElement = { send, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const { transport, connected } = createMcpAppBridge({ serverId: "cards" }, "<p>card</p>", element, {}, deps, declaration);
  await connected;
  let nextId = 0;
  async function request(method: string, params: unknown) {
    const id = ++nextId;
    transport.onmessage?.({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    const response = () => send.mock.calls.map(([, frame]) => frame).find((frame) => frame.id === id);
    await vi.waitFor(() => expect(response()).toBeDefined());
    return response();
  }
  const initialized = await request("ui/initialize", {
    protocolVersion: "2026-01-26", appInfo: { name: "cards", version: "1.0.0" }, appCapabilities: {},
  });
  transport.onmessage?.({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  return { deps, readUiResource, request, transport, capabilities: initialized.result.hostCapabilities };
}

describe("resource host capabilities at request dispatch", () => {
  it.each([undefined, [], null, "serverTools", { serverTools: {} }, ["serverTools", null]])("denies raw privileged requests for an undeclared or malformed resource: %j", async (declaration) => {
    const card = await connect(declaration);
    try {
      expect(card.capabilities).toEqual({});
      for (const [, method, params] of REQUESTS) {
        expect(await card.request(method, params)).toMatchObject({ error: { code: -32601 } });
      }
      for (const sink of [card.readUiResource, card.deps.callTool, card.deps.postMessage, card.deps.updateModelContext, card.deps.downloadFile, card.deps.openLink]) {
        expect(sink).not.toHaveBeenCalled();
      }
      expect(await card.request("ping", {})).toMatchObject({ result: {} });
      expect(await card.request("ui/request-display-mode", { mode: "inline" })).toMatchObject({ result: { mode: "inline" } });
    } finally {
      await card.transport.close();
    }
  });

  it.each(REQUESTS)("dispatches only the declared %s operation", async (capability, method, params) => {
    const card = await connect([capability]);
    try {
      expect(Object.keys(card.capabilities)).toEqual([capability]);
      expect(await card.request(method, params)).toHaveProperty("result");
      for (const [other, deniedMethod, deniedParams] of REQUESTS) {
        if (other !== capability) expect(await card.request(deniedMethod, deniedParams)).toMatchObject({ error: { code: -32601 } });
      }
    } finally {
      await card.transport.close();
    }
  });

  it("cannot acquire unsupported operations or another card's handlers by over-declaring", async () => {
    const first = await connect(["serverTools", "sampling", "logging", "__proto__", "serverTools"]);
    const second = await connect(["message"]);
    try {
      expect(first.capabilities).toEqual({ serverTools: {} });
      expect(second.capabilities).toEqual({ message: { text: {} } });
      expect(await first.request("sampling/createMessage", {})).toMatchObject({ error: { code: -32601 } });
      expect(await first.request("ui/message", REQUESTS[2][2])).toMatchObject({ error: { code: -32601 } });
      expect(await second.request("tools/call", REQUESTS[1][2])).toMatchObject({ error: { code: -32601 } });
      expect(await first.request("tools/call", REQUESTS[1][2])).toMatchObject({ result: { content: [{ type: "text", text: "status" }] } });
      expect(first.deps.callTool).toHaveBeenCalledExactlyOnceWith("status", {});
      expect(second.deps.callTool).not.toHaveBeenCalled();
    } finally {
      await first.transport.close();
      await second.transport.close();
    }
  });
});

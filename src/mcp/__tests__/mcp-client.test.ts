/** Transport tests replace network and process I/O while preserving handshake and framing boundaries. */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { PassThrough } from "node:stream";
import { getAveAppVersion } from "../../shared/app-version.js";
import { EventEmitter } from "node:events";

/** Read the fetch stub at call time so per-test replacements affect the injected HTTP transport. */
const stubbedGlobalNetworkFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  globalThis.fetch(input, init)) as typeof fetch;

type LookupResult = { address: string; family: number };
const lookupMock = vi.fn<
  (host: string, opts: unknown) => Promise<LookupResult[]>
>();
vi.mock("node:dns", () => ({
  promises: {
    lookup: (host: string, opts: unknown) => lookupMock(host, opts),
  },
}));

const spawnMock = vi.fn<
  (cmd: string, args?: readonly string[], opts?: unknown) => unknown
>();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args?: readonly string[], opts?: unknown) =>
    spawnMock(cmd, args, opts),
}));
vi.mock("../../main/uv-runtime.js", () => ({
  resolveBundledUvBinaryPath: vi.fn(() => "/test-runtime/uv"),
}));

// Import after mocks so transport bindings use the test doubles.
import { McpClient } from "../mcp-client.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  MCP_RESOURCE_MAX_CHARS,
  MCP_RESOURCE_MAX_PER_SERVER,
} from "../../shared/mcp-resource-bounds.js";
import type {
  McpGovernancePolicy,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "../types.js";
import {
  governanceWithPolicy,
  stdioApproval,
  buildPolicy,
  FakeChildProcess,
} from "./test-helpers.js";

function httpApproval(
  id: string,
  url: string,
  overrides: Partial<McpGovernancePolicy["servers"][number]> = {},
): McpGovernancePolicy["servers"][number] {
  return {
    id,
    name: id,
    status: "approved",
    transport: "http",
    allowedUrls: [new URL(url).hostname],
    requiredAuth: "none",
    tlsRequired: false,
    allowedCapabilities: ["tools"],
    maxTools: 16,
    toolNamePrefix: id,
    connectionTimeoutMs: 5_000,
    maxConcurrentRequests: 4,
    ...overrides,
  };
}


function readRpcField<T>(init: RequestInit | undefined, field: string): T | undefined {
  if (!init?.body) return undefined;
  try {
    return JSON.parse(String(init.body))[field] as T;
  } catch {
    return undefined;
  }
}

const readRpcMethod = (init: RequestInit | undefined) => readRpcField<string>(init, "method");
const readRpcId = (init: RequestInit | undefined) => readRpcField<number>(init, "id");

function jsonRpcResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Stateless discovery fixture; omitted resultType means complete. */
const RC_DISCOVER_RESULT = {
  resultType: "complete",
  ttlMs: 0,
  cacheScope: "public" as const,
  supportedVersions: ["2026-07-28"],
  capabilities: { tools: {} },
  serverInfo: { name: "rc-mcp", version: "1.0.0" },
};

function jsonRpcErrorResponse(id: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const readRpcParams = (init: RequestInit | undefined) =>
  readRpcField<Record<string, unknown>>(init, "params");

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  lookupMock.mockReset();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Fake client timers only; fetch stubs and SSE bodies settle through promises. */
function fakeClientTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

describe("McpServerConfig discriminated union", () => {
  it("accepts a stdio config with command/args", () => {
    const cfg: McpServerConfig = {
      id: "fs",
      transport: "stdio",
      command: "ave-mcp-fs",
      args: ["--root", "/tmp"],
      env: { NODE_ENV: "production" },
    };
    expect(cfg.transport).toBe("stdio");
    if (cfg.transport === "stdio") {
      expect(cfg.command).toBe("ave-mcp-fs");
    }
  });

  it("accepts an http config with url/headers", () => {
    const cfg: McpServerConfig = {
      id: "hr",
      transport: "http",
      url: "https://api.example.com/mcp",
      headers: { "x-tenant": "example" },
    };
    expect(cfg.transport).toBe("http");
    if (cfg.transport === "http") {
      expect(cfg.url).toBe("https://api.example.com/mcp");
      expect(cfg.headers?.["x-tenant"]).toBe("example");
    }
  });

  it("accepts allowPrivateNetworks escape hatch on http", () => {
    const cfg: McpHttpServerConfig = {
      id: "onprem",
      transport: "http",
      url: "http://10.0.0.5/mcp",
      allowPrivateNetworks: true,
    };
    expect(cfg.allowPrivateNetworks).toBe(true);
  });
});

describe("HttpTransport — happy path", () => {
  it("performs initialize → tools/list → tools/call over JSON responses", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        switch (method) {
          case "server/discover":
            return jsonRpcResponse(id, RC_DISCOVER_RESULT);
          case "initialize":
            return jsonRpcResponse(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "hr-mcp", version: "1.0.0" },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpcResponse(id, {
              tools: [
                {
                  name: "query",
                  description: "Run an HR query",
                  inputSchema: {
                    type: "object",
                    properties: { q: { type: "string" } },
                    required: ["q"],
                  },
                },
              ],
            });
          case "tools/call":
            return jsonRpcResponse(id, {
              content: [{ type: "text", text: "result-ok" }],
            });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("hr", "https://api.example.com/mcp")]),
    );
    const registry = new ToolRegistry();
    const client = new McpClient(
      {
        id: "hr",
        transport: "http",
        url: "https://api.example.com/mcp",
      },
      gov,
      registry,
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    expect(client.getState().registeredTools).toEqual(["mcp_hr_query"]);

    const out = await client.callTool("query", { q: "hello" });
    expect(out).toEqual({ text: "result-ok", uiPayload: undefined });

    await client.disconnect();

    const methods = fetchMock.mock.calls
      .map(([, init]) => readRpcMethod(init as RequestInit))
      .filter(Boolean);
    expect(methods).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
  });

  it("enforces maxConcurrentRequests for overlapping tool calls", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    let resolveFirstCall: (() => void) | undefined;
    const firstCallSettled = new Promise<void>((resolve) => {
      resolveFirstCall = resolve;
    });
    let toolsCallCount = 0;

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        switch (method) {
          case "server/discover":
            return jsonRpcResponse(id, RC_DISCOVER_RESULT);
          case "initialize":
            return jsonRpcResponse(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "limited-mcp", version: "1.0.0" },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpcResponse(id, {
              tools: [
                {
                  name: "query",
                  description: "Run an HR query",
                  inputSchema: {
                    type: "object",
                    properties: { q: { type: "string" } },
                    required: ["q"],
                  },
                },
              ],
            });
          case "tools/call":
            toolsCallCount += 1;
            if (toolsCallCount === 1) {
              await firstCallSettled;
            }
            return jsonRpcResponse(id, {
              content: [{ type: "text", text: `result-${toolsCallCount}` }],
            });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("limited", "https://limited.example.com/mcp", {
          maxConcurrentRequests: 1,
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "limited",
        transport: "http",
        url: "https://limited.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await client.connect();

    const firstCall = client.callTool("query", { q: "first" });
    await Promise.resolve();

    await expect(client.callTool("query", { q: "second" })).rejects.toThrow(
      /동시 요청 제한 초과 \(1\)/,
    );

    resolveFirstCall?.();
    await expect(firstCall).resolves.toEqual({
      text: "result-1",
      uiPayload: undefined,
    });
    await client.disconnect();
  });

  it("scrubs secrets from HTTP error bodies before surfacing them", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const leakedToken = "sk-proj-secretvalue123456";
    const leakedApiKey = "topsecretapikey123456";
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({
            error: `Invalid token: ${leakedToken}`,
            next: `https://api.example.com/mcp?api_key=${leakedApiKey}`,
            header: `X-API-Key: ${leakedApiKey}`,
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("secure", "https://secure.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "secure",
        transport: "http",
        url: "https://secure.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await expect(client.connect()).rejects.toThrow(/\[REDACTED:/i);
    await expect(client.connect()).rejects.not.toThrow(leakedToken);
    await expect(client.connect()).rejects.not.toThrow(leakedApiKey);
  });

  it("sends apiKey through a configured custom HTTP header", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-browser-use-api-key")).toBe("browser-use-secret");
        expect(headers.get("authorization")).toBeNull();
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "browser-use", version: "1.0.0" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, { tools: [] });
        }
        return new Response("unexpected", { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("browser-use", "https://api.browser-use.com/v3/mcp", {
          requiredAuth: "api-key",
          apiKeyHeader: "x-browser-use-api-key",
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "browser-use",
        transport: "http",
        url: "https://api.browser-use.com/v3/mcp",
        auth: "api-key",
        apiKey: "browser-use-secret",
        apiKeyHeader: "x-browser-use-api-key",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
  });
});

describe("HttpTransport — NetworkGuard", () => {
  it("rejects a URL whose host resolves to a private IP when allowPrivateNetworks is not set", async () => {
    // DNS refusal must precede fetch even when lexical governance accepts the URL.
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("internal", "https://internal.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "internal",
        transport: "http",
        url: "https://internal.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await expect(client.connect()).rejects.toThrow(/network guard:/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getState().status).toBe("error");
  });

  it("allows a private-IP URL when allowPrivateNetworks is true and admin policy agrees", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "local", version: "0.0.1" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, { tools: [] });
        }
        return new Response("x", { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    // Both governance approval and client configuration must authorize private networking.
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("local", "http://localhost:4040/mcp", {
          allowedUrls: ["localhost"],
          allowPrivateNetworks: true,
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "local",
        transport: "http",
        url: "http://localhost:4040/mcp",
        allowPrivateNetworks: true,
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
  });

  it("rejects allowPrivateNetworks when admin policy has not authorised it", async () => {
    // Client configuration alone cannot bypass governance private-network approval.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("rogue", "http://localhost:4040/mcp", {
          allowedUrls: ["localhost"],
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "rogue",
        transport: "http",
        url: "http://localhost:4040/mcp",
        allowPrivateNetworks: true,
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await expect(client.connect()).rejects.toThrow(/allowPrivateNetworks/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getState().status).toBe("error");
  });

  it("rolls back partially registered tools when registration throws", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        switch (method) {
          case "server/discover":
            return jsonRpcResponse(id, RC_DISCOVER_RESULT);
          case "initialize":
            return jsonRpcResponse(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "rollback-mcp", version: "1.0.0" },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpcResponse(id, {
              tools: [
                {
                  name: "first",
                  description: "First tool",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
                {
                  name: "second",
                  description: "Second tool",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
              ],
            });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("rollback", "https://rollback.example.com/mcp", {
        }),
      ]),
    );
    const registry = new ToolRegistry();
    const actualRegister = registry.register.bind(registry);
    let registerCalls = 0;
    vi.spyOn(registry, "register").mockImplementation((tool) => {
      registerCalls += 1;
      if (registerCalls === 2) {
        throw new Error("simulated registration race");
      }
      return actualRegister(tool);
    });

    const client = new McpClient(
      {
        id: "rollback",
        transport: "http",
        url: "https://rollback.example.com/mcp",
      },
      gov,
      registry,
      stubbedGlobalNetworkFetch,
    );

    await expect(client.connect()).rejects.toThrow("simulated registration race");
    expect(client.getState().registeredTools).toEqual([]);
    expect(registry.listAll()).toEqual([]);
  });
});

describe("HttpTransport — SSE streaming", () => {
  it("reassembles a multi-chunk text/event-stream response", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const initResult = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "stream-mcp", version: "0.1.0" },
    };
    const initPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: initResult });

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
        if (method === "initialize") {
          const midpoint = Math.floor(initPayload.length / 2);
          const head = initPayload.slice(0, midpoint);
          const tail = initPayload.slice(midpoint);
          return sseResponse([
            "event: message\ndata: ",
            head,
            tail + "\n\n",
          ]);
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, { tools: [] });
        }
        return new Response("x", { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("stream", "https://stream.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "stream",
        transport: "http",
        url: "https://stream.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
  });
});

describe("StdioTransport — regression", () => {
  it("connects via subprocess with newline-delimited JSON-RPC", async () => {
    const fake = new FakeChildProcess();
    fake.responses = {
      "server/discover": () => RC_DISCOVER_RESULT,
      initialize: (id) => ({
        id,
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fs", version: "0.1.0" },
      }),
      "tools/list": () => ({
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      }),
      "tools/call": () => ({
        content: [{ type: "text", text: "file-contents" }],
      }),
    };
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("fs", "ave-mcp-fs")]),
    );
    const registry = new ToolRegistry();
    const client = new McpClient(
      {
        id: "fs",
        transport: "stdio",
        command: "ave-mcp-fs",
        args: ["--root", "/tmp"],
      },
      gov,
      registry,
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    expect(client.getState().registeredTools).toEqual(["mcp_fs_read"]);

    const result = await client.callTool("read", { path: "/tmp/a.txt" });
    expect(result).toEqual({ text: "file-contents", uiPayload: undefined });

    await client.disconnect();
    expect(client.getState().status).toBe("disconnected");
  });

  it("writes one JSON line per message and reads a line split across chunks, mid-character", async () => {
    const fake = new FakeChildProcess();
    fake.responses = { "server/discover": () => RC_DISCOVER_RESULT };
    const sent: string[] = [];
    const write = fake.stdin.write;
    fake.stdin.write = (chunk: string) => {
      sent.push(chunk);
      return write(chunk);
    };
    spawnMock.mockReturnValueOnce(fake);
    const client = new McpClient(
      { id: "fs", transport: "stdio", command: "ave-mcp-fs" },
      governanceWithPolicy(buildPolicy([stdioApproval("fs", "ave-mcp-fs")])),
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    const connecting = client.connect();
    await vi.waitFor(() => expect(sent.some((line) => line.includes('"tools/list"'))).toBe(true));
    // Spec: every message is a single line ending in a newline, with no header.
    for (const line of sent) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(line).not.toMatch(/^Content-Length/u);
    }
    const toolsList = JSON.parse(sent.find((line) => line.includes('"tools/list"'))!) as { id: number };
    const bytes = Buffer.from(`\r\n${JSON.stringify({
      jsonrpc: "2.0",
      id: toolsList.id,
      result: { tools: [{ name: "read", description: "파일 읽기", inputSchema: { type: "object", properties: {} } }] },
    })}\r\n`);
    const cut = bytes.indexOf(Buffer.from("파")) + 1;
    fake.stdout.write(bytes.subarray(0, cut));
    fake.stdout.write(bytes.subarray(cut));

    await connecting;
    expect(client.getState().registeredTools).toEqual(["mcp_fs_read"]);
    await client.disconnect();
  });

  it("injects apiKey into the configured stdio environment variable", async () => {
    const fake = new FakeChildProcess();
    fake.responses = {
      "server/discover": () => RC_DISCOVER_RESULT,
      initialize: (id) => ({
        id,
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "browser-use", version: "0.12.6" },
      }),
      "tools/list": () => ({ tools: [] }),
    };
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([
        stdioApproval("browser-use", "uvx", {
          requiredAuth: "api-key",
          apiKeyEnv: "OPENAI_API_KEY",
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
        auth: "api-key",
        apiKey: "openai-secret",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    expect(spawnMock).toHaveBeenCalledWith(
      "/test-runtime/uv",
      ["tool", "run", "--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_API_KEY: "openai-secret",
        }),
      }),
    );
    await client.disconnect();
  });

  it("stdio — apiKey does NOT leak into environment when apiKeyEnv is absent (HIGH-3/HIGH-4)", async () => {
    const fake = new FakeChildProcess();
    fake.responses = {
      "server/discover": () => RC_DISCOVER_RESULT,
      initialize: (id) => ({
        id,
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "no-env-key", version: "1.0" },
      }),
      "tools/list": () => ({ tools: [] }),
    };
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("no-env-key", "uvx")]),
    );
    const client = new McpClient(
      {
        id: "no-env-key",
        transport: "stdio",
        command: "uvx",
        auth: "none",
        apiKey: "secret-should-not-appear",
      } as McpStdioServerConfig,
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    const spawnEnv = (spawnMock.mock.calls[0]?.[2] as { env?: Record<string, unknown> })?.env ?? {};
    const envValues = Object.values(spawnEnv).map(String);
    expect(envValues).not.toContain("secret-should-not-appear");
    await client.disconnect();
  });

  it("SIGKILL fallback fires when the subprocess ignores SIGTERM", async () => {
    // Keep the child alive after SIGTERM to verify the delayed SIGKILL still targets it.
    vi.useFakeTimers();
    try {
      const killCalls: string[] = [];
      class StubbornChild extends EventEmitter {
        stdout = new PassThrough();
        stderr = new PassThrough();
        stdin = {
          writable: true,
          write: (_chunk: string) => true,
          end: () => {
            this.stdin.writable = false;
          },
        };
        exitCode: number | null = null;
        signalCode: NodeJS.Signals | null = null;

        kill(signal?: string): boolean {
          killCalls.push(signal ?? "SIGTERM");
          return true;
        }
      }
      const fake = new StubbornChild();
      spawnMock.mockReturnValueOnce(fake);

      const gov = governanceWithPolicy(
        buildPolicy([stdioApproval("stubborn", "ave-mcp-stubborn")]),
      );
      const client = new McpClient(
        {
          id: "stubborn",
          transport: "stdio",
          command: "ave-mcp-stubborn",
        },
        gov,
        new ToolRegistry(),
        stubbedGlobalNetworkFetch,
      );

      const connectPromise = client.connect();
      await Promise.resolve();
      const reply = (id: number, result: unknown): void => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
        fake.stdout.write(`${payload}\n`);
      };
      reply(1, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stubborn", version: "0.0.1" },
      });
      await vi.advanceTimersByTimeAsync(0);
      reply(2, { tools: [] });
      await vi.advanceTimersByTimeAsync(0);
      await connectPromise;

      const disconnectPromise = client.disconnect();
      expect(killCalls).toContain("SIGTERM");
      await vi.advanceTimersByTimeAsync(3_500);
      expect(killCalls).toContain("SIGKILL");

      fake.exitCode = 0;
      fake.emit("exit", 0, "SIGKILL");
      await disconnectPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still terminates when closing stdin throws", async () => {
    vi.useFakeTimers();
    try {
      const killCalls: string[] = [];
      class BrokenStdinChild extends EventEmitter {
        stdout = new PassThrough();
        stderr = new PassThrough();
        stdin = {
          writable: true,
          write: (_chunk: string) => true,
          end: () => {
            throw new Error("stdin already destroyed");
          },
        };
        exitCode: number | null = null;
        signalCode: NodeJS.Signals | null = null;
        kill(signal?: string): boolean {
          killCalls.push(signal ?? "SIGTERM");
          return true;
        }
      }
      const fake = new BrokenStdinChild();
      spawnMock.mockReturnValueOnce(fake);
      const client = new McpClient(
        { id: "broken-stdin", transport: "stdio", command: "ave-mcp-broken-stdin" },
        governanceWithPolicy(buildPolicy([stdioApproval("broken-stdin", "ave-mcp-broken-stdin")])),
        new ToolRegistry(),
        stubbedGlobalNetworkFetch,
      );

      const connectPromise = client.connect();
      await Promise.resolve();
      const reply = (id: number, result: unknown): void => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
        fake.stdout.write(`${payload}\n`);
      };
      reply(1, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "broken-stdin", version: "0.0.1" },
      });
      await vi.advanceTimersByTimeAsync(0);
      reply(2, { tools: [] });
      await vi.advanceTimersByTimeAsync(0);
      await connectPromise;

      await client.disconnect();
      expect(killCalls).toContain("SIGTERM");
      await vi.advanceTimersByTimeAsync(3_500);
      expect(killCalls).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("McpGovernance — header validation", () => {
  it("rejects http config whose headers contain CR/LF", async () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("inj", "https://good.example.com/mcp")]),
    );
    const result = gov.validateServer({
      id: "inj",
      transport: "http",
      url: "https://good.example.com/mcp",
      headers: {
        "x-legit": "ok",
        "x-injected": "value\r\nX-Smuggled: attacker",
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.layer).toBe(1);
      expect(result.reason).toMatch(/CR\/LF/);
    }
  });

  it("rejects http config whose header values contain raw control bytes", async () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("ctl", "https://good.example.com/mcp")]),
    );
    const result = gov.validateServer({
      id: "ctl",
      transport: "http",
      url: "https://good.example.com/mcp",
      headers: { "x-ctrl": "bad\x01value" },
    });
    expect(result.valid).toBe(false);
  });

  it("accepts http config with plain, well-formed headers", async () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("ok", "https://good.example.com/mcp")]),
    );
    const result = gov.validateServer({
      id: "ok",
      transport: "http",
      url: "https://good.example.com/mcp",
      headers: { "x-tenant": "example", authorization: "Bearer redacted" },
    });
    expect(result.valid).toBe(true);
  });
});

describe("HttpTransport — per-request DNS rebinding defense", () => {
  it("rejects a send() after DNS flips to a private IP mid-session", async () => {
    // Rebind to a private address after open to verify every send rechecks before fetch.
    lookupMock.mockImplementation(async () => {
      if (lookupMock.mock.calls.length === 1) {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "169.254.169.254", family: 4 }];
    });

    let fetchCallCount = 0;
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        fetchCallCount += 1;
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "rebind", version: "0.0.1" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, { tools: [] });
        }
        return new Response("x", { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("rebind", "https://rebind.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "rebind",
        transport: "http",
        url: "https://rebind.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await expect(client.connect()).rejects.toThrow(/network guard:/);
    expect(fetchCallCount).toBe(0);
  });
});

describe("HttpTransport — SSE stream death", () => {
  it("marks transport dead and rejects pending requests when SSE body errors out", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "dying", version: "0.1.0" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, {
            tools: [
              {
                name: "stream",
                description: "streaming tool",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
            ],
          });
        }
        const failingStream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode("event: message\ndata: {\"jsonrpc\""));
            controller.error(new Error("connection reset by peer"));
          },
        });
        return new Response(failingStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("dying", "https://dying.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "dying",
        transport: "http",
        url: "https://dying.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");

    await expect(client.callTool("stream", {})).rejects.toThrow();
    expect(client.getState().status).toBe("error");
  });
});

describe("HttpTransport — timeout path", () => {
  it("aborts the underlying fetch when the request times out", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit): Promise<Response> => {
          capturedSignal = init?.signal ?? undefined;
          // Only abort can settle this intentionally unresponsive request.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("AbortError"));
            });
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const gov = governanceWithPolicy(
        buildPolicy([httpApproval("slow", "https://slow.example.com/mcp")]),
      );
      const client = new McpClient(
        {
          id: "slow",
          transport: "http",
          url: "https://slow.example.com/mcp",
        },
        gov,
        new ToolRegistry(),
        stubbedGlobalNetworkFetch,
      );

      const connectPromise = client.connect().catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(capturedSignal?.aborted).toBe(true);
      const err = await connectPromise;
      expect(err).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("McpClient buffered response safety", () => {
  it("caps unmatched buffered responses to a bounded size", () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("buffered", "https://buffered.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "buffered",
        transport: "http",
        url: "https://buffered.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );

    for (let id = 1; id <= 256; id += 1) {
      (client as unknown as {
        handleResponse: (response: { jsonrpc: "2.0"; id: number; result: unknown }) => void;
      }).handleResponse({
        jsonrpc: "2.0",
        id,
        result: { ok: true },
      });
    }

    const buffered = (client as unknown as { bufferedResponses: Map<number, unknown> }).bufferedResponses;
    expect(buffered.size).toBeLessThanOrEqual(128);
    expect(buffered.has(1)).toBe(false);
    expect(buffered.has(256)).toBe(true);
  });
});

describe("McpClient — 2026-07-28 RC stateless handshake (#1230)", () => {
  function rcHttpClient(
    id: string,
    responder: (method: string | undefined, rid: number) => Response,
    inputResolver?: (rid: string, request: Record<string, unknown>) => Promise<unknown>,
    capabilityProvider?: () => { elicitation?: Record<string, unknown>; extensions?: Record<string, unknown> },
  ) {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = `https://api.example.com/${id}/mcp`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
      responder(readRpcMethod(init), readRpcId(init) ?? 0),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new McpClient(
      { id, transport: "http", url },
      governanceWithPolicy(buildPolicy([httpApproval(id, url)])),
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
      undefined,
      inputResolver,
      capabilityProvider,
    );
    return { client, fetchMock };
  }

  it("stamps the three reserved _meta keys + RC protocol version on every request", async () => {
    const { client, fetchMock } = rcHttpClient("rc", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    expect(client.getState().status).toBe("connected");

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      const meta = readRpcParams(init as RequestInit)?._meta as Record<string, unknown> | undefined;
      expect(meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(meta?.["io.modelcontextprotocol/clientInfo"]).toEqual({ name: "ave", version: getAveAppVersion() });
      expect(meta?.["io.modelcontextprotocol/clientCapabilities"]).toMatchObject({ elicitation: {} });
    }
    await client.disconnect();
  });

  it("opens subscriptions/listen with exactly the advertised listChanged kinds", async () => {
    const listenParams: unknown[] = [];
    const { client, fetchMock } = rcHttpClient("lsn", (method, id) => {
      if (method === "server/discover")
        return jsonRpcResponse(id, {
          ...RC_DISCOVER_RESULT,
          capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
        });
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "subscriptions/listen") return jsonRpcResponse(id, { resultType: "complete" });
      return new Response("unexpected", { status: 500 });
    });

    fakeClientTimers();
    await client.connect();
    await vi.advanceTimersByTimeAsync(150);
    for (const [, init] of fetchMock.mock.calls) {
      if (readRpcMethod(init as RequestInit) === "subscriptions/listen") {
        listenParams.push(readRpcParams(init as RequestInit)?.notifications);
      }
    }
    expect(listenParams).toEqual([{ toolsListChanged: true, promptsListChanged: true }]);
    await client.disconnect();
  });

  it("does NOT open a listen stream when the server advertises no listChanged", async () => {
    const { client, fetchMock } = rcHttpClient("nolsn", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    const methods = fetchMock.mock.calls.map(([, i]) => readRpcMethod(i as RequestInit));
    expect(methods).not.toContain("subscriptions/listen");
    await client.disconnect();
  });

  it("drives refreshes from notifications on the listen stream; a stream end is non-fatal", async () => {
    let listCalls = 0;
    const TOOL_V1 = { name: "a", description: "v1", inputSchema: { type: "object", properties: {} } };
    const TOOL_V2 = { name: "b", description: "v2", inputSchema: { type: "object", properties: {} } };
    const { client } = rcHttpClient("lsn2", (method, id) => {
      if (method === "server/discover")
        return jsonRpcResponse(id, {
          ...RC_DISCOVER_RESULT,
          capabilities: { tools: { listChanged: true } },
        });
      if (method === "tools/list") {
        listCalls += 1;
        return jsonRpcResponse(id, { tools: listCalls === 1 ? [TOOL_V1] : [TOOL_V2] });
      }
      if (method === "subscriptions/listen")
        // Ending a listen stream without a final response requires reopening, not killing the connection.
        return sseResponse([
          `data: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged"}\n\n`,
          `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`,
        ]);
      return new Response("unexpected", { status: 500 });
    });

    fakeClientTimers();
    await client.connect();
    expect(client.getState().registeredTools).toEqual(["mcp_lsn2_a"]);
    await vi.advanceTimersByTimeAsync(900);
    expect(listCalls).toBe(2);
    expect(client.getState().registeredTools).toEqual(["mcp_lsn2_b"]);
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
  });

  it("marks listen unsupported on -32601 and stops re-opening", async () => {
    let listenCalls = 0;
    const { client } = rcHttpClient("lsn3", (method, id) => {
      if (method === "server/discover")
        return jsonRpcResponse(id, {
          ...RC_DISCOVER_RESULT,
          capabilities: { tools: { listChanged: true } },
        });
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "subscriptions/listen") {
        listenCalls += 1;
        return jsonRpcErrorResponse(id, -32601, "Method not found");
      }
      return new Response("unexpected", { status: 500 });
    });

    fakeClientTimers();
    await client.connect();
    await vi.advanceTimersByTimeAsync(1300);
    expect(listenCalls).toBe(1);
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
  });

  it("lifts image blocks out of a tool result instead of rendering their base64 as text", async () => {
    const pixels = Buffer.from("not really a png").toString("base64");
    const { client } = rcHttpClient("img", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") {
        return jsonRpcResponse(id, {
          tools: [{ name: "shot", description: "shot", inputSchema: { type: "object", properties: {} } }],
        });
      }
      if (method === "tools/call") {
        return jsonRpcResponse(id, {
          resultType: "complete",
          content: [
            { type: "text", text: "captured" },
            { type: "image", data: pixels, mimeType: "image/png" },
          ],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    const result = await client.callTool("shot", {});
    expect(result.images).toEqual([{ data: pixels, mimeType: "image/png" }]);
    expect(result.text).toBe("captured\n[image 1: image/png, 16 bytes]");
    expect(result.text).not.toContain(pixels);
    await client.disconnect();
  });

  it("retries ONCE after HeaderMismatch by refreshing tools/list and rebuilding the mirrors", async () => {
    const toolWithHeader = (headerName: string) => ({
      name: "q",
      description: "q",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": headerName } },
      },
    });
    let listCalls = 0;
    let callCalls = 0;
    const { client, fetchMock } = rcHttpClient("hm", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") {
        listCalls += 1;
        return jsonRpcResponse(id, {
          tools: [toolWithHeader(listCalls === 1 ? "Region" : "Zone")],
        });
      }
      if (method === "tools/call") {
        callCalls += 1;
        if (callCalls === 1) return jsonRpcErrorResponse(id, -32020, "Header mismatch");
        return jsonRpcResponse(id, {
          resultType: "complete",
          content: [{ type: "text", text: "ok" }],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    const result = await client.callTool("q", { region: "us-west1" });
    expect(result.text).toBe("ok");
    expect(listCalls).toBe(2);
    expect(callCalls).toBe(2);
    const toolCallInits = fetchMock.mock.calls.filter(
      ([, i]) => readRpcMethod(i as RequestInit) === "tools/call",
    );
    const secondCall = toolCallInits[toolCallInits.length - 1]?.[1];
    const headers = (secondCall as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["mcp-param-zone"]).toBe("us-west1");
    expect(headers?.["mcp-param-region"]).toBeUndefined();
    await client.disconnect();
  });

  it("propagates a second HeaderMismatch instead of retrying again", async () => {
    const TOOL = {
      name: "q",
      description: "q",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": "Region" } },
      },
    };
    let callCalls = 0;
    const { client } = rcHttpClient("hm2", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [TOOL] });
      if (method === "tools/call") {
        callCalls += 1;
        return jsonRpcErrorResponse(id, -32020, "Header mismatch");
      }
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await expect(client.callTool("q", { region: "x" })).rejects.toThrow(/-32020|Header mismatch/);
    expect(callCalls).toBe(2);
    await client.disconnect();
  });

  it("re-discovers on snapshot expiry and honors the server's CURRENT advertisement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let discoverCalls = 0;
      const { client } = rcHttpClient("snap", (method, id) => {
        if (method === "server/discover") {
          discoverCalls += 1;
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            ttlMs: 1,
            capabilities:
              discoverCalls === 1
                ? { tools: {} }
                : { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
          });
        }
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
            _meta: { ui: { resourceUri: "ui://snap/card.html" } },
          });
        return new Response("unexpected", { status: 500 });
      });

      await client.connect();
      expect((await client.callTool("t", {})).uiPayload).toBeUndefined();
      expect(discoverCalls).toBe(1);

      vi.setSystemTime(Date.now() + 31_000);
      const result = await client.callTool("t", {});
      expect(discoverCalls).toBe(2);
      expect(result.uiPayload?.resourceUri).toBe("ui://snap/card.html");
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the Apps gate closed when the snapshot is expired and refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let discoverCalls = 0;
      const { client } = rcHttpClient("snapfail", (method, id) => {
        if (method === "server/discover") {
          discoverCalls += 1;
          if (discoverCalls > 1) return new Response("boom", { status: 500 });
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
          });
        }
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
            _meta: { ui: { resourceUri: "ui://snapfail/card.html" } },
          });
        return new Response("unexpected", { status: 500 });
      });

      await client.connect();
      expect((await client.callTool("t", {})).uiPayload?.resourceUri).toBe(
        "ui://snapfail/card.html",
      );

      vi.setSystemTime(Date.now() + 31_000);
      // Unrefreshable stale UI advertisements are refused while text results still flow.
      const result = await client.callTool("t", {});
      expect(result.text).toBe("ok");
      expect(result.uiPayload).toBeUndefined();
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one in-flight refresh across concurrent expired reads (single-flight)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let discoverCalls = 0;
      const { client } = rcHttpClient("snapsf", (method, id) => {
        if (method === "server/discover") {
          discoverCalls += 1;
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
          });
        }
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
          });
        return new Response("unexpected", { status: 500 });
      });

      await client.connect();
      vi.setSystemTime(Date.now() + 31_000);
      await Promise.all([client.callTool("t", {}), client.callTool("t", {})]);
      expect(discoverCalls).toBe(2);
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps the Streamable HTTP request-metadata headers on every POST (final spec)", async () => {
    const TOOL = {
      name: "get_weather",
      description: "weather",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          query: { type: "string" },
        },
      },
    };
    const { client, fetchMock } = rcHttpClient("hdr", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [TOOL] });
      if (method === "tools/call")
        return jsonRpcResponse(id, { resultType: "complete", content: [{ type: "text", text: "ok" }] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await client.callTool("get_weather", { region: "us-west1", query: "rain" });

    const headerOf = (init: unknown, name: string) =>
      ((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.[name];
    for (const [, init] of fetchMock.mock.calls) {
      const method = readRpcMethod(init as RequestInit);
      if (!method) continue;
      expect(headerOf(init, "mcp-method")).toBe(method);
      expect(headerOf(init, "mcp-protocol-version")).toBe("2026-07-28");
    }
    const callInit = fetchMock.mock.calls.find(
      ([, i]) => readRpcMethod(i as RequestInit) === "tools/call",
    )?.[1];
    expect(headerOf(callInit, "mcp-name")).toBe("get_weather");
    expect(headerOf(callInit, "mcp-param-region")).toBe("us-west1");
    expect(headerOf(callInit, "mcp-param-query")).toBeUndefined();
    await client.disconnect();
  });

  it("excludes a tool whose x-mcp-header annotations are invalid, keeping the rest", async () => {
    const BAD = {
      name: "bad_tool",
      description: "malformed annotation",
      inputSchema: {
        type: "object",
        properties: { n: { type: "number", "x-mcp-header": "N" } },
      },
    };
    const GOOD = {
      name: "good_tool",
      description: "fine",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    };
    const { client } = rcHttpClient("xh", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [BAD, GOOD] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    // Isolate malformed tools rather than dropping the complete catalog.
    expect(client.getState().registeredTools).toEqual(["mcp_xh_good_tool"]);
    await client.disconnect();
  });

  it("falls back to the legacy initialize handshake when server/discover answers -32601 (dual-era exception)", async () => {
    const { client, fetchMock } = rcHttpClient("legacy", (method, id) => {
      if (method === "server/discover") return jsonRpcErrorResponse(id, -32601, "Method not found");
      if (method === "initialize")
        return jsonRpcResponse(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "old", version: "0.9" } });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    expect(client.getState().status).toBe("connected");

    const methods = fetchMock.mock.calls.map(([, i]) => readRpcMethod(i as RequestInit)).filter(Boolean);
    expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    const initInit = fetchMock.mock.calls.find(([, i]) => readRpcMethod(i as RequestInit) === "initialize")?.[1];
    expect(readRpcParams(initInit as RequestInit)?._meta).toBeUndefined();
    await client.disconnect();
  });

  it("falls back to initialize when a session-enforcing legacy server answers the probe with a bare 400", async () => {
    // Non-modern 4xx probe responses identify legacy servers that reject requests before initialize.
    const SESSION = "sess-legacy-1";
    const { client, fetchMock } = rcHttpClient("sess", (method, id) => {
      if (method === "server/discover")
        return new Response("Bad Request: Server not initialized", { status: 400 });
      if (method === "initialize")
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "legacy-sess", version: "1.2" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": SESSION } },
        );
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    expect(client.getState().status).toBe("connected");

    const initInit = fetchMock.mock.calls.find(
      ([, i]) => readRpcMethod(i as RequestInit) === "initialize",
    )?.[1];
    expect(readRpcParams(initInit as RequestInit)?.protocolVersion).toBe("2025-03-26");
    const listInit = fetchMock.mock.calls.find(
      ([, i]) => readRpcMethod(i as RequestInit) === "tools/list",
    )?.[1];
    expect(
      ((listInit as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.[
        "mcp-session-id"
      ],
    ).toBe(SESSION);
    await client.disconnect();
  });

  it("does NOT fall back when the 400 body is a recognized modern JSON-RPC error", async () => {
    const { client } = rcHttpClient("modern400", (method, id) => {
      if (method === "server/discover")
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32022, message: "unsupported", data: { supported: ["2026-01-01"] } },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      return new Response("unexpected", { status: 500 });
    });

    // A modern probe rejection is a connection failure, never permission to initialize as legacy.
    await expect(client.connect()).rejects.toThrow(/unsupported/);
  });

  it("refuses a legacy counter-version outside the supported set", async () => {
    const { client } = rcHttpClient("oldold", (method, id) => {
      if (method === "server/discover")
        return new Response("Not Found", { status: 404 });
      if (method === "initialize")
        return jsonRpcResponse(id, {
          protocolVersion: "2019-01-01",
          capabilities: {},
          serverInfo: { name: "ancient", version: "0.1" },
        });
      return new Response("unexpected", { status: 500 });
    });

    await expect(client.connect()).rejects.toThrow(/unsupported protocol '2019-01-01'/);
  });

  it("routes an SSE-delivered tools/list_changed notification into a debounced tools refresh", async () => {
    const TOOL_V1 = {
      name: "alpha",
      description: "v1",
      inputSchema: { type: "object", properties: {} },
    };
    const TOOL_V2 = {
      name: "beta",
      description: "v2",
      inputSchema: { type: "object", properties: {} },
    };
    let listCalls = 0;
    const { client } = rcHttpClient("lc", (method, id) => {
      if (method === "server/discover")
        return jsonRpcResponse(id, {
          ...RC_DISCOVER_RESULT,
          capabilities: { tools: { listChanged: true } },
        });
      if (method === "tools/list") {
        listCalls += 1;
        return jsonRpcResponse(id, { tools: listCalls === 1 ? [TOOL_V1] : [TOOL_V2] });
      }
      if (method === "tools/call")
        // Request-scoped SSE notifications must be handled before its final response.
        return sseResponse([
          `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`,
          `data: {"jsonrpc":"2.0","id":${id},"result":{"resultType":"complete","content":[{"type":"text","text":"ok"}]}}\n\n`,
        ]);
      return new Response("unexpected", { status: 500 });
    });

    fakeClientTimers();
    await client.connect();
    expect(client.getState().registeredTools).toEqual(["mcp_lc_alpha"]);

    await client.callTool("alpha", {});
    await vi.advanceTimersByTimeAsync(900);

    expect(listCalls).toBe(2);
    expect(client.getState().registeredTools).toEqual(["mcp_lc_beta"]);
    await client.disconnect();
  });

  it("keeps the previous registration when a list_changed-driven refresh fails", async () => {
    const TOOL_V1 = {
      name: "alpha",
      description: "v1",
      inputSchema: { type: "object", properties: {} },
    };
    let listCalls = 0;
    const { client } = rcHttpClient("lcf", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") {
        listCalls += 1;
        if (listCalls === 1) return jsonRpcResponse(id, { tools: [TOOL_V1] });
        return new Response("boom", { status: 500 });
      }
      if (method === "tools/call")
        return sseResponse([
          `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`,
          `data: {"jsonrpc":"2.0","id":${id},"result":{"resultType":"complete","content":[{"type":"text","text":"ok"}]}}\n\n`,
        ]);
      return new Response("unexpected", { status: 500 });
    });

    fakeClientTimers();
    await client.connect();
    await client.callTool("alpha", {});
    await vi.advanceTimersByTimeAsync(900);

    // Failed advisory refreshes must preserve working tools.
    expect(listCalls).toBe(2);
    expect(client.getState().registeredTools).toEqual(["mcp_lcf_alpha"]);
    await client.disconnect();
  });

  it("fails closed on input_required when no MRTR resolver is wired (No-Fallback)", async () => {
    const { client } = rcHttpClient("ir", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcResponse(id, { resultType: "input_required", inputRequests: {} });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    // Without an elicitation resolver, never fabricate an input response.
    await expect(client.callTool("q", {})).rejects.toThrow(/input_required/);
    await client.disconnect();
  });

  it("MRTR loop: resolves input_required, echoes requestState verbatim, retries to complete", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const resolver = vi.fn(async (_rid: string, _request: Record<string, unknown>) => ({
      action: "accept",
      content: { token: "abc" },
    }));
    const { client, fetchMock } = rcHttpClient(
      "mrtr",
      (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call") {
          const toolCalls = calls.filter(Boolean).length;
          if (toolCalls === 0) {
            calls.push({});
            return jsonRpcResponse(id, {
              resultType: "input_required",
              inputRequests: { q1: { method: "elicitation/create", message: "need a token" } },
              requestState: "opaque-state-xyz",
            });
          }
          return jsonRpcResponse(id, { resultType: "complete", content: [{ type: "text", text: "done" }] });
        }
        return new Response("unexpected", { status: 500 });
      },
      resolver,
    );

    await client.connect();
    const out = await client.callTool("q", { a: 1 });
    expect(out.text).toBe("done");

    expect(resolver).toHaveBeenCalledWith("q1", { method: "elicitation/create", message: "need a token" });

    const toolCallInits = fetchMock.mock.calls
      .filter(([, i]) => readRpcMethod(i as RequestInit) === "tools/call")
      .map(([, i]) => readRpcParams(i as RequestInit));
    expect(toolCallInits).toHaveLength(2);
    expect(toolCallInits[1]).toMatchObject({
      name: "q",
      arguments: { a: 1 },
      inputResponses: { q1: { action: "accept", content: { token: "abc" } } },
      requestState: "opaque-state-xyz",
    });
    await client.disconnect();
  });

  it("derives clientCapabilities per request from the injected provider (governance-per-request)", async () => {
    // Elicitation capability must reflect current turn mode at each send.
    let turn = 0;
    const provider = vi.fn(() =>
      turn++ === 0
        ? { elicitation: { form: {}, url: {} }, extensions: {} }
        : { extensions: {} },
    );
    const { client, fetchMock } = rcHttpClient(
      "perreq",
      (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        return new Response("unexpected", { status: 500 });
      },
      undefined,
      provider,
    );

    await client.connect();

    const caps = fetchMock.mock.calls.map(
      ([, i]) => readRpcParams(i as RequestInit)?._meta as Record<string, unknown>,
    );
    expect(caps[0]["io.modelcontextprotocol/clientCapabilities"]).toMatchObject({ elicitation: {} });
    expect(caps[1]["io.modelcontextprotocol/clientCapabilities"]).not.toHaveProperty("elicitation");
    expect(provider).toHaveBeenCalledTimes(caps.length);
    await client.disconnect();
  });

  it("Tasks: polls a CreateTaskResult to completion and returns the completed result", async () => {
    let taskGets = 0;
    const { client } = rcHttpClient("task", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call")
        return jsonRpcResponse(id, { resultType: "task", taskId: "t1", status: "working", pollIntervalMs: 1 });
      if (method === "tasks/get") {
        taskGets += 1;
        return jsonRpcResponse(
          id,
          taskGets >= 2
            ? { resultType: "task", taskId: "t1", status: "completed", content: [{ type: "text", text: "task done" }] }
            : { resultType: "task", taskId: "t1", status: "working", pollIntervalMs: 1 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    const out = await client.callTool("q", {});
    expect(out.text).toBe("task done");
    expect(taskGets).toBeGreaterThanOrEqual(2);
    await client.disconnect();
  });

  it("Tasks: a failed task throws", async () => {
    const { client } = rcHttpClient("taskfail", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call")
        return jsonRpcResponse(id, { resultType: "task", taskId: "t2", status: "failed" });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await expect(client.callTool("q", {})).rejects.toThrow(/ended 'failed'/);
    await client.disconnect();
  });

  it("MCP Apps gate: honors _meta.ui only when the server advertised the ui extension", async () => {
    const uiResult = {
      resultType: "complete",
      content: [{ type: "text", text: "x" }],
      _meta: {
        ui: {
          resourceUri: "ui://app/p.html",
          csp: { connectSrc: ["https://api.example.com"] },
        },
      },
    };
    const discoverWithApps = {
      ...RC_DISCOVER_RESULT,
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
    };

    const withApps = rcHttpClient("apps", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, discoverWithApps);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcResponse(id, uiResult);
      return new Response("unexpected", { status: 500 });
    });
    await withApps.client.connect();
    const uiPayload = (await withApps.client.callTool("q", {})).uiPayload;
    expect(uiPayload).toMatchObject({ resourceUri: "ui://app/p.html" });
    // Read CSP only from resource metadata, never tool-result metadata or renderer input.
    expect(uiPayload).not.toHaveProperty("csp");
    await withApps.client.disconnect();

    const noApps = rcHttpClient("noapps", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcResponse(id, uiResult);
      return new Response("unexpected", { status: 500 });
    });
    await noApps.client.connect();
    expect((await noApps.client.callTool("q", {})).uiPayload).toBeUndefined();
    await noApps.client.disconnect();
  });

  it("readResource: surfaces the RESOURCE's own _meta.ui (csp/permissions), gated by advertise", async () => {
    // Only advertised Apps resource metadata may set CSP and permissions.
    const readResult = {
      contents: [
        {
          uri: "ui://app/p.html",
          mimeType: "text/html;profile=mcp-app",
          text: "<h1>app</h1>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.example.com"] },
              permissions: { clipboardWrite: {} },
            },
          },
        },
      ],
    };
    const discoverWithApps = {
      ...RC_DISCOVER_RESULT,
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
    };

    const withApps = rcHttpClient("apps-res", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, discoverWithApps);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "resources/read") return jsonRpcResponse(id, readResult);
      return new Response("unexpected", { status: 500 });
    });
    await withApps.client.connect();
    const advertised = await withApps.client.readResource("ui://app/p.html");
    // Preserve advertised wire permissions here; capability policy decides which can be granted.
    expect(advertised).toEqual({
      html: "<h1>app</h1>",
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: { clipboardWrite: {} },
    });
    await withApps.client.disconnect();

    const noApps = rcHttpClient("noapps-res", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "resources/read") return jsonRpcResponse(id, readResult);
      return new Response("unexpected", { status: 500 });
    });
    await noApps.client.connect();
    const unadvertised = await noApps.client.readResource("ui://app/p.html");
    expect(unadvertised).toEqual({ html: "<h1>app</h1>", csp: undefined, permissions: undefined });
    await noApps.client.disconnect();
  });

  it("drops a tool result's ui card when its resourceUri is unusable, keeping the text", async () => {
    // Malformed optional UI must fail closed without withholding the tool text.
    const discoverWithApps = {
      ...RC_DISCOVER_RESULT,
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
    };
    for (const [resourceUri, shouldRender] of [
      ["ui://app/card.html", true],
      ["file:///etc/passwd", false],
      ["UI://app/card.html", false],
      ["ui:///card.html", false],
      ["ui://", false],
    ] as const) {
      const { client } = rcHttpClient(`uimeta-${shouldRender}-${resourceUri.length}`, (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, discoverWithApps);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call") {
          return jsonRpcResponse(id, {
            content: [{ type: "text", text: "TOOL TEXT" }],
            _meta: { ui: { resourceUri, slot: "chat" } },
          });
        }
        return new Response("unexpected", { status: 500 });
      });
      await client.connect();
      const out = await client.callTool("t", {});
      expect(out.text, resourceUri).toBe("TOOL TEXT");
      expect(Boolean(out.uiPayload), resourceUri).toBe(shouldRender);
      await client.disconnect();
    }
  });

  it("readResource: refuses any URI that is not the Apps path, before the request", async () => {
    // Test non-ui URI refusal on a resources-approved server so governance cannot mask a missing Apps-path gate.
    let reads = 0;
    const url = "https://api.example.com/apps-scheme/mcp";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "resources/list") return jsonRpcResponse(id, { resources: [] });
      if (method === "resources/read") {
        reads += 1;
        return jsonRpcResponse(id, {
          contents: [{ uri: "ui://app/p.html", text: "<h1>app</h1>" }],
        });
      }
      return new Response("unexpected", { status: 500 });
    }));
    const client = new McpClient(
      { id: "apps-scheme", transport: "http", url },
      governanceWithPolicy(buildPolicy([httpApproval("apps-scheme", url, {
        allowedCapabilities: ["tools", "resources"] as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
      })])),
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );
    await client.connect();

    for (const uri of [
      "file:///etc/passwd",
      "file:///C:/Users/me/.ssh/id_rsa",
      "https://internal.example.com/admin",
      "doc:1",
      "UI://app/p.html",
      "ui:///p.html",
    ]) {
      await expect(client.readResource(uri), uri).rejects.toThrow(/ui:\/\/ resources only/);
    }
    expect(reads).toBe(0);

    const ok = await client.readResource("ui://app/p.html");
    expect(ok.html).toBe("<h1>app</h1>");
    expect(reads).toBe(1);
    await client.disconnect();
  });

  it("MRTR runaway guard: a server stuck on input_required fails after the round bound", async () => {
    const resolver = vi.fn(async () => ({ action: "accept" }));
    const { client } = rcHttpClient(
      "runaway",
      (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, { resultType: "input_required", inputRequests: { q: {} }, requestState: "s" });
        return new Response("unexpected", { status: 500 });
      },
      resolver,
    );

    await client.connect();
    await expect(client.callTool("q", {})).rejects.toThrow(/exceeded .* input_required rounds/);
    await client.disconnect();
  });

  it("maps a -32021 missing-required-client-capability error on a tool call", async () => {
    const { client } = rcHttpClient("mc", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcErrorResponse(id, -32021, "missing capability");
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await expect(client.callTool("q", {})).rejects.toThrow(/-32021/);
    await client.disconnect();
  });
});

describe("MCP prompts discovery", () => {
  function connectWith(opts: {
    advertisePrompts: boolean;
    approveCapabilities: string[];
    instructions?: string;
    promptPages?: Array<{ prompts: unknown[]; nextCursor?: string }>;
  }): { client: McpClient; promptsCalls: unknown[] } {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const promptsCalls: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      switch (method) {
        case "server/discover":
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: opts.advertisePrompts ? { tools: {}, prompts: {} } : { tools: {} },
            ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpcResponse(id, { tools: [] });
        case "prompts/list": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          promptsCalls.push(params);
          const page = opts.promptPages?.[promptsCalls.length - 1] ?? { prompts: [] };
          return jsonRpcResponse(id, page);
        }
        default:
          return new Response("unexpected", { status: 500 });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("psrv", "https://psrv.example.com/mcp", {
          allowedCapabilities: opts.approveCapabilities as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
        }),
      ]),
    );
    const client = new McpClient(
      { id: "psrv", transport: "http", url: "https://psrv.example.com/mcp" },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );
    return { client, promptsCalls };
  }

  it("discovers prompts + instructions when advertised AND approved", async () => {
    const { client, promptsCalls } = connectWith({
      advertisePrompts: true,
      approveCapabilities: ["tools", "prompts"],
      instructions: "Use the review prompt for PRs.",
      promptPages: [
        {
          prompts: [
            { name: "code_review", description: "Review a diff", arguments: [{ name: "diff", required: true }] },
          ],
        },
      ],
    });
    await client.connect();
    expect(promptsCalls).toHaveLength(1);
    expect(client.getState().prompts).toEqual([
      {
        name: "code_review",
        title: undefined,
        description: "Review a diff",
        arguments: [{ name: "diff", description: undefined, required: true }],
      },
    ]);
    expect(client.getState().instructions).toBe("Use the review prompt for PRs.");
    await client.disconnect();
    expect(client.getState().prompts).toBeUndefined();
  });

  // Filter malformed prompt names at discovery before they can break rendering or become unusable fields.
  it("drops prompts and arguments whose declared names are unusable", async () => {
    const { client } = connectWith({
      advertisePrompts: true,
      approveCapabilities: ["tools", "prompts"],
      promptPages: [
        {
          prompts: [
            { name: 42 },
            { name: "" },
            { name: "x".repeat(200) },
            {
              name: "ok",
              arguments: [
                { name: "good", required: true },
                { name: { nested: true }, required: true },
                { name: "y".repeat(65), required: false },
              ],
            },
          ],
        },
      ],
    });
    await client.connect();
    expect(client.getState().prompts).toEqual([
      { name: "ok", arguments: [{ name: "good", required: true }] },
    ]);
    await client.disconnect();
  });

  it("does NOT call prompts/list when advertised but not approved", async () => {
    const { client, promptsCalls } = connectWith({ advertisePrompts: true, approveCapabilities: ["tools"] });
    await client.connect();
    expect(promptsCalls).toHaveLength(0);
    expect(client.getState().prompts).toBeUndefined();
    await client.disconnect();
  });

  it("does NOT call prompts/list when approved but not advertised", async () => {
    const { client, promptsCalls } = connectWith({
      advertisePrompts: false,
      approveCapabilities: ["tools", "prompts"],
    });
    await client.connect();
    expect(promptsCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("follows nextCursor with bounded pagination", async () => {
    const { client, promptsCalls } = connectWith({
      advertisePrompts: true,
      approveCapabilities: ["tools", "prompts"],
      promptPages: [
        { prompts: [{ name: "a" }], nextCursor: "c1" },
        { prompts: [{ name: "b" }] },
      ],
    });
    await client.connect();
    expect(promptsCalls).toHaveLength(2);
    expect(client.getState().prompts?.map((p) => p.name)).toEqual(["a", "b"]);
    await client.disconnect();
  });
});

describe("MCP getPrompt gating", () => {
  it("refuses a prompt the server never declared, and serves a declared one", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      switch (method) {
        case "server/discover":
          return jsonRpcResponse(id, { ...RC_DISCOVER_RESULT, capabilities: { tools: {}, prompts: {} } });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpcResponse(id, { tools: [] });
        case "prompts/list":
          return jsonRpcResponse(id, { prompts: [{ name: "code_review", description: "Review" }] });
        case "prompts/get":
          return jsonRpcResponse(id, {
            description: "Review",
            messages: [{ role: "user", content: { type: "text", text: "REVIEW BODY" } }],
          });
        default:
          return new Response("unexpected", { status: 500 });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("psrv2", "https://psrv2.example.com/mcp", {
          allowedCapabilities: ["tools", "prompts"] as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
        }),
      ]),
    );
    const client = new McpClient(
      { id: "psrv2", transport: "http", url: "https://psrv2.example.com/mcp" },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );
    await client.connect();

    await expect(client.getPrompt("not_declared", {})).rejects.toThrow(/did not declare prompt/);

    const got = await client.getPrompt("code_review", { diff: "x" });
    expect(got.description).toBe("Review");
    expect(got.blocks).toEqual([{ role: "user", type: "text", text: "REVIEW BODY" }]);
    await client.disconnect();
  });

  it("refuses getPrompt when the server never advertised prompts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("psrv3", "https://psrv3.example.com/mcp")]),
    );
    const client = new McpClient(
      { id: "psrv3", transport: "http", url: "https://psrv3.example.com/mcp" },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );
    await client.connect();
    await expect(client.getPrompt("anything", {})).rejects.toThrow(/did not advertise prompts/);
    await client.disconnect();
  });
});

describe("MCP resources discovery and read", () => {
  function connectWith(opts: {
    advertiseResources: boolean;
    approveCapabilities: string[];
    resourcePages?: Array<{ resources: unknown[]; nextCursor?: string }>;
    templatePages?: Array<{ resourceTemplates: unknown[]; nextCursor?: string }>;
    readResult?: unknown;
  }): { client: McpClient; listCalls: unknown[]; readCalls: unknown[]; templateListCalls: unknown[] } {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const listCalls: unknown[] = [];
    const templateListCalls: unknown[] = [];
    const readCalls: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      switch (method) {
        case "server/discover":
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: opts.advertiseResources
              ? { tools: {}, resources: {} }
              : { tools: {} },
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpcResponse(id, { tools: [] });
        case "resources/templates/list": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          templateListCalls.push(params);
          const page = opts.templatePages?.[templateListCalls.length - 1]
            ?? { resourceTemplates: [] };
          return jsonRpcResponse(id, page);
        }
        case "resources/list": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          listCalls.push(params);
          const page = opts.resourcePages?.[listCalls.length - 1] ?? { resources: [] };
          return jsonRpcResponse(id, page);
        }
        case "resources/read": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          readCalls.push(params);
          return jsonRpcResponse(id, opts.readResult ?? { contents: [] });
        }
        default:
          return new Response("unexpected", { status: 500 });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("rsrv", "https://rsrv.example.com/mcp", {
          allowedCapabilities:
            opts.approveCapabilities as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
        }),
      ]),
    );
    const client = new McpClient(
      { id: "rsrv", transport: "http", url: "https://rsrv.example.com/mcp" },
      gov,
      new ToolRegistry(),
      stubbedGlobalNetworkFetch,
    );
    return { client, listCalls, readCalls, templateListCalls };
  }

  it("discovers resources when advertised AND approved", async () => {
    const { client, listCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [
        {
          resources: [
            {
              uri: "file:///project/README.md",
              name: "README.md",
              title: "Project Documentation",
              mimeType: "text/markdown",
              size: 1234,
            },
          ],
        },
      ],
    });
    await client.connect();
    expect(listCalls).toHaveLength(1);
    expect(client.getState().resources).toEqual([
      {
        uri: "file:///project/README.md",
        name: "README.md",
        title: "Project Documentation",
        mimeType: "text/markdown",
        size: 1234,
      },
    ]);
    await client.disconnect();
  });

  // Reads require both server advertisement and user approval before any request leaves.
  it("does NOT call resources/list when advertised but not approved", async () => {
    const { client, listCalls, templateListCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools"],
    });
    await client.connect();
    expect(listCalls).toHaveLength(0);
    expect(templateListCalls).toHaveLength(0);
    expect(client.getState().resources).toBeUndefined();
    expect(client.getState().resourceTemplates).toBeUndefined();
    await client.disconnect();
  });

  it("does NOT call resources/list when approved but not advertised", async () => {
    const { client, listCalls, templateListCalls } = connectWith({
      advertiseResources: false,
      approveCapabilities: ["tools", "resources"],
    });
    await client.connect();
    expect(listCalls).toHaveLength(0);
    // Template discovery must enforce advertisement as well as governance approval.
    expect(templateListCalls).toHaveLength(0);
    expect(client.getState().resourceTemplates).toBeUndefined();
    await client.disconnect();
  });

  // Validate all discovery values that may be rendered, logged or sent back.
  it("drops unusable entries and de-duplicates by URI", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [
        {
          resources: [
            { uri: 42, name: "numeric uri" },
            { uri: "ui://widget/main.html", name: "app scheme" },
            { uri: "javascript:alert(1)", name: "dangerous scheme" },
            { uri: "no-scheme", name: "not a uri" },
            { uri: "file:///dup", name: "first" },
            { uri: "file:///dup", name: "second" },
            { uri: "file:///ok", name: 42, title: "falls back to the uri" },
          ],
        },
      ],
    });
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    await client.connect();
    const resources = client.getState().resources ?? [];
    expect(resources.map((r) => r.uri)).toEqual(["file:///dup", "file:///ok"]);
    expect(resources[0].name).toBe("first");
    expect(resources[1].name).toBe("file:///ok");
    // Rejection counts must include duplicates as well as malformed entries.
    const line = info.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("discovered"));
    expect(line).toContain("discovered 2 resource(s)");
    expect(line).toContain("5 of 7 published not catalogued");
    info.mockRestore();
    await client.disconnect();
  });

  it("discovers URI templates and derives their variables once", async () => {
    const { client, templateListCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        {
          resourceTemplates: [
            {
              uriTemplate: "file:///project/{path}",
              name: "Project file",
              title: "Any file in the project",
              mimeType: "text/plain",
            },
            { uriTemplate: "github://repos/{owner}/{repo}/issues/{number}", name: "Issue" },
          ],
        },
      ],
    });
    await client.connect();

    expect(templateListCalls).toHaveLength(1);
    expect(client.getState().resourceTemplates).toEqual([
      {
        uriTemplate: "file:///project/{path}",
        name: "Project file",
        title: "Any file in the project",
        mimeType: "text/plain",
        variables: ["path"],
      },
      {
        uriTemplate: "github://repos/{owner}/{repo}/issues/{number}",
        name: "Issue",
        variables: ["owner", "repo", "number"],
      },
    ]);
    await client.disconnect();
  });

  // Reserved template operators could let user input escape percent-encoded segments.
  it("drops templates the host will not expand, and says how many", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        {
          resourceTemplates: [
            { uriTemplate: "file:///project/{+path}", name: "reserved expansion" },
            { uriTemplate: "file:///project/{path*}", name: "explode" },
            { uriTemplate: "ui://widget/{id}", name: "reserved scheme" },
            { uriTemplate: "file:///project/README.md", name: "not a template" },
            { uriTemplate: 42, name: "not a string" },
            { uriTemplate: "file:///ok/{path}", name: "first" },
            { uriTemplate: "file:///ok/{path}", name: "duplicate" },
          ],
        },
      ],
    });
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    await client.connect();

    const templates = client.getState().resourceTemplates ?? [];
    expect(templates.map((template) => template.uriTemplate)).toEqual(["file:///ok/{path}"]);
    expect(templates[0].name).toBe("first");
    const line = info.mock.calls.map((c) => c.join(" "))
      .find((l) => l.includes("resource template(s)"));
    expect(line).toContain("discovered 1 resource template(s)");
    expect(line).toContain("6 of 7 published not catalogued");
    info.mockRestore();
    await client.disconnect();
  });

  it("flags a template whose LITERAL scheme the host will not fetch", async () => {
    // A literal forbidden scheme can disable the picker before a useless form is offered.
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        {
          resourceTemplates: [
            { uriTemplate: "https://example.com/{doc}", name: "web" },
            { uriTemplate: "file:///project/{path}", name: "local" },
          ],
        },
      ],
    });
    await client.connect();

    const templates = client.getState().resourceTemplates ?? [];
    expect(templates[0]).toMatchObject({ uriTemplate: "https://example.com/{doc}", hostFetchRefused: true });
    expect(templates[1]).not.toHaveProperty("hostFetchRefused");
    await client.disconnect();
  });

  it("refuses at READ time when the flag could not have known", async () => {
    // Display flags are not authority; variable schemes must be rechecked after host-side expansion.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        { resourceTemplates: [{ uriTemplate: "{scheme}://example.com/{path}", name: "any" }] },
      ],
    });
    await client.connect();

    expect(client.getState().resourceTemplates?.[0]).not.toHaveProperty("hostFetchRefused");
    await expect(client.readDeclaredResourceTemplate(
      "{scheme}://example.com/{path}",
      new Map([["scheme", "https"], ["path", "r.pdf"]]),
    )).rejects.toThrow(/does not fetch/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("expands a declared template host-side and reads the produced URI", async () => {
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///project/{path}", name: "f" }] }],
      readResult: { contents: [{ uri: "file:///project/a.md", text: "BODY" }] },
    });
    await client.connect();

    const read = await client.readDeclaredResourceTemplate(
      "file:///project/{path}",
      new Map([["path", "a.md"]]),
    );

    expect(read.uri).toBe("file:///project/a.md");
    expect(readCalls).toMatchObject([{ uri: "file:///project/a.md" }]);
    expect(read.blocks[0].text).toBe("BODY");
    await client.disconnect();
  });

  it("cannot be walked out of the published path by what the user types", async () => {
    // Host expansion percent-encodes one segment so renderer input cannot select traversal paths.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///project/{path}", name: "f" }] }],
    });
    await client.connect();

    const read = await client.readDeclaredResourceTemplate(
      "file:///project/{path}",
      new Map([["path", "../../etc/passwd"]]),
    );

    expect(read.uri).toBe("file:///project/..%2F..%2Fetc%2Fpasswd");
    expect(readCalls).toMatchObject([{ uri: "file:///project/..%2F..%2Fetc%2Fpasswd" }]);
    await client.disconnect();
  });

  it("refuses a template it never listed, before any request", async () => {
    // Approve the listed template, not an expanded URI matched back against a permissive pattern.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///listed/{path}", name: "f" }] }],
    });
    await client.connect();

    await expect(client.readDeclaredResourceTemplate(
      "file:///other/{path}",
      new Map([["path", "a.md"]]),
    )).rejects.toThrow(/did not declare/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("refuses when a value is missing rather than expanding it away", async () => {
    // Empty substitutions can select an unintended parent resource.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///project/{path}", name: "f" }] }],
    });
    await client.connect();

    await expect(client.readDeclaredResourceTemplate(
      "file:///project/{path}",
      new Map(),
    )).rejects.toThrow(/no usable uri/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("refuses to fetch a template whose LITERAL scheme is refused", async () => {
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "https://example.com/{doc}", name: "web" }] }],
    });
    await client.connect();

    await expect(client.readDeclaredResourceTemplate(
      "https://example.com/{doc}",
      new Map([["doc", "r.pdf"]]),
    )).rejects.toThrow(/does not fetch/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });
  it("refuses to read a URI it never listed", async () => {
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///listed", name: "listed" }] }],
    });
    await client.connect();
    // Keep resource reads restricted to the declared server URI space.
    await expect(client.readDeclaredResource("file:///not-listed")).rejects.toThrow(
      /did not declare/,
    );
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("refuses to fetch an https resource, but still lists it", async () => {
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [
        { resources: [{ uri: "https://example.com/doc", name: "web doc" }] },
      ],
    });
    await client.connect();
    expect(client.getState().resources?.[0]).toMatchObject({ hostFetchRefused: true });
    // Host-fetching server-selected URLs would create an SSRF primitive.
    await expect(client.readDeclaredResource("https://example.com/doc")).rejects.toThrow(
      /does not fetch/,
    );
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("returns text blocks and placeholders for binary, bounded", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///doc", name: "doc" }] }],
      readResult: {
        contents: [
          { uri: "file:///doc", mimeType: "text/plain", text: "hello" },
          { uri: "file:///doc.png", mimeType: "image/png", blob: "AAAA" },
          { uri: 42 },
        ],
      },
    });
    await client.connect();
    const read = await client.readDeclaredResource("file:///doc");
    expect(read.blocks[0]).toEqual({ uri: "file:///doc", mimeType: "text/plain", text: "hello" });
    expect(read.blocks[1]).toMatchObject({ omittedKind: "binary" });
    expect(read.blocks[2]).toMatchObject({ omittedKind: "unknown" });
    expect(read.droppedBlocks).toBe(0);
    await client.disconnect();
  });

  // Share one budget across blocks so splitting content cannot widen the limit.
  it("spends one character budget across all blocks", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///big", name: "big" }] }],
      readResult: {
        contents: [
          { text: "a".repeat(MCP_RESOURCE_MAX_CHARS - 10) },
          { text: "b".repeat(1000) },
          { text: "c".repeat(1000) },
        ],
      },
    });
    await client.connect();
    const read = await client.readDeclaredResource("file:///big");
    const total = read.blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
    expect(total).toBe(MCP_RESOURCE_MAX_CHARS);
    expect(read.blocks[2].text).toBe("");
    expect(read.truncated).toBe(true);
    await client.disconnect();
  });

  // Clear discovery catalogs on disconnect and crash to stop advertising unreadable resources.
  it("stops advertising resources once the server is gone", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///doc", name: "doc" }] }],
    });
    await client.connect();
    expect(client.getState().resources).toHaveLength(1);
    await client.disconnect();
    expect(client.getState().resources).toBeUndefined();
  });

  it("clears the catalogue when the transport dies, not just on a clean disconnect", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///doc", name: "doc" }] }],
    });
    await client.connect();
    expect(client.getState().resources).toHaveLength(1);
    (client as unknown as { handleTransportClose(reason: string): void })
      .handleTransportClose("child exited");
    expect(client.getState().status).toBe("error");
    expect(client.getState().resources).toBeUndefined();
    expect(client.getState().prompts).toBeUndefined();
    await client.disconnect();
  });

  it("bounds the page walk and the catalogue", async () => {
    const page = {
      resources: Array.from({ length: 300 }, (_, i) => ({
        uri: `file:///f${i}`,
        name: `f${i}`,
      })),
      nextCursor: "more",
    };
    const { client, listCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [page, page, page],
    });
    await client.connect();
    expect(client.getState().resources).toHaveLength(MCP_RESOURCE_MAX_PER_SERVER);
    expect(listCalls).toHaveLength(1);
    await client.disconnect();
  });
});

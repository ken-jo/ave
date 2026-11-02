/** The contained MCP route end to end on the host side: McpClient → the real holder adapter → the real container request
 * builder and validator. Only the native entry (`spawnMxcConfinedChild`) and a synthetic Windows drive are stand-ins, so
 * an environment or working directory the validator would refuse fails here, not first on a Windows host. */
import { PassThrough } from "node:stream";
import { win32 as winPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";

const state = vi.hoisted(() => ({
  plan: undefined as unknown,
  requests: [] as ContainerRequest[],
  nativeStarts: 0,
}));

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const SANDBOX = "C:\\ave\\mcp\\fs\\sandbox";

/** A server on owned streams answering the legacy handshake. */
function containedServer() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = "";
  const results: Record<string, unknown> = {
    initialize: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fs", version: "1" } },
    "tools/list": { tools: [] },
  };
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end)) as { id?: number; method: string };
      buffer = buffer.slice(end + 1);
      if (message.id === undefined) continue;
      const body = message.method in results ? { result: results[message.method] } : { error: { code: -32601, message: "Method not found" } };
      queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body })}\n`));
    }
  });
  let finish!: (value: { exitCode: number; timedOut: boolean }) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => { finish = resolve; });
  return { process: { id: 5, stdin, stdout, stderr, completion, dispose: vi.fn(), diagnostics: {} },
    release: async () => finish({ exitCode: 0, timedOut: false }) };
}

vi.mock("../../permissions/confined-child.js", async (original) => {
  const actual = await original<typeof import("../../permissions/confined-child.js")>();
  const { buildMxcConfinedChildRequest } = await import("../../permissions/mxc-confined-child-request.js");
  return {
    ...actual,
    liveMxcHolderWritableRoots: () => [],
    // The native entry's own admission is row 2's; this stand-in builds and validates the exact request it would send.
    spawnMxcConfinedChild: async (spec: Record<string, never>) => {
      state.nativeStarts += 1;
      state.requests.push(buildMxcConfinedChildRequest({ command: spec.command, args: spec.args, cwd: spec.cwd,
        home: spec.home, temp: spec.temp, grants: { readwrite: spec.allowWrite, readonly: spec.allowRead, denied: [] },
        baseEnv: spec.baseEnv, holderEnv: spec.holderEnv, proxyUrl: "http://127.0.0.1:43210" }));
      const server = containedServer();
      return { process: server.process, confinement: "windows-mxc", release: server.release };
    },
  };
});
vi.mock("../../permissions/sandbox-capability.js", async (original) => ({
  ...await original<typeof import("../../permissions/sandbox-capability.js")>(),
  getWindowsExtensionBackendPlan: () => state.plan,
}));
vi.mock("../../permissions/workspace-authorized-roots.js", () => ({ listAuthorizedWorkspaceRoots: () => [] }));
vi.mock("../../shared/ave-home.js", async (original) => ({
  ...await original<typeof import("../../shared/ave-home.js")>(),
  aveHome: () => "C:\\ave",
}));
// Synthetic drive-letter paths: the server executable is a file, staging directories exist once made.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const drive = (path: unknown): path is string => typeof path === "string" && /^[a-z]:\\/iu.test(path);
  const dirs = new Set<string>();
  const key = (path: string): string => winPath.normalize(path).toLowerCase();
  return {
    ...actual,
    existsSync: (path: unknown) => drive(path) ? key(path) === key(NODE) || dirs.has(key(path)) : actual.existsSync(path as string),
    statSync: ((path: unknown, options?: unknown) => drive(path) ? { isFile: () => key(path) === key(NODE) }
      : actual.statSync(path as string, options as never)) as typeof actual.statSync,
    realpathSync: Object.assign((path: unknown) => drive(path) ? winPath.normalize(path) : actual.realpathSync(path as string), {
      native: (path: unknown) => {
        if (!drive(path)) return actual.realpathSync.native(path as string);
        if (key(path) !== key(NODE) && !dirs.has(key(path))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return winPath.normalize(path);
      },
    }),
    mkdirSync: ((path: unknown, options?: unknown) => {
      if (!drive(path)) return actual.mkdirSync(path as string, options as never);
      for (let dir = winPath.normalize(path); winPath.dirname(dir) !== dir; dir = winPath.dirname(dir)) dirs.add(key(dir));
      return undefined;
    }) as typeof actual.mkdirSync,
    lstatSync: ((path: unknown, options?: unknown) => drive(path) ? { isSymbolicLink: () => false, isDirectory: () => true }
      : actual.lstatSync(path as string, options as never)) as typeof actual.lstatSync,
    readdirSync: ((path: unknown, options?: unknown) => drive(path) ? [] : actual.readdirSync(path as string, options as never)) as typeof actual.readdirSync,
    renameSync: ((from: unknown, to: unknown) => drive(from) ? undefined : actual.renameSync(from as string, to as string)) as typeof actual.renameSync,
    rmdirSync: ((path: unknown) => drive(path) ? undefined : actual.rmdirSync(path as string)) as typeof actual.rmdirSync,
  };
});

// `renameDirectory` renames through node:fs/promises; drive-letter paths go to the in-memory drive above.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const fake = await import("node:fs");
  return {
    ...actual,
    rename: async (from: string, to: string) => /^[a-z]:\\/iu.test(from) ? fake.renameSync(from, to) : actual.rename(from, to),
  };
});

const { McpClient } = await import("../mcp-client.js");
const { ToolRegistry } = await import("../../tools/registry.js");
const { unusedNetworkFetch } = await import("../../__tests__/support/network-fetch-stubs.js");
const { governanceWithPolicy, buildPolicy, stdioApproval } = await import("./test-helpers.js");
const { __resetWrappedMcpServersForTest } = await import("../../permissions/sandbox-capability.js");
const { planWindowsExtensionHolder } = await import("../../permissions/mxc-extension-readiness.js");
const { registerMxcHolderReadinessProbe } = await import("../../sandbox/wrap-bundled-command.js");
const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");

const REAL_PLATFORM = process.platform;
const RUNTIME_ENV = { SystemRoot: "C:\\Windows", APPDATA: "C:\\profile\\AppData\\Roaming", LOCALAPPDATA: "C:\\profile\\AppData\\Local", COMSPEC: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".COM;.EXE" };
const savedEnv: Record<string, string | undefined> = {};
let unregister: () => void;

function client(overrides: Record<string, unknown> = {}) {
  const config = { id: "fs", transport: "stdio" as const, command: NODE, args: ["server.js"], sandboxRoot: SANDBOX,
    env: { FS_MODE: "ro" }, apiKey: "k-123", apiKeyEnv: "FS_TOKEN", ...overrides };
  const approval = stdioApproval(config.id, config.command, { requiredAuth: "api-key", apiKeyEnv: "FS_TOKEN" });
  return new McpClient(config, governanceWithPolicy(buildPolicy([approval])), new ToolRegistry(), unusedNetworkFetch);
}

beforeEach(() => {
  setProcessPlatform("win32");
  for (const [name, value] of Object.entries(RUNTIME_ENV)) { savedEnv[name] = process.env[name]; process.env[name] = value; }
  state.plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" }, fallback: { version: "0.0.80", ready: false } });
  state.requests = [];
  state.nativeStarts = 0;
  __resetWrappedMcpServersForTest();
  unregister = registerMxcHolderReadinessProbe(async () => { throw new Error("row 2 calls the probe"); });
});

afterEach(() => {
  unregister();
  for (const [name, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  setProcessPlatform(REAL_PLATFORM);
  __resetWrappedMcpServersForTest();
});

describe("contained MCP request", () => {
  it("passes the container validator with the runtime variables, host-owned variables and sandbox-root cwd", async () => {
    const mcp = client({ env: { FS_MODE: "ro", APPDATA: "C:\\configured\\Roaming" } });
    await mcp.connect();
    await mcp.disconnect();
    const [request] = state.requests;
    expect(request!.environment).toMatchObject({ SYSTEMROOT: "C:\\Windows", COMSPEC: RUNTIME_ENV.COMSPEC,
      FS_MODE: "ro", FS_TOKEN: "k-123" });
    // The host's APPDATA/LOCALAPPDATA never reach the container, even when configured: both are the staging HOME.
    expect(request!.environment!.LOCALAPPDATA).toBe(request!.environment!.HOME);
    expect(request!.environment!.APPDATA).toBe(request!.environment!.HOME);
    expect(request!.environment!.LOCALAPPDATA).toMatch(/^C:\\ave\\mxc-staging\\[0-9a-f]{32}\\home$/u);
    expect(request!.workingDirectory).toBe(SANDBOX);
    expect(request!.inheritDefaultEnvironment).toBe(false);
    expect(request!.command.startsWith(`"${NODE}"`)).toBe(true);
  });

  it("falls back to the private staging HOME as cwd only without a sandbox root", async () => {
    const mcp = client({ sandboxRoot: undefined });
    await mcp.connect();
    await mcp.disconnect();
    const [request] = state.requests;
    expect(request!.workingDirectory).toMatch(/^C:\\ave\\mxc-staging\\[0-9a-f]{32}\\home$/u);
    expect(request!.workingDirectory).toBe(request!.environment!.HOME);
  });

  it("refuses a configured cwd outside the admitted roots before any native start, never widening them", async () => {
    const mcp = client({ cwd: "D:\\elsewhere" });
    await expect(mcp.connect()).rejects.toThrow(/working directory is outside this process's admitted folders/u);
    expect(state.nativeStarts).toBe(0);
    expect(state.requests).toHaveLength(0);
  });

  it("refuses a loader override by name, without its value, before any native start", async () => {
    const mcp = client({ env: { NODE_OPTIONS: "--require=C:\\secret-loader.js", ELECTRON_RUN_AS_NODE: "0" } });
    const refusal = await mcp.connect().then(() => undefined, (error: unknown) => error as Error & { code?: string });
    if (refusal === undefined) throw new Error("connect was expected to be refused");
    expect(refusal).toMatchObject({ code: "holder-environment-refused" });
    expect(refusal.message).toContain("ELECTRON_RUN_AS_NODE, NODE_OPTIONS");
    expect(refusal.message).not.toContain("secret-loader");
    expect(state.nativeStarts).toBe(0);
  });
});

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "../codex-app-server-client.js";
import { CODEX_APP_SERVER_ARGV, CODEX_RPC_REQUEST_TIMEOUT_MS, type CodexConversationRuntime, type CodexConversationRuntimeOptions } from "../codex-conversation-runtime.js";
import { SubscriptionRuntimeService, type AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
import { claimFakeRuntimeDirectories, createSubscriptionRuntimeNamespace } from "../../__tests__/support/subscription-runtime-namespace.js";
import { CodexUserRuntimeError, type CodexResolvedRuntime } from "../codex-user-runtime.js";
import { codexExecutableArtifactFixture, NATIVE_LOCATION_WAIT, normalizeFixtureAncestorPermissions } from "../../__tests__/support/native-executable.js";
import { createPrivateDirectory } from "../codex-executable-location.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { deferred } from "../../__tests__/support/deferred.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("../../__tests__/support/native-executable.js")).fakeFixtureAcl(await importOriginal()));

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type RequestHandler = (request: RpcRequest) => unknown;
type Spawn = NonNullable<CodexAppServerClientOptions["spawn"]>;
const DEFER_RESPONSE = Symbol("defer-response");

// In-memory App Server double. It handles exactly the App Server JSONL transport that the client owns, so no actual Codex executable, browser, or login is used.
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RpcRequest[] = [];
  killed = false;
  exitCode: number | null = null;
  private input = "";
  private heldInitialize: RpcRequest | null = null;

  constructor(
    private readonly handler: RequestHandler,
    private readonly deferInitializeUntilInitialized = false,
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => this.consume(String(chunk)));
  }

  kill = (_signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    return true;
  };

  dispose(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }

  private consume(chunk: string): void {
    this.input += chunk;
    for (;;) {
      const newline = this.input.indexOf("\n");
      if (newline < 0) return;
      const line = this.input.slice(0, newline).trim();
      this.input = this.input.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as RpcRequest;
      this.requests.push(request);
      if (request.method === "initialized" && this.heldInitialize) {
        const initialize = this.heldInitialize;
        this.heldInitialize = null;
        this.respond(initialize);
        continue;
      }
      if (typeof request.id !== "number") continue;
      if (this.deferInitializeUntilInitialized && request.method === "initialize") {
        this.heldInitialize = request;
        continue;
      }
      this.respond(request);
    }
  }
  private respond(request: RpcRequest): void {
    const result = this.handler(request);
    if (result === DEFER_RESPONSE) return;
    this.stdout.write(`${JSON.stringify({
      id: request.id,
      result,
    })}\n`);
  }
}

interface Harness {
  client: CodexAppServerClient;
  openAuthorizationUrl: ReturnType<typeof vi.fn>;
  runtimeRoot: string;
  runtimeHome: string;
  sqliteHome: string;
  workspaceDir: string;
  runtimeTempDir: string;
  server: FakeAppServer;
  spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }>;
  artifact: CodexResolvedRuntime;
}

const harnesses: Harness[] = [];
const TEST_RUNTIME_PARENT = tmpdir();

async function createHarness(
  handler: RequestHandler,
  options: {
    deferInitializeUntilInitialized?: boolean;
    resolveRuntime?: (artifact: CodexResolvedRuntime) => Promise<CodexResolvedRuntime>;
    lastKnownVersion?: () => string | null;
    onPlanUsage?: CodexAppServerClientOptions["onPlanUsage"];
  } = {},
): Promise<Harness> {
  const server = new FakeAppServer(handler, options.deferInitializeUntilInitialized);
  const openAuthorizationUrl = vi.fn(async (_url: string) => undefined);
  const runtimeRoot = mkdtempSync(join(TEST_RUNTIME_PARENT, "ave-codex-app-server-client-"));
  if (process.platform !== "win32") normalizeFixtureAncestorPermissions(runtimeRoot);
  const runtimeHome = join(runtimeRoot, "home");
  const sqliteHome = join(runtimeRoot, "sqlite");
  const workspaceDir = join(runtimeRoot, "workspace");
  const runtimeTempDir = join(runtimeRoot, "temporary");
  await createPrivateDirectory(runtimeHome);
  await createPrivateDirectory(sqliteHome);
  await createPrivateDirectory(workspaceDir);
  await createPrivateDirectory(runtimeTempDir);
  const artifact = { ...await codexExecutableArtifactFixture(runtimeHome), version: "0.153.4" };
  const spawnCalls: Harness["spawnCalls"] = [];
  const spawn: Spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return server as unknown as ChildProcess;
  };
  const client = new CodexAppServerClient({
    openAuthorizationUrl,
    runtimeHome,
    sqliteHome,
    workspaceDir,
    runtimeTempDir,
    resolveRuntime: () => options.resolveRuntime ? options.resolveRuntime(artifact) : Promise.resolve(artifact),
    ...(options.lastKnownVersion ? { lastKnownVersion: options.lastKnownVersion } : {}),
    spawn,
    clientVersion: "test-version",
    onPlanUsage: options.onPlanUsage,
  });
  const harness = {
    client,
    openAuthorizationUrl,
    runtimeRoot,
    runtimeHome,
    sqliteHome,
    workspaceDir,
    runtimeTempDir,
    server,
    spawnCalls,
    artifact,
  };
  harnesses.push(harness);
  return harness;
}

function standardInitialize(request: RpcRequest): unknown {
  if (request.method === "initialize") return { serverInfo: { name: "fake-codex" } };
  throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.client.stop();
    harness.server.dispose();
    await cleanupTmpDir(harness.runtimeRoot);
  }
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodexAppServerClient", () => {
  it("returns authenticated status and models while a quota read is unanswered", async () => {
    const requested = deferred<RpcRequest>();
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: { type: "chatgpt", planType: "plus" } };
      if (request.method === "account/rateLimits/read") { requested.resolve(request); return DEFER_RESPONSE; }
      if (request.method === "model/list") return { data: [] };
      return standardInitialize(request);
    }, { onPlanUsage: vi.fn() });
    let returned = false;
    const status = harness.client.getStatus().then((value) => { returned = true; return value; });
    await requested.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(true);
    await expect(status).resolves.toMatchObject({ connection: "connected" });
    await expect(harness.client.listModels()).resolves.toMatchObject({ status: { connection: "connected" }, models: [] });
    expect(harness.server.requests.filter((request) => request.method === "account/rateLimits/read")).toHaveLength(1);
  });

  it("keeps the authenticated transport usable after an optional quota timeout", async () => {
    const requested = deferred<RpcRequest>();
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: { type: "chatgpt", planType: "plus" } };
      if (request.method === "account/rateLimits/read") { requested.resolve(request); return DEFER_RESPONSE; }
      if (request.method === "model/list") return { data: [] };
      return standardInitialize(request);
    }, { onPlanUsage: vi.fn() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const status = harness.client.getStatus();
    const quota = await requested.promise;
    await vi.advanceTimersByTimeAsync(CODEX_RPC_REQUEST_TIMEOUT_MS);
    await expect(status).resolves.toMatchObject({ connection: "connected" });
    expect(harness.client.getCachedStatus().connection).toBe("connected");
    expect(harness.server.killed).toBe(false);
    await expect(harness.client.listModels()).resolves.toMatchObject({ status: { connection: "connected" }, models: [] });
    expect(harness.spawnCalls).toHaveLength(1);
    harness.server.stdout.write(`${JSON.stringify({ id: quota.id, result: { rateLimits: { primary: { usedPercent: 80 } } } })}\n`);
    expect(harness.client.getCachedStatus().connection).toBe("connected");
  });

  it("still closes the transport when the required account read times out", async () => {
    const requested = deferred<void>();
    const harness = await createHarness((request) => {
      if (request.method === "account/read") { requested.resolve(); return DEFER_RESPONSE; }
      return standardInitialize(request);
    }, { onPlanUsage: vi.fn() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const status = expect(harness.client.getStatus()).rejects.toMatchObject({ code: "codex-operation-failed" });
    await requested.promise;
    await vi.advanceTimersByTimeAsync(CODEX_RPC_REQUEST_TIMEOUT_MS);
    await status;
    expect(harness.server.killed).toBe(true);
    expect(harness.client.getCachedStatus().connection).toBe("signed-out");
  });

  it("does not restore a withdrawn window from an older in-flight quota read", async () => {
    const requested = deferred<RpcRequest>();
    const onPlanUsage = vi.fn();
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: { type: "chatgpt", planType: "plus" } };
      if (request.method === "account/rateLimits/read") { requested.resolve(request); return DEFER_RESPONSE; }
      return standardInitialize(request);
    }, { onPlanUsage });
    await expect(harness.client.getStatus()).resolves.toMatchObject({ connection: "connected" });
    const quota = await requested.promise;
    harness.server.stdout.write(`${JSON.stringify({ method: "account/rateLimits/updated", params: {
      rateLimits: { limitId: "codex", secondary: null },
    } })}\n`);
    expect(onPlanUsage).toHaveBeenLastCalledWith([{ id: "codex:secondary", removed: true }]);
    onPlanUsage.mockClear();
    harness.server.stdout.write(`${JSON.stringify({ id: quota.id, result: {
      rateLimits: { limitId: "codex", secondary: { usedPercent: 80 } },
    } })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPlanUsage).not.toHaveBeenCalled();
  });

  it("keeps conversation withdrawals when a separate account read replies late", async () => {
    const requested = deferred<RpcRequest>();
    let accountOptions: CodexAppServerClientOptions | undefined;
    let conversationOptions: CodexConversationRuntimeOptions | undefined;
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: { type: "chatgpt", planType: "plus" } };
      if (request.method === "account/rateLimits/read") { requested.resolve(request); return DEFER_RESPONSE; }
      return standardInitialize(request);
    }, { onPlanUsage: (updates) => accountOptions?.onPlanUsage?.(updates) });
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: createSubscriptionRuntimeNamespace(), claimRuntimeDirectories: claimFakeRuntimeDirectories,
      claudeCodeReleaseFetch: async () => { throw new Error("Unexpected release request"); },
      acpRegistry: { stopAll: async () => {} } as unknown as AcpSubscriptionRuntimeRegistry,
      createCodexAppServerClient: (options) => { accountOptions = options; return harness.client; },
      createCodexConversationRuntime: (options) => {
        conversationOptions = options;
        return { verifyIsolation: async () => {}, stop: () => {} } as unknown as CodexConversationRuntime;
      },
    });
    try {
      await service.verify("codex");
      const quota = await requested.promise;
      await service.openTextSession({ kind: "subscription", provider: "codex" });
      const accountReport = accountOptions?.onPlanUsage;
      const conversationReport = conversationOptions?.onPlanUsage;
      if (!accountReport || !conversationReport) throw new Error("Missing quota observers");
      accountReport([{ id: "codex:primary", usedPercent: 20 }, { id: "codex:secondary", usedPercent: 20 }]);
      conversationReport([{ id: "codex:secondary", removed: true }]);
      harness.server.stdout.write(`${JSON.stringify({ id: quota.id, result: {
        rateLimits: { limitId: "codex", secondary: { usedPercent: 80 } },
      } })}\n`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rows = (await service.getCachedStatus("codex"))?.planUsage?.windows;
      expect(rows?.find((row) => row.id === "codex:secondary")).toBeUndefined();
      expect(rows?.find((row) => row.id === "codex:primary")?.usedPercent).toBe(20);
    } finally {
      await service.stop();
    }
  });

  it.each([null, "chatgpt"])("discards an old quota read after auth changes to %s", async (authMode) => {
    const quotaRequested = deferred<RpcRequest>();
    const onPlanUsage = vi.fn();
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: { type: "chatgpt", planType: "plus" } };
      if (request.method === "account/rateLimits/read") {
        quotaRequested.resolve(request);
        return DEFER_RESPONSE;
      }
      return standardInitialize(request);
    }, { onPlanUsage });
    const status = harness.client.getStatus();
    const quota = await quotaRequested.promise;
    await expect(status).resolves.toMatchObject({ connection: "connected" });
    harness.server.stdout.write(`${JSON.stringify({ method: "account/updated", params: { authMode, planType: "pro" } })}\n`);
    expect(onPlanUsage).toHaveBeenLastCalledWith([]);
    onPlanUsage.mockClear();
    harness.server.stdout.write(`${JSON.stringify({ id: quota.id, result: {
      rateLimits: { limitId: "codex", primary: { usedPercent: 80, resetsAt: 1730947200 } },
    } })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.client.getCachedStatus().connection).toBe(authMode === null ? "signed-out" : "connected");
    expect(onPlanUsage).not.toHaveBeenCalled();
  });

  it("reads reported quota for a connected account and consumes account updates", async () => {
    const records = JSON.parse(readFileSync(new URL("./fixtures/subscription-plan-usage-events.json", import.meta.url), "utf8"));
    const onPlanUsage = vi.fn();
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: { type: "chatgpt", email: "synthetic@example.com", planType: "plus" } };
      if (request.method === "account/rateLimits/read") return records.accountRead;
      return standardInitialize(request);
    }, { onPlanUsage });
    await expect(harness.client.getStatus()).resolves.toMatchObject({ connection: "connected" });
    expect(onPlanUsage).toHaveBeenCalledWith([
      { id: "codex:primary", usedPercent: 25, resetsAt: 1730947200000, windowDurationMins: 15 },
      { id: "codex:secondary", removed: true },
      { id: "codex_other:primary", usedPercent: 42, resetsAt: 1730950800000, windowDurationMins: 60 },
      { id: "codex_other:secondary", removed: true },
    ]);
    harness.server.stdout.write(`${JSON.stringify(records.accountUpdated)}\n`);
    expect(onPlanUsage).toHaveBeenLastCalledWith([
      { id: "codex:primary", usedPercent: 31, resetsAt: 1730948100000, windowDurationMins: 15 },
    ]);
    onPlanUsage.mockClear();
    harness.server.stdout.write(`${JSON.stringify({ method: "account/rateLimits/updated", params: {
      rateLimits: { limitId: "other" },
    } })}\n`);
    expect(onPlanUsage).not.toHaveBeenCalled();
    onPlanUsage.mockImplementation(() => { throw new Error("Observer failed"); });
    await expect(harness.client.getStatus()).resolves.toMatchObject({ connection: "connected" });
  });

  it("keeps account status available when quota data is absent and never reads it while signed out", async () => {
    const onPlanUsage = vi.fn();
    let signedIn = true;
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: signedIn ? { type: "chatgpt", planType: "plus" } : null };
      if (request.method === "account/rateLimits/read") return null;
      return standardInitialize(request);
    }, { onPlanUsage });
    await expect(harness.client.getStatus()).resolves.toMatchObject({ connection: "connected" });
    expect(onPlanUsage).toHaveBeenCalledWith([]);
    signedIn = false;
    await expect(harness.client.getStatus()).resolves.toMatchObject({ connection: "signed-out" });
    expect(harness.server.requests.filter((request) => request.method === "account/rateLimits/read")).toHaveLength(1);
  });

  it("reports a missing user CLI as not configured without starting anything", async () => {
    const harness = await createHarness(standardInitialize, {
      resolveRuntime: async () => { throw new CodexUserRuntimeError("codex-runtime-not-installed"); },
    });
    await expect(harness.client.getStatus()).resolves.toMatchObject({
      runtime: "not-configured",
      connection: "signed-out",
      version: null,
    });
    await expect(harness.client.startBrowserLogin()).rejects.toMatchObject({ code: "codex-runtime-not-configured" });
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it.each([
    ["codex-runtime-version-unsupported", "0.151.0"],
    ["codex-runtime-incompatible", "0.153.4"],
    ["codex-runtime-invalid-executable", null],
    ["codex-runtime-unsafe-location", null],
    ["codex-runtime-start-failed", null],
  ] as const)("fails clearly with %s and keeps the runtime unavailable", async (code, version) => {
    const harness = await createHarness(standardInitialize, {
      resolveRuntime: async () => { throw new CodexUserRuntimeError(code, version); },
      lastKnownVersion: () => version,
    });
    await expect(harness.client.getStatus()).rejects.toMatchObject({ code });
    expect(harness.client.getCachedStatus()).toMatchObject({ runtime: "unavailable", version });
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it("starts the resolved user CLI and reports its version", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "account/read") return { account: null, requiresOpenaiAuth: true };
      return standardInitialize(request);
    }, {
      resolveRuntime: async (artifact) => ({ ...artifact, version: "0.160.1" }),
      lastKnownVersion: () => "0.160.1",
    });
    await expect(harness.client.getStatus()).resolves.toMatchObject({ runtime: "ready", version: "0.160.1" });
    expect(harness.spawnCalls[0]?.command).toBe(harness.artifact.executable);
  });

  it("rechecks the qualified copy immediately before spawn and refuses a replacement", async () => {
    const harness = await createHarness(standardInitialize, {
      resolveRuntime: async (artifact) => {
        chmodSync(artifact.executable, 0o700);
        writeFileSync(artifact.executable, "#!/bin/sh\necho substituted\n");
        chmodSync(artifact.executable, 0o500);
        return artifact;
      },
    });
    await expect(harness.client.getStatus()).rejects.toMatchObject({ code: "codex-runtime-invalid-executable" });
    expect(harness.spawnCalls).toEqual([]);
    expect(harness.client.getCachedStatus().runtime).toBe("unavailable");
  });

  it("rejects a non-string method envelope before it can consume a pending response", async () => {
    let harness: Harness;
    harness = await createHarness((request) => {
      if (request.method === "initialize") {
        harness.server.stdout.write(`${JSON.stringify({
          id: request.id,
          method: 7,
          result: { serverInfo: { name: "must-not-initialize" } },
        })}\n`);
        return standardInitialize(request);
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    await expect(harness.client.getStatus()).rejects.toMatchObject({ code: "codex-runtime-start-failed" });
    expect(harness.server.killed).toBe(true);
  });

  it("projects account status without exposing account email or auth data", async () => {
    vi.stubEnv("OpenAI_Api_Key", "should-not-reach-codex");
    vi.stubEnv("CoDeX_AcCeSs_ToKeN", "should-not-reach-codex");
    vi.stubEnv("openai_base_url", "https://should-not-reach-codex.test");
    vi.stubEnv("CoDeX_ReFrEsH_ToKeN_Url_OverRide", "https://override.example.test");
    vi.stubEnv("oTeL_ExPoRtEr_OtLp_EnDpOiNt", "https://telemetry.example.test");
    vi.stubEnv("HtTpS_PrOxY", "https://proxy.example.test");
    vi.stubEnv("SSL_CERT_FILE", "C:\\test\\custom-ca.pem");
    vi.stubEnv("RuSt_LoG", "trace");
    vi.stubEnv("HOME", "host-home");
    vi.stubEnv("TMPDIR", "host-tmpdir");
    vi.stubEnv("PATH", "host-path");
    vi.stubEnv("USERPROFILE", "C:\\host-profile");
    vi.stubEnv("APPDATA", "C:\\host-appdata");
    vi.stubEnv("LOCALAPPDATA", "C:\\host-local-appdata");
    vi.stubEnv("TEMP", "C:\\host-temp");

    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/read") {
        return {
          account: {
            type: "chatgpt",
            email: "owner@example.test",
            planType: "plus",
            accessToken: "account-token-must-not-leave-main",
            refreshToken: "refresh-token-must-not-leave-main",
          },
        };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const status = await harness.client.getStatus();

    expect(status).toEqual({
      runtime: "ready",
      connection: "connected",
      planType: "plus",
      pendingLogin: null,
      pendingDeviceCode: null,
      version: null,
    });
    const projected = JSON.stringify(status);
    expect(projected).not.toContain("owner@example.test");
    expect(projected).not.toContain("account-token-must-not-leave-main");
    expect(projected).not.toContain("refresh-token-must-not-leave-main");
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]?.args).toBe(CODEX_APP_SERVER_ARGV);
    expect(harness.server.requests.some((request) => request.method === "windowsSandbox/setupStart")).toBe(false);
    expect(harness.spawnCalls[0]).toMatchObject({
      command: harness.artifact.executable,
      // The one argv the conversation runtime also spawns with — the hardening boundary cannot differ between the two processes.
      args: [...CODEX_APP_SERVER_ARGV],
      options: {
        cwd: harness.workspaceDir,
        shell: false,
        windowsHide: true,
        env: expect.objectContaining({
          CODEX_HOME: harness.runtimeHome,
          CODEX_SQLITE_HOME: harness.sqliteHome,
          HOME: harness.runtimeHome,
          TMPDIR: harness.runtimeTempDir,
          RUST_LOG: "error",
        }),
      },
    });

    const childEnv = harness.spawnCalls[0]?.options.env ?? {};
    const childEnvNames = Object.keys(childEnv).map((name) => name.toUpperCase());
    expect(childEnvNames.filter((name) => name.startsWith("CODEX_")).sort()).toEqual([
      "CODEX_HOME",
      "CODEX_SQLITE_HOME",
    ]);
    expect(childEnvNames.some((name) => name.startsWith("OPENAI_") || name.startsWith("OTEL_"))).toBe(false);
    expect(childEnvNames).not.toEqual(expect.arrayContaining(["HTTPS_PROXY", "SSL_CERT_FILE"]));
    expect(childEnv.RUST_LOG).toBe("error");
    expect(childEnv.HOME).toBe(harness.runtimeHome);
    expect(childEnv.TMPDIR).toBe(harness.runtimeTempDir);
    expect(childEnv.PATH).not.toBe("host-path");
    expect(JSON.stringify(childEnv)).not.toContain("host-");
    if (process.platform === "win32") {
      expect(childEnv.USERPROFILE).toBe(harness.runtimeHome);
      expect(childEnv.APPDATA).toBe(harness.runtimeHome);
      expect(childEnv.LOCALAPPDATA).toBe(harness.runtimeHome);
      expect(childEnv.TEMP).toBe(harness.runtimeTempDir);
      expect(childEnv.TMP).toBe(harness.runtimeTempDir);
    }
  });
  it("sends initialized before awaiting the initialize result", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/read") return { account: null };
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    }, {
      deferInitializeUntilInitialized: true,
    });

    const statusPromise = harness.client.getStatus();
    void statusPromise.catch(() => undefined);
    await vi.waitFor(() => expect(harness.server.requests).toHaveLength(3), NATIVE_LOCATION_WAIT);

    expect(harness.server.requests.map((request) => request.method).slice(0, 2)).toEqual([
      "initialize",
      "initialized",
    ]);
    await expect(statusPromise).resolves.toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
      version: null,
    });
  });

  it("opens only a trusted browser login URL and returns a URL-free pending status", async () => {
    const authUrl = "https://auth.openai.com/authorize?state=browser-only-state";
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return { type: "chatgpt", loginId: "browser-login", authUrl };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const status = await harness.client.startBrowserLogin();

    expect(harness.openAuthorizationUrl).toHaveBeenCalledOnce();
    expect(harness.openAuthorizationUrl).toHaveBeenCalledWith(authUrl, expect.objectContaining({
      completion: expect.any(Promise), onCancel: expect.any(Function), timeoutMs: expect.any(Number),
    }));
    expect(status).toEqual({
      runtime: "ready",
      connection: "pending",
      planType: null,
      pendingLogin: "browser",
      pendingDeviceCode: null,
      version: null,
    });
    expect(JSON.stringify(status)).not.toContain("browser-only-state");
    expect(JSON.stringify(status)).not.toContain("auth.openai.com");
    expect(harness.server.requests).toContainEqual(expect.objectContaining({
      method: "account/login/start",
      params: {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      },
    }));
    const login = harness.openAuthorizationUrl.mock.calls[0][1] as import("../oauth-login.js").OAuthLoginOptions;
    harness.server.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "browser-login", success: true } })}\n`);
    await expect(login.completion).resolves.toBeUndefined();
  });

  it("cancels the runtime login and exposes a failure after its window closes", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") return { type: "chatgpt", loginId: "cancel-window", authUrl: "https://auth.openai.com/authorize" };
      if (request.method === "account/login/cancel") return {};
      if (request.method === "account/read") return { account: null };
      throw new Error("Unexpected login request");
    });
    await harness.client.startBrowserLogin();
    const login = harness.openAuthorizationUrl.mock.calls[0][1] as import("../oauth-login.js").OAuthLoginOptions;
    login.onCancel();
    await vi.waitFor(() => expect(harness.server.requests).toContainEqual(expect.objectContaining({ method: "account/login/cancel" })));
    await expect(harness.client.getStatus()).rejects.toMatchObject({ code: "codex-login-failed" });
    await expect(login.completion).resolves.toBeUndefined();
  });

  it("rejects an untrusted login URL without opening it", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgpt",
          loginId: "evil-login",
          authUrl: "https://openai.com.attacker.test/authorize?state=do-not-open",
        };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    await expect(harness.client.startBrowserLogin()).rejects.toMatchObject({
      code: "codex-login-failed",
    });

    expect(harness.openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("keeps the device verification URL in main while returning only the one-time code", async () => {
    const verificationUrl = "https://chatgpt.com/device?ticket=main-process-only";
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "device-login",
          verificationUrl,
          userCode: "ABCD-EFGH",
        };
      }
      if (request.method === "account/read") return { account: null };
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const result = await harness.client.startDeviceCodeLogin();

    expect(harness.openAuthorizationUrl).toHaveBeenCalledOnce();
    expect(harness.openAuthorizationUrl).toHaveBeenCalledWith(verificationUrl, expect.objectContaining({
      completion: expect.any(Promise), onCancel: expect.any(Function), timeoutMs: expect.any(Number),
    }));
    expect(result).toEqual({
      status: {
        runtime: "ready",
        connection: "pending",
        planType: null,
        pendingLogin: "device-code",
        pendingDeviceCode: "ABCD-EFGH",
        version: null,
      },
      userCode: "ABCD-EFGH",
    });
    await expect(harness.client.getStatus()).resolves.toEqual(result.status);

    const projected = JSON.stringify(result);
    expect(projected).not.toContain("main-process-only");
    expect(projected).not.toContain("chatgpt.com/device");
  });
  it("clears the volatile device code when sign-in is cancelled", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "device-login",
          verificationUrl: "https://chatgpt.com/device",
          userCode: "ABCD-EFGH",
        };
      }
      if (request.method === "account/login/cancel") return {};
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    await harness.client.startDeviceCodeLogin();
    const status = await harness.client.cancelLogin();

    expect(status).toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
      version: null,
    });
    expect(harness.client.getCachedStatus()).toEqual(status);
    expect(harness.server.requests).toContainEqual(expect.objectContaining({
      method: "account/login/cancel",
      params: { loginId: "device-login" },
    }));
  });

  it("reports an asynchronous login failure without leaking App Server detail", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/login/start") {
        return {
          type: "chatgptDeviceCode",
          loginId: "device-login",
          verificationUrl: "https://chatgpt.com/device",
          userCode: "ABCD-EFGH",
        };
      }
      if (request.method === "account/read") return { account: null };
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    await harness.client.startDeviceCodeLogin();
    harness.server.stdout.write(`${JSON.stringify({
      method: "account/login/completed",
      params: {
        loginId: "device-login",
        success: false,
        error: "opaque-server-detail",
      },
    })}\n`);

    await expect(harness.client.getStatus()).rejects.toMatchObject({
      code: "codex-login-failed",
    });
    expect(JSON.stringify(harness.client.getCachedStatus())).not.toContain(
      "opaque-server-detail",
    );
    await expect(harness.client.getStatus()).resolves.toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
      version: null,
    });
  });

  it("uses headerless App Server JSONL and omits logout params", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/logout") return {};
      throw new Error(`Unexpected App Server request: ${String(request.method)}`);
    });

    const status = await harness.client.logout();

    expect(status).toEqual({
      runtime: "ready",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
      version: null,
    });
    const logout = harness.server.requests.find((request) => request.method === "account/logout");
    expect(logout).toEqual({
      id: expect.any(Number),
      method: "account/logout",
    });
    expect(logout).not.toHaveProperty("params");
    for (const request of harness.server.requests) {
      expect(request).not.toHaveProperty("jsonrpc");
    }
  });

  it("returns a non-sensitive status and filters malformed or duplicate models", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/read") {
        return {
          account: {
            type: "chatgpt",
            email: "models-owner@example.test",
            planType: "pro",
          },
        };
      }
      if (request.method === "model/list") {
        return {
          data: [
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              isDefault: true,
              inputModalities: ["text", "image"],
            },
            {
              model: "gpt-5-mini",
              displayName: "   ",
              inputModalities: ["text", 7, "audio", "bad\u0000modality"],
            },
            { id: "gpt-5.4", displayName: "duplicate" },
            { id: "bad\u0000model", displayName: "ignored" },
            null,
          ],
        };
      }
      throw new Error(`Unexpected JSON-RPC request: ${String(request.method)}`);
    });

    const result = await harness.client.listModels();

    expect(result).toEqual({
      status: {
        runtime: "ready",
        connection: "connected",
        planType: "pro",
        pendingLogin: null,
        pendingDeviceCode: null,
        version: null,
      },
      models: [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: true,
          inputModalities: ["text", "image"],
        },
        {
          id: "gpt-5-mini",
          displayName: "gpt-5-mini",
          isDefault: false,
          inputModalities: ["text", "audio"],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("models-owner@example.test");
    expect(harness.server.requests).toContainEqual(expect.objectContaining({
      method: "model/list",
      params: { limit: 100, includeHidden: false },
    }));
  });

  it("declines a reverse request with a clean id but never echoes one carrying a control character", async () => {
    const harness = await createHarness((request) => {
      if (request.method === "initialize") return standardInitialize(request);
      if (request.method === "account/logout") return {};
      throw new Error(`Unexpected App Server request: ${String(request.method)}`);
    });

    await harness.client.logout();
    harness.server.stdout.write(`${JSON.stringify({
      id: "clean-reverse-id",
      method: "item/tool/requestUserInput",
    })}\n`);
    harness.server.stdout.write(`${JSON.stringify({
      id: "tainted\u0007reverse\u0000id",
      method: "item/tool/requestUserInput",
    })}\n`);
    // Round-trips after both reverse requests, so anything the client wrote in response to them has already been consumed by the fake App Server.
    await harness.client.logout();

    const echoed = harness.server.requests
      .filter((request) => typeof request.id === "string")
      .map((request) => request.id);
    expect(echoed).toEqual(["clean-reverse-id"]);
    expect(harness.server.requests).toContainEqual(expect.objectContaining({
      id: "clean-reverse-id",
      error: { code: -32601, message: "Unsupported request" },
    }));
  });
});

vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
// The platform is simulated, so plain-start PATH lookups are pinned by name rather than run against this host.
vi.mock("../../shared/host-program-path.js", async (original) => ({
  ...await original<typeof import("../../shared/host-program-path.js")>(),
  findHostProgram: (name: string) => `C:/resolved/${name}`,
  resolveHostProgram: (name: string) => `C:/resolved/${name}`,
}));
vi.mock("../sandbox-process-home.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedSandboxProcessHome(await original()));

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { setAveHomePrivacyAtBoot, _resetAveHomePrivacyForTest } from "../../shared/ave-home.js";
import { setPluginWorkerConfinementRequestedAtBoot, setWindowsSandboxSubstrate, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest } from "../sandbox-capability.js";
import { planWindowsSandbox } from "../../boot/steps/windows-sandbox-plan.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, EXTENSION_START_CONSENT_REQUIRED_CODE, mcpStdioStartKey, pluginChildStartKey,
  setExtensionStartAsker, settlePendingExtensionStarts, takeExtensionStartGrant, workerStartKey, type ExtensionStartAsker, type PendingExtensionStart,
} from "../extension-start-consent.js";
import { spawnWorker } from "../worker-spawn.js";
import { spawnConfinedChild } from "../confined-child.js";
import { TEST_WORKER_EGRESS_OWNER } from "../../__tests__/support/egress-fixture.js";
import { McpClient } from "../../mcp/mcp-client.js";
import { ToolRegistry } from "../../tools/registry.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { governanceWithPolicy, stdioApproval, buildPolicy, FakeChildProcess } from "../../mcp/__tests__/test-helpers.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { spawnConfinedPluginChild } from "../../plugins/isolation/out-of-process-plugin.js";
import { runOneHookScript, type RunnableHook } from "../../hooks/script-hook-runner.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn,
}));
vi.mock("../../main/managed-child-processes.js", async (original) => ({
  ...await original<typeof import("../../main/managed-child-processes.js")>(),
  trackManagedChildProcess: vi.fn(),
}));

const ORIGINAL_PLATFORM = process.platform;
const home = useTempDirs("ave-home-extension-starts-");
const TURN = { allowExternalHooks: true, headless: false, approvalSurface: "interactive" as const };
let path: string;
let ask: Mock<ExtensionStartAsker["ask"]>;
let notify: Mock<ExtensionStartAsker["notify"]>;

function unverifiedHome(category: "read-back-failed" | "helper-unavailable" = "read-back-failed"): void {
  _resetAveHomePrivacyForTest();
  setAveHomePrivacyAtBoot({ enforcement: "none", home: path, category, reason: "fixture" });
}

/** A person answers yes for this start; the consent waits under its key for the start to take. */
async function approve(key: string, kind: PendingExtensionStart["kind"], cause: PendingExtensionStart["cause"]): Promise<void> {
  deferExtensionStart({ key, kind, label: key, cause });
  await settlePendingExtensionStarts({ sessionId: "privacy", attended: true });
}

describe.each([
  { cause: "home-privacy-unverified" as const, arrange: () => unverifiedHome() },
  { cause: "no-backend" as const, arrange: () => {
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: path, sid: "S-1-5-21-1" });
    setWindowsSandboxSubstrate(planWindowsSandbox({ shellRequested: false, workerRequested: true, mxc: { state: "available" },
      extensionMxc: { state: "unavailable", reason: "runtime-start-failed" }, windowsBuild: null, srtWinReady: false }).substrate);
  } },
])("extension spawn boundaries with nothing to confine the start ($cause)", ({ cause, arrange }) => {
  beforeEach(() => {
    setProcessPlatform("win32");
    setPluginWorkerConfinementRequestedAtBoot(true);
    path = home();
    arrange();
    spawn.mockReset();
    ask = vi.fn<ExtensionStartAsker["ask"]>(async () => "yes");
    notify = vi.fn<ExtensionStartAsker["notify"]>();
    setExtensionStartAsker({ ask, notify });
  });
  afterEach(() => {
    __resetExtensionStartsForTest();
    _resetAveHomePrivacyForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
    setProcessPlatform(ORIGINAL_PLATFORM);
  });

  it("never spawns an out-of-process child without a consent, spends one consent at its spawn and refuses its reuse", async () => {
    const key = pluginChildStartKey("privacy");
    const spec = { pluginId: "privacy", envelope: { read: [path], write: [path] },
      socketDir: join(path, "sockets"),
      launch: { kind: "entry" as const, childEntryPath: join(path, "child.mjs") } };
    await expect(spawnConfinedPluginChild(spec)).rejects.toMatchObject({ code: EXTENSION_START_CONSENT_REQUIRED_CODE, unconfinedCause: cause });
    expect(spawn).not.toHaveBeenCalled();
    await approve(key, "plugin-child", cause);
    const extensionStart = takeExtensionStartGrant(key);
    spawn.mockImplementation(() => { throw new Error("fixture spawn reached"); });
    await expect(spawnConfinedPluginChild({ ...spec, extensionStart })).rejects.toThrow("fixture spawn reached");
    expect(spawn).toHaveBeenCalledTimes(1);
    // The same consent again: a second start has to be asked for.
    await expect(spawnConfinedPluginChild({ ...spec, extensionStart })).rejects.toMatchObject({ code: EXTENSION_START_CONSENT_REQUIRED_CODE });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks the hook's own session, runs the hook once per yes and never in a headless turn", async () => {
    const hook: RunnableHook = { id: "privacy", hookType: "pre", configDir: path, command: ["privacy-hook.exe"],
      hookPath: join(path, "hook.exe"), confinement: { kind: "bundled", pluginId: "privacy", dataDir: path, generationRoot: path } };
    const payload = { hookType: "pre" as const, toolName: "fs_read", source: "builtin" as const,
      category: "read" as const, input: {}, sessionId: "hook-session", trustOrigin: "user-keyboard" as const };
    spawn.mockImplementation(() => {
      const running = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        running.stdout.end('{"action":"allow","reason":"fixture"}');
        running.emit("close", 0);
      });
      return running;
    });
    await expect(turnExtensionPolicyContext.run({ ...TURN, headless: true }, () => runOneHookScript(hook, payload))).resolves.toMatchObject({
      decision: "deny", reason: expect.stringContaining(EXTENSION_START_CONSENT_REQUIRED_CODE) });
    await expect(runOneHookScript(hook, payload)).resolves.toMatchObject({ decision: "deny" });
    expect(ask).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    await expect(turnExtensionPolicyContext.run(TURN, () => runOneHookScript(hook, payload))).resolves.toMatchObject({ decision: "allow", reason: "fixture" });
    await expect(turnExtensionPolicyContext.run(TURN, () => runOneHookScript(hook, payload))).resolves.toMatchObject({ decision: "allow", reason: "fixture" });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls.map(([, session]) => (session as { sessionId: string }).sessionId)).toEqual(["hook-session", "hook-session"]);
    ask.mockResolvedValueOnce("no");
    await expect(turnExtensionPolicyContext.run(TURN, () => runOneHookScript(hook, payload))).resolves.toMatchObject({ decision: "deny" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each(["plugin worker", "plugin child", "MCP stdio"])("never starts %s without a consent, starts it once on a yes and asks again for the next start", async (kind) => {
    let client: McpClient | undefined;
    const key = kind === "plugin worker" ? workerStartKey("privacy", "worker") : kind === "plugin child" ? pluginChildStartKey("privacy") : mcpStdioStartKey("privacy");
    const start = async () => {
      if (kind === "plugin worker") {
        return spawnWorker({ pluginId: "privacy", workerId: "worker", control: "output-only-v1", command: "privacy-worker.exe",
          extensionStart: takeExtensionStartGrant(key) });
      }
      if (kind === "plugin child") {
        return spawnConfinedChild({ command: "privacy-child.exe", args: [], label: "plugin-child:privacy",
          baseEnv: {}, grantMode: "deny-only", egressOwner: TEST_WORKER_EGRESS_OWNER,
          extensionStart: { key, authority: takeExtensionStartGrant(key) } });
      }
      client = new McpClient({ id: "privacy", transport: "stdio", command: "privacy-server.exe", args: [] },
        governanceWithPolicy(buildPolicy([stdioApproval("privacy", "privacy-server.exe")])), new ToolRegistry(), unusedNetworkFetch);
      return client.connect();
    };
    await expect(start()).rejects.toThrow(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(spawn).not.toHaveBeenCalled();
    const before = readdirSync(path);
    await approve(key, kind === "MCP stdio" ? "mcp-stdio" : kind === "plugin worker" ? "worker" : "plugin-child", cause);
    expect(readdirSync(path)).toEqual(before);
    if (kind === "MCP stdio") {
      const child = new FakeChildProcess();
      child.responses = {
        "server/discover": (id) => ({ id, resultType: "complete", ttlMs: 0, cacheScope: "public",
          supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "privacy", version: "1" } }),
        initialize: (id) => ({ id, protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "privacy", version: "1" } }),
        "tools/list": () => ({ tools: [] }),
      };
      spawn.mockReturnValueOnce(child);
    } else {
      spawn.mockReturnValueOnce(Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }));
    }
    await start();
    expect(spawn).toHaveBeenCalledTimes(1);
    if (client) await client.disconnect();
    await expect(start()).rejects.toThrow(EXTENSION_START_CONSENT_REQUIRED_CODE);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("the privacy helper gave no answer", () => {
  beforeEach(() => {
    setProcessPlatform("win32");
    setPluginWorkerConfinementRequestedAtBoot(true);
    path = home();
    unverifiedHome("helper-unavailable");
    spawn.mockReset();
    setExtensionStartAsker({ ask: vi.fn(async () => "yes" as const), notify: vi.fn() });
  });
  afterEach(() => {
    __resetExtensionStartsForTest();
    _resetAveHomePrivacyForTest();
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(ORIGINAL_PLATFORM);
  });

  it("offers no start without isolation, even with a consent", async () => {
    const key = pluginChildStartKey("privacy");
    await approve(key, "plugin-child", "home-privacy-unverified");
    await expect(spawnConfinedChild({ command: "privacy-child.exe", args: [], label: "plugin-child:privacy",
      baseEnv: {}, grantMode: "deny-only", egressOwner: TEST_WORKER_EGRESS_OWNER,
      extensionStart: { key, authority: takeExtensionStartGrant(key) } })).rejects.toThrow("Restart Ave");
    expect(spawn).not.toHaveBeenCalled();
  });
});

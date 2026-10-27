vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { setAveHomePrivacyAtBoot, approveExtensionsWithoutIsolation, _resetAveHomePrivacyForTest } from "../../shared/ave-home.js";
import { setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } from "../sandbox-capability.js";
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
let path: string;
beforeEach(() => {
  setProcessPlatform("win32");
  setPluginWorkerConfinementRequestedAtBoot(true);
  path = home();
  setAveHomePrivacyAtBoot({ enforcement: "none", home: path, category: "read-back-failed", reason: "fixture" });
  spawn.mockReset();
});
afterEach(() => {
  _resetAveHomePrivacyForTest();
  __resetSandboxRequestedAtBootForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
});

describe("private-home refusal at extension spawn boundaries", () => {
  it("refuses an out-of-process child before approval and reaches spawn only after approval", async () => {
    const spec = { pluginId: "privacy", envelope: { read: [path], write: [path] },
      socketDir: join(path, "sockets"), workerRunRoot: join(path, "run"),
      launch: { kind: "entry" as const, childEntryPath: join(path, "child.mjs") } };
    await expect(spawnConfinedPluginChild(spec)).rejects.toThrow(`read-back-failed, ${path}`);
    expect(spawn).not.toHaveBeenCalled();
    approveExtensionsWithoutIsolation();
    spawn.mockImplementationOnce(() => { throw new Error("fixture spawn reached"); });
    await expect(spawnConfinedPluginChild(spec)).rejects.toThrow("fixture spawn reached");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("denies a hook requesting confinement before approval and runs it after approval", async () => {
    const hook: RunnableHook = { id: "privacy", hookType: "pre", command: ["privacy-hook.exe"],
      hookPath: join(path, "hook.exe"), confinement: { kind: "bundled", pluginId: "privacy", dataDir: path, generationRoot: path } };
    const payload = { hookType: "pre" as const, toolName: "fs_read", source: "builtin" as const,
      category: "read" as const, input: {}, sessionId: "privacy", trustOrigin: "user-keyboard" as const };
    await expect(runOneHookScript(hook, payload)).resolves.toMatchObject({ decision: "deny",
      reason: expect.stringContaining("Approve running without isolation in Settings > Permissions") });
    expect(spawn).not.toHaveBeenCalled();
    approveExtensionsWithoutIsolation();
    spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stdout.end('{"action":"allow","reason":"fixture"}');
        child.emit("close", 0);
      });
      return child;
    });
    await expect(runOneHookScript(hook, payload)).resolves.toMatchObject({ decision: "allow", reason: "fixture" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["plugin worker", "plugin child", "MCP stdio"])("refuses %s before approval, permits its plain spawn after approval and refuses again next boot", async (kind) => {
    let client: McpClient | undefined;
    const start = async () => {
      if (kind === "plugin worker") {
        return spawnWorker({ pluginId: "privacy", workerId: "worker", command: "privacy-worker.exe" });
      }
      if (kind === "plugin child") {
        return spawnConfinedChild({ command: "privacy-child.exe", args: [], label: "plugin-child:privacy",
          baseEnv: {}, grantMode: "deny-only", egressOwner: TEST_WORKER_EGRESS_OWNER });
      }
      client = new McpClient({ id: "privacy", transport: "stdio", command: "privacy-server.exe", args: [] },
        governanceWithPolicy(buildPolicy([stdioApproval("privacy", "privacy-server.exe")])), new ToolRegistry(), unusedNetworkFetch);
      return client.connect();
    };
    await expect(start()).rejects.toThrow(`read-back-failed, ${path}`);
    expect(spawn).not.toHaveBeenCalled();
    const before = readdirSync(path);
    approveExtensionsWithoutIsolation();
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
    _resetAveHomePrivacyForTest();
    setAveHomePrivacyAtBoot({ enforcement: "none", home: path, category: "read-back-failed", reason: "fixture" });
    await expect(start()).rejects.toThrow("Approve running without isolation in Settings > Permissions");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { egressInvocationOwner } from "../../permissions/egress-invocations.js";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { MAX_HOOK_STDOUT_BYTES, type ScriptHookStdin } from "../script-hook-types.js";

const SANDBOX_TEMP_ROOT = "/tmp/ave-test-sandbox-tmp";
let sandboxActive = false;
let admissionOpen = true;
const wrap = vi.fn<(cmdline: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>>();
vi.mock("../../main/managed-child-processes.js", async (original) => {
  const real = await original<typeof import("../../main/managed-child-processes.js")>();
  return { ...real, assertManagedChildProcessAdmissionOpen: (label: string) => {
    if (!admissionOpen) throw new Error("hook admission closed");
    return real.assertManagedChildProcessAdmissionOpen(label);
  } };
});
vi.mock("../../permissions/asrt-sandbox.js", async (original) => {
  const real = await original<typeof import("../../permissions/asrt-sandbox.js")>();
  return { ...real, isAsrtSandboxActive: () => sandboxActive, isPluginWorkerConfinementActive: () => sandboxActive,
    wrapWorkerCommand: (cmdline: string, options?: unknown) => wrap(cmdline, options), cleanupAsrtSandboxAfterCommand: vi.fn(async () => undefined),
    // Not the real one: it creates `<AVE_HOME>/sandbox/tmp/…`, and this file does not isolate AVE_HOME.
    ensureSandboxTempPrincipalDir: (principal: SandboxTempPrincipal) => ({
      dir: join(SANDBOX_TEMP_ROOT, real.sandboxTempPrincipalDirName(principal)), root: SANDBOX_TEMP_ROOT }) };
});

// Relay streams must carry hook input and verdicts even when the child pipes are hidden.
interface WindowsSpawnCall {
  label: string; command: string; args: readonly string[]; baseEnv: NodeJS.ProcessEnv;
  cwd?: string; allowRead: readonly string[]; allowWrite: readonly string[];
}
const windowsSpawns: WindowsSpawnCall[] = [];
const releaseHoldMock = vi.fn();
let failWindowsSpawn: Error | undefined;
let failWrappedEnv: Error | undefined;
vi.mock("../../sandbox/wrap-bundled-command.js", async (original) => {
  const real = await original<typeof import("../../sandbox/wrap-bundled-command.js")>();
  const { spawn } = await import("node:child_process");
  const { PassThrough } = await import("node:stream");
  return { ...real, bundledWrappedEnv: (...args: Parameters<typeof real.bundledWrappedEnv>) => {
    if (failWrappedEnv !== undefined) throw failWrappedEnv;
    return real.bundledWrappedEnv(...args);
  }, spawnWindowsBundledProcess: async (call: WindowsSpawnCall) => {
    windowsSpawns.push(call);
    if (failWindowsSpawn !== undefined) throw failWindowsSpawn;
    const command = call.command === "node" ? process.execPath : call.command;
    const child = spawn(command, [...call.args], { cwd: call.cwd, env: { ...process.env, ...call.baseEnv, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.pipe(child.stdin);
    child.stdout.pipe(stdout);
    Object.defineProperty(child, "stdin", { value: null });
    Object.defineProperty(child, "stdout", { value: null });
    return { child, stdin, stdout, releaseHold: releaseHoldMock };
  } };
});

import { runOneHookScript } from "../script-hook-runner.js";
import { appOwnedSandboxPrivateRoots, cleanupAsrtSandboxAfterCommand, type SandboxTempPrincipal } from "../../permissions/asrt-sandbox.js";
import {
  __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setActiveSandboxCapability, setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";

const root = mkdtempSync(join(tmpdir(), "ave-bundled-hook-runner-"));
const generationRoot = join(root, "generation");
const dataDir = join(root, "data");
mkdirSync(generationRoot); mkdirSync(dataDir);
const script = join(generationRoot, "hook.cjs");
const payload: ScriptHookStdin = { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin",
  category: "read", input: {}, sessionId: "runner", trustOrigin: "user-keyboard" };
const runnable = () => ({ id: "hook", hookType: "pre" as const, source: "config" as const,
  hookPath: script, command: ["node", script], confinement: { kind: "bundled" as const, pluginId: "hook-plugin", dataDir, generationRoot } });

// User hooks require the shell sandbox and full confinement capability; worker-only confinement does not apply.
function activateShellSandbox(): void {
  sandboxActive = true;
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: "darwin", reason: "test shell sandbox",
    confines: { filesystem: true, process: true, network: true } });
}

afterEach(() => { __resetSandboxRequestedAtBootForTest(); __resetActiveSandboxCapabilityForTest(); sandboxActive = false; admissionOpen = true; wrap.mockReset(); vi.restoreAllMocks(); windowsSpawns.length = 0; releaseHoldMock.mockReset(); failWindowsSpawn = undefined; failWrappedEnv = undefined; });
afterAll(async () => { await cleanupTmpDir(root); });

describe("bundled hook runner", () => {
  it("applies the active wrapper to a user hook with its cwd write scope", async () => {
    writeFileSync(script, "process.stdout.write(JSON.stringify({action:'allow',reason:'wrapped user hook'}))");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    activateShellSandbox();
    wrap.mockResolvedValueOnce({ argv: ["node", script], env: {} });
    const { confinement: _confinement, ...userHook } = runnable();
    const result = await runOneHookScript(userHook, payload, { cwd: dataDir });
    expect(result.decision, result.reason).toBe("allow");
    const options = wrap.mock.calls[0]![1] as { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[] } };
    expect(options.filesystem.allowRead).not.toContain(script);
    const hostTemp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
    if (hostTemp) expect(options.filesystem.allowRead).not.toContain(hostTemp);
    expect(options.filesystem.allowWrite).toContain(dataDir);
    expect(options.filesystem.allowWrite).not.toContain(generationRoot);
    expect(options.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
    expect(options.filesystem.denyWrite.length).toBeGreaterThan(0);
  });

  it("never grants a secret-path read merely because a command uses it as an anchor", async () => {
    writeFileSync(script, "process.stdout.write(JSON.stringify({action:'allow',reason:'wrapped'}))");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    activateShellSandbox();
    wrap.mockResolvedValueOnce({ argv: ["node", script], env: {} });
    const protectedAnchor = join(homedir(), ".ssh", "fixture-private.cjs");
    const result = await runOneHookScript({ id: "protected-anchor", hookType: "pre", source: "config",
      hookPath: protectedAnchor, command: ["node", protectedAnchor] }, payload, { cwd: dataDir });
    expect(result.decision).toBe("allow");
    const options = wrap.mock.calls[0]![1] as { filesystem: { allowRead: string[]; denyRead: string[] } };
    expect(options.filesystem.allowRead).not.toContain(protectedAnchor);
    expect(options.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
  });

  it("refuses user hook execution if the active wrapper fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    activateShellSandbox();
    wrap.mockRejectedValueOnce(new Error("user hook wrap failed"));
    const { confinement: _confinement, ...userHook } = runnable();
    expect(await runOneHookScript(userHook, payload, { cwd: dataDir }))
      .toMatchObject({ decision: "deny", reason: "sandbox unavailable: user hook wrap failed" });
  });

  it("refuses a user hook whose permission is revoked during sandbox preparation", async () => {
    writeFileSync(script, "process.stdout.write(JSON.stringify({action:'allow',reason:'should not run'}))");
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    activateShellSandbox();
    let allowed = true;
    wrap.mockImplementationOnce(async () => {
      allowed = false;
      return { argv: ["node", script], env: {} };
    });
    const { confinement: _confinement, ...userHook } = runnable();
    const result = await runOneHookScript(userHook, payload, { cwd: dataDir,
      authorizeCommand: async () => ({ decision: "allow", reason: "initial admission", assertAllowed: () => {
        if (!allowed) throw new Error("permission revoked");
      } }),
    });
    expect(result).toMatchObject({ decision: "deny", rawStdout: "", reason: "hook command denied before spawn: permission revoked" });
  });

  it("does not wrap a user hook when ASRT runs only for plugin workers", async () => {
    writeFileSync(script, "process.stdout.write(JSON.stringify({action:'allow',reason:'unwrapped user hook'}))");
    sandboxActive = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const { confinement: _confinement, ...userHook } = runnable();
    const result = await runOneHookScript(userHook, payload, { cwd: dataDir });
    expect(result.decision, result.reason).toBe("allow");
    expect(wrap).not.toHaveBeenCalled();
  });

  it("spawns the script with the sealed cwd, scoped env, and stdin envelope", async () => {
    writeFileSync(script, `const fs = require('node:fs'); let input = ''; process.stdin.on('data', (part) => input += part);
process.stdin.on('end', () => process.stdout.write(JSON.stringify({action:'allow',reason:JSON.stringify({cwd:fs.realpathSync(process.cwd())===fs.realpathSync(process.env.PLUGIN_ROOT),root:process.env.PLUGIN_ROOT?.includes('generation'),data:process.env.PLUGIN_DATA?.includes('data'),event:JSON.parse(input).event})})));`);
    const result = await runOneHookScript(runnable(), payload);
    expect(result.decision).toBe("allow");
    expect(JSON.parse(result.reason)).toEqual({ cwd: true, root: true, data: true, event: "pre" });
  });

  it("denies a blocking event when wrapping fails before spawn", async () => {
    sandboxActive = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    wrap.mockRejectedValueOnce(new Error("wrap failed"));
    const result = await runOneHookScript(runnable(), payload);
    expect(result).toMatchObject({ decision: "deny", reason: expect.stringContaining("sandbox unavailable") });
    expect(result.reason).toContain("wrap failed");
  });

  it("releases the egress invocation and the wrap when composing its environment fails", async () => {
    sandboxActive = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    wrap.mockResolvedValueOnce({ argv: ["node", script], env: {} });
    failWrappedEnv = new Error("env failed");
    vi.mocked(cleanupAsrtSandboxAfterCommand).mockClear();
    const result = await runOneHookScript(runnable(), payload);
    expect(result).toMatchObject({ decision: "deny", reason: expect.stringContaining("env failed") });
    const token = (wrap.mock.calls[0]![1] as { commandId: string }).commandId;
    expect(egressInvocationOwner(token)).toBeUndefined();
    expect(cleanupAsrtSandboxAfterCommand).toHaveBeenCalledOnce();
  });

  it("checks process admission before allocating a sandbox wrap", async () => {
    sandboxActive = true;
    admissionOpen = false;
    await expect(runOneHookScript(runnable(), payload)).rejects.toThrow("hook admission closed");
    expect(wrap).not.toHaveBeenCalled();
  });

  it("passes the data-only write grant and sensitive deny floors to the wrapper", async () => {
    writeFileSync(script, "process.stdout.write(JSON.stringify({action:'allow',reason:'wrapped'}))");
    sandboxActive = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    wrap.mockResolvedValueOnce({ argv: ["node", script], env: {} });
    const result = await runOneHookScript(runnable(), payload);
    expect(result.decision).toBe("allow");
    const [cmdline, raw] = wrap.mock.calls[0]!;
    const token = (raw as { commandId: string }).commandId;
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(egressInvocationOwner(token)).toBeUndefined();
    const options = raw as { filesystem: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] } };
    expect(options.filesystem.allowWrite).toContain(dataDir);
    expect(options.filesystem.allowWrite).not.toContain(generationRoot);
    // Its plugin's temp directory, set as TMPDIR inside the wrap, granted alone; the shared root holding every other principal's is read-denied.
    const tempDir = join(SANDBOX_TEMP_ROOT, `plugin-${Buffer.from("hook-plugin").toString("hex")}`);
    expect(cmdline.startsWith(`'/usr/bin/env' 'TMPDIR=${tempDir}' 'TMP=${tempDir}' 'TEMP=${tempDir}' 'node' `)).toBe(true);
    expect(options.filesystem.allowWrite).toContain(tempDir);
    expect(options.filesystem.allowWrite).not.toContain(SANDBOX_TEMP_ROOT);
    expect(options.filesystem.denyRead).toEqual(expect.arrayContaining(appOwnedSandboxPrivateRoots()));
    expect(options.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
    expect(options.filesystem.denyWrite.length).toBeGreaterThan(0);
    // Another plugin's directories are refused: the plugins root is denied, and the hook's own generation is the read re-allow inside it.
    const reach = raw as { filesystem: { allowRead: string[]; denyPluginsRoot?: boolean } };
    expect(reach.filesystem.denyPluginsRoot).toBe(true);
    expect(reach.filesystem.allowRead).toContain(generationRoot);
    expect(reach.filesystem.allowRead).toContain(dataDir);
  });

  it("runs a Windows sandboxed hook through the relay with its own grant, and reads only the relayed streams", async () => {
    writeFileSync(script, `let input = ''; process.stdin.on('data', (part) => input += part);
process.stdin.on('end', () => process.stdout.write(JSON.stringify({action:'allow',reason:JSON.parse(input).event + ' via relay'})));`);
    sandboxActive = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await runOneHookScript(runnable(), payload);
    expect(result).toMatchObject({ decision: "allow", reason: "pre via relay", exitCode: 0 });
    expect(windowsSpawns).toHaveLength(1);
    const call = windowsSpawns[0]!;
    expect(call.label).toBe("hook:hook-plugin");
    expect(call.allowRead).toEqual([generationRoot]);
    expect(call.allowWrite).toEqual([dataDir]);
    expect(call.cwd).toBe(generationRoot);
    expect(call.baseEnv.PLUGIN_ROOT).toBe(generationRoot);
    expect(call.baseEnv.PLUGIN_DATA).toBe(dataDir);
    // The POSIX wrap is not used, and what the spawn held is released.
    expect(wrap).not.toHaveBeenCalled();
    expect(releaseHoldMock).toHaveBeenCalled();
  });

  it("denies a Windows sandboxed hook whose relayed spawn fails, before anything runs", async () => {
    sandboxActive = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    failWindowsSpawn = new Error("grant refused");
    const result = await runOneHookScript(runnable(), payload);
    expect(result).toMatchObject({ decision: "deny", reason: "sandbox unavailable: grant refused" });
  });

  it("keeps timeout and captured output ceilings for bundled hooks", async () => {
    writeFileSync(script, "setInterval(() => {}, 1000)");
    const timed = await runOneHookScript(runnable(), payload, { timeoutMs: 100 });
    expect(timed).toMatchObject({ decision: "deny", timedOut: true });
    writeFileSync(script, `process.stdout.write('x'.repeat(${MAX_HOOK_STDOUT_BYTES * 2}))`);
    const capped = await runOneHookScript(runnable(), payload);
    expect(capped.decision).toBe("deny");
    expect(Buffer.byteLength(capped.rawStdout)).toBeLessThanOrEqual(MAX_HOOK_STDOUT_BYTES);
  });
});

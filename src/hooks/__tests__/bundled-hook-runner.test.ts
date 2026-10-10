import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  return { ...real, isAsrtSandboxActive: () => sandboxActive,
    wrapWorkerCommand: (cmdline: string, options?: unknown) => wrap(cmdline, options), cleanupAsrtSandboxAfterCommand: vi.fn(async () => undefined),
    // Not the real one: it creates `<AVE_HOME>/sandbox/tmp/…`, and this file does not isolate AVE_HOME.
    ensureSandboxTempPrincipalDir: (principal: { kind: "plugin" | "mcp"; id: string }) => ({
      dir: join(SANDBOX_TEMP_ROOT, real.sandboxTempPrincipalDirName(principal)), root: SANDBOX_TEMP_ROOT }) };
});

import { runOneHookScript } from "../script-hook-runner.js";
import { appOwnedSandboxPrivateRoots } from "../../permissions/asrt-sandbox.js";

const root = mkdtempSync(join(tmpdir(), "ave-bundled-hook-runner-"));
const generationRoot = join(root, "generation");
const dataDir = join(root, "data");
mkdirSync(generationRoot); mkdirSync(dataDir);
const script = join(generationRoot, "hook.cjs");
const payload: ScriptHookStdin = { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin",
  category: "read", input: {}, sessionId: "runner", trustOrigin: "user-keyboard" };
const runnable = () => ({ id: "hook", hookType: "pre" as const, source: "config" as const,
  hookPath: script, command: ["node", script], confinement: { kind: "bundled" as const, pluginId: "hook-plugin", dataDir, generationRoot } });

afterEach(() => { sandboxActive = false; admissionOpen = true; wrap.mockReset(); vi.restoreAllMocks(); });
afterAll(async () => { await cleanupTmpDir(root); });

describe("bundled hook runner", () => {
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
    const options = raw as { filesystem: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] } };
    expect(options.filesystem.allowWrite).toContain(dataDir);
    expect(options.filesystem.allowWrite).not.toContain(generationRoot);
    // Its plugin's temp directory, set as TMPDIR inside the wrap, granted alone;
    // the shared root holding every other principal's is read-denied.
    const tempDir = join(SANDBOX_TEMP_ROOT, `plugin-${Buffer.from("hook-plugin").toString("hex")}`);
    expect(cmdline.startsWith(`'/usr/bin/env' 'TMPDIR=${tempDir}' 'TMP=${tempDir}' 'TEMP=${tempDir}' 'node' `)).toBe(true);
    expect(options.filesystem.allowWrite).toContain(tempDir);
    expect(options.filesystem.allowWrite).not.toContain(SANDBOX_TEMP_ROOT);
    expect(options.filesystem.denyRead).toEqual(expect.arrayContaining(appOwnedSandboxPrivateRoots()));
    expect(options.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
    expect(options.filesystem.denyWrite.length).toBeGreaterThan(0);
    // Another plugin's directories are refused: the plugins root is denied,
    // and the hook's own generation is the read re-allow inside it.
    const reach = raw as { filesystem: { allowRead: string[]; denyPluginsRoot?: boolean } };
    expect(reach.filesystem.denyPluginsRoot).toBe(true);
    expect(reach.filesystem.allowRead).toContain(generationRoot);
    expect(reach.filesystem.allowRead).toContain(dataDir);
  });

  it("refuses the bundled path on Windows with the sandbox on", async () => {
    sandboxActive = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await runOneHookScript(runnable(), payload);
    expect(result).toMatchObject({ decision: "deny", reason: expect.stringContaining("Windows") });
    expect(wrap).not.toHaveBeenCalled();
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

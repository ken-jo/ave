import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";

function section(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Missing source section: ${from}`);
  return source.slice(start, end);
}

function appearsInOrder(source: string, ...fragments: string[]): boolean {
  let previous = -1;
  for (const fragment of fragments) {
    const position = source.indexOf(fragment);
    if (position <= previous) return false;
    previous = position;
  }
  return true;
}

const offline = readRepoFile("src/permissions/offline-process-sandbox.ts");
const scanner = section(offline, "async function runOfflineScan", "function within");
const confirmScanner = "if (!confirmed) throw new OfflineScanExitUnconfirmedError()";
const returnScan = "if (scan.ok) return scan.value";

function scannerWaitsForVerdict(source: string): boolean {
  return appearsInOrder(source, "const child = start(acquired =>", "acquired.once(\"close\"", "observeManagedWindowsJobExit(acquired",
    "await waitForManagedProcessGroupExit", confirmScanner, returnScan);
}

function relayWatchesExitAndStopsOnFailure(source: string): boolean {
  return appearsInOrder(source, "assertStillValid();", "child = spawn(program", "noteSpawn(child)", "trackManagedChildProcess(child",
    "const exited = new Promise", "child.once(\"exit\", (code, signal) => resolve(", "child.once(\"error\", (error) => resolve(error.message))",
    "relayStdioOverLoopback(", "    exited,", "timeoutMs: WINDOWS_RELAY_CONNECT_TIMEOUT_MS",
    "onFailure: (error)", "child.kill();", "stdin: relayed.stdin");
}

function hookStopsAfterAuthorityRefresh(source: string): boolean {
  const aborted = section(source, "if (abortSignal?.aborted)", "if (admittedPlan && !isHookShellPlanCurrent");
  const changedPlan = section(source, "if (admittedPlan && !isHookShellPlanCurrent", "if (refreshError !== undefined)");
  const denied = section(source, "if (refreshError !== undefined)", "if (contained)");
  return appearsInOrder(aborted, "if (windowsSpawn) await forceKillManagedChildProcess(windowsSpawn.child, \"hook caller aborted\")",
    "cleanupWrap?.();", "return deny(")
    && appearsInOrder(changedPlan, "forceKillManagedChildProcess(windowsSpawn.child, \"hook shell policy changed\")",
      "cleanupWrap?.();", "return deny(")
    && appearsInOrder(denied, "forceKillManagedChildProcess(windowsSpawn.child, \"hook command permission changed\")",
      "cleanupWrap?.();", "return deny(");
}

function directHookStopsAndSettles(source: string): boolean {
  const abort = section(source, "const onAbort =", "try {");
  const output = section(source, "const outputDrained", "const stdoutChunks");
  const finish = section(source, "const finish =", "    timer = setTimeout");
  const timeout = section(source, "    timer = setTimeout", "child.on(\"close\"");
  const close = section(source, "child.on(\"close\"", "child.on(\"error\"");
  const error = section(source, "child.on(\"error\"", "if (cancelled || abortSignal?.aborted)");
  const write = source.slice(source.indexOf("hookStdin?.write(stdinJson)"));
  return appearsInOrder(abort, "cancelled = true", "clearTimeout(timeoutFallback)",
    "forceKillManagedChildProcess(child, \"hook caller aborted\")", "abortSignal?.addEventListener(\"abort\", onAbort")
    && appearsInOrder(output, "stdout.once(\"end\", done)", "stdout.once(\"close\", done)", "setTimeout(done, 1_000).unref()")
    && appearsInOrder(finish, "if (settled) return", "cleanupWrap?.();", "resolve(hookOutcome(")
    && appearsInOrder(timeout, "timedOut = true", "forceKillManagedChildProcess(child, \"hook timeout\")",
      "timeoutFallback = setTimeout(() => finish(child.exitCode), 1000)")
    && close.includes("void outputDrained.then(() => finish(code, signal))")
    && appearsInOrder(error, "if (settled) return", "cleanupWrap?.();", "resolve({")
    && appearsInOrder(write, "forceKillManagedChildProcess(child, \"hook stdin write failed\")", "cleanupWrap?.();", "resolve({");
}

function containedHookAwaitsRelease(source: string): boolean {
  return appearsInOrder(source, "const stop = (): void => { void holder.release().catch",
    "timedOut = true; stop();", "cancelled = true; stop();", "input.abortSignal?.addEventListener(\"abort\", onAbort",
    "if (input.abortSignal?.aborted) onAbort()", "writeError = error as Error;\n    stop();",
    "input.timeoutMs + TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs", "settleTimer = setTimeout(",
    "await Promise.race([owned.completion, unsettled])", "if (result === \"unsettled\") {\n      stop();",
    "return deny(t(\"be_scriptHookRunner.containedSettleDeadline\"", "await Promise.race([stdoutEnded,",
    "await holder.release();", "return deny(t(\"be_scriptHookRunner.containedTerminationUnverified\"", "return input.outcome(");
}

function grantStopsBeforeCleanup(source: string): boolean {
  const release = section(source, "const releaseHold", "let wrapped");
  const running = section(source, "held.onLost", "return { child: running");
  const failure = source.slice(source.indexOf("return { child: running"));
  return appearsInOrder(release, "grant?.release();", "sandboxHome.cleanup();")
    && appearsInOrder(running, "held.onLost(", "terminateChildBestEffort(running);", "running.once(\"error\"",
      "if (running.pid === undefined) releaseHold();")
    && appearsInOrder(failure, "catch (error)", "if (child !== undefined) terminateChildBestEffort(child);",
      "if (wrapped) void cleanupAsrtSandboxAfterCommand();", "releaseHold();", "throw error");
}

const hook = readRepoFile("src/hooks/script-hook-runner.ts");
const confined = readRepoFile("src/permissions/confined-child.ts");
const grant = readRepoFile("src/sandbox/wrap-bundled-command.ts");
const windowsReleasePaths = [
  ["Windows relay handshake", section(confined, "export async function spawnConfinedChild", "function assertRelayableSpec"),
    relayWatchesExitAndStopsOnFailure, "child.kill();"],
  ["Windows hook authority refresh", section(hook, "let refreshError: unknown", "const startHook ="),
    hookStopsAfterAuthorityRefresh, "await forceKillManagedChildProcess(windowsSpawn.child, \"hook caller aborted\")"],
  ["direct Windows hook settlement", section(hook, "return new Promise<ScriptHookInvocationResult>", "type HookResultForensics"),
    directHookStopsAndSettles, "void outputDrained.then(() => finish(code, signal));"],
  ["contained Windows hook settlement", section(hook, "async function runContainedHook", "function normalizeRunnable"),
    containedHookAwaitsRelease, "await holder.release();"],
  ["Windows grant teardown", section(grant, "export async function spawnWindowsBundledProcess", "export function hostRuntimeReads"),
    grantStopsBeforeCleanup, "if (child !== undefined) terminateChildBestEffort(child);"],
] as const;

describe("managed process exit source contracts", () => {
  it("acquires the scanner and waits on the managed verdict before success or scratch cleanup", () => {
    expect(scanner.match(/\bspawnManaged\(/gu)).toHaveLength(2);
    expect(scanner.match(/\brunWithCeiling\(/gu)).toHaveLength(1);
    expect(scannerWaitsForVerdict(scanner)).toBe(true);
    expect(appearsInOrder(offline, "await runOfflineScan", "if (error instanceof OfflineScanExitUnconfirmedError)",
      "if (!unconfirmedExit) await rm(scanDirectory", "throw unconfirmedExit ?? error")).toBe(true);
  });

  it("rejects a scanner that returns success ahead of the termination verdict", () => {
    const earlyReturn = scanner.replace(confirmScanner, `${returnScan};\n    ${confirmScanner}`);
    expect(earlyReturn).not.toBe(scanner);
    expect(scannerWaitsForVerdict(earlyReturn)).toBe(false);
  });

  it("acquires the managed process before registering it and requires group absence", () => {
    const managed = readRepoFile("src/main/managed-child-processes.ts");
    const launch = section(managed, "export function spawnManaged(", "export function trackManagedChildProcess");
    expect(appearsInOrder(launch, "assertManagedChildProcessAdmissionOpen(label)", "const child = spawn(",
      "onSpawn?.(child)", "trackChild(child", "return child")).toBe(true);
    const posix = section(managed, "export async function waitForManagedProcessGroupExit", "export function forceKillManagedChildProcess");
    expect(appearsInOrder(posix, "await closed", "while (processExists(-pid))", "return result.ok")).toBe(true);
  });

  it("requires managed launch for direct hooks and group confirmation on the POSIX path", () => {
    expect(hook).not.toMatch(/\bspawn\(/u);
    const group = section(hook, "async function runPosixHook", "async function runContainedHook");
    const afterAcquisition = group.slice(group.indexOf("const { child, closed } = owned"));
    expect(appearsInOrder(afterAcquisition, "if (!await waitForManagedProcessGroupExit", "terminationUnverified",
      "input.release()", "return input.outcome")).toBe(true);
  });

  it("releases the Windows hook wrap and hold through the same cleanup callback", () => {
    const cleanup = section(hook, "const { releaseHold } = windowsSpawn", "else if (sandboxEnabled && process.platform !== \"win32\")");
    expect(appearsInOrder(cleanup, "cleanupWrap = () =>", "if (!cleaned)", "void cleanupAsrtSandboxAfterCommand();",
      "releaseHold();")).toBe(true);
  });

  it.each(windowsReleasePaths)("%s preserves its termination and cleanup steps", (_path, source, check) => {
    expect(check(source)).toBe(true);
  });

  it.each(windowsReleasePaths)("%s rejects a missing termination or wait step", (_path, source, check, step) => {
    const missingStep = source.replace(step, "");
    expect(missingStep).not.toBe(source);
    expect(check(missingStep)).toBe(false);
  });

  it("keeps document runtime cleanup behind its lifetime checks", () => {
    const engine = readRepoFile("src/observation/libreoffice-process.ts");
    const startup = section(engine, "private async createRuntime", "private baseArguments");
    const release = section(engine, "async releaseSession", "async dispose");
    expect(appearsInOrder(startup, "await this.stopRuntime(runtime)", "if (!runtime.unconfirmedExit) await rm(directory")).toBe(true);
    expect(appearsInOrder(release, "await session.tail", "if (session.runtime?.unconfirmedExit) throw", "await rm(session.runtime.directory")).toBe(true);
    expect(appearsInOrder(engine, "await wrapOfflineProcess", "spawnManaged(wrap.argv",
      "runtime.unconfirmedExit = error", "const pid = running.child.pid", "if (gone) break", "running.release()")).toBe(true);
  });
});

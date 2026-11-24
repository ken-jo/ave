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

function statements(source: string): string {
  return source.replace(/^[ \t]*\/\/.*$/gmu, "").replace(/\s+/gu, " ").trim();
}

const offline = readRepoFile("src/permissions/offline-process-sandbox.ts");
const scanner = section(offline, "async function runOfflineScan", "function within");
const confirmScanner = "if (!confirmed) throw new OfflineScanExitUnconfirmedError()";
const returnScan = "if (scan.ok) return scan.value";

function scannerWaitsForVerdict(source: string): boolean {
  return appearsInOrder(source, "const child = start(acquired =>", "observeManagedProcessGroup(acquired)", "observeManagedWindowsJobExit(acquired",
    "await exit.confirmExit", confirmScanner, returnScan);
}

function relayWatchesExitAndStopsOnFailure(source: string): boolean {
  const relay = source.replace(/child = spawn\((?:program|executable), args, options\);/u, "child = spawn(args, options);");
  return appearsInOrder(relay, "assertStillValid();", "child = spawn(args, options);", "noteSpawn(child)", "trackManagedChildProcess(child",
    "const exited = new Promise", "child.once(\"exit\", (code, signal) => resolve(", "child.once(\"error\", (error) => resolve(error.message))",
    "relayStdioOverLoopback(", "    exited,", "timeoutMs: WINDOWS_RELAY_CONNECT_TIMEOUT_MS",
    "onFailure: (error)", "child.kill();", "stdin: relayed.stdin");
}

function hookStopsAfterAuthorityRefresh(source: string): boolean {
  return statements(section(source, "let refreshError: unknown", "if (contained)")) === statements(`
    let refreshError: unknown;
    try {
      await refreshCommandAllowed?.();
    } catch (error) {
      refreshError = error;
    }
    if (abortSignal?.aborted) {
      if (windowsSpawn) await forceKillManagedChildProcess(windowsSpawn.child, "hook caller aborted");
      wrappedEgress?.release();
      cleanupWrap?.();
      return deny("Hook execution cancelled");
    }
    if (admittedPlan && !isHookShellPlanCurrent(admittedPlan)) {
      if (windowsSpawn) forceKillManagedChildProcess(windowsSpawn.child, "hook shell policy changed");
      wrappedEgress?.release();
      cleanupWrap?.();
      return deny("hook shell execution policy changed before spawn");
    }
    try {
      if (refreshError !== undefined) throw refreshError;
      assertHookStillAdmitted();
    } catch (error) {
      if (windowsSpawn) forceKillManagedChildProcess(windowsSpawn.child, "hook command permission changed");
      wrappedEgress?.release();
      cleanupWrap?.();
      return deny(\`hook command denied before spawn: \${(error as Error).message}\`);
    }
  `);
}

function directHookStopsAndSettles(source: string): boolean {
  const abort = section(source, "const onAbort =", "abortSignal?.addEventListener");
  const output = section(source, "const outputDrained", "const stdoutChunks");
  const finish = section(source, "const finish =", "    timer = setTimeout");
  const timeout = section(source, "    timer = setTimeout", "child.on(\"close\"");
  const close = section(source, "child.on(\"close\"", "child.on(\"error\"");
  const error = section(source, "child.on(\"error\"", "hookStdin?.write(stdinJson)");
  const write = source.slice(source.indexOf("hookStdin?.write(stdinJson)"));
  return appearsInOrder(abort, "cancelled = true", "clearTimeout(timeoutFallback)",
    "forceKillManagedChildProcess(child, \"hook caller aborted\")")
    && source.includes("abortSignal?.addEventListener(\"abort\", onAbort")
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
const managed = readRepoFile("src/main/managed-child-processes.ts");
const engine = readRepoFile("src/observation/libreoffice-process.ts");

const managedExit = section(managed, "export async function waitForManagedProcessGroupExit", "export function observeManagedProcessGroup");
const hookRefresh = section(hook, "let refreshError: unknown", "const startHook =");

function managedGroupRequiresProof(source: string): boolean {
  return statements(source) === statements(`
    export async function waitForManagedProcessGroupExit(child: ChildProcess, closed: Promise<unknown>, stopReason?: string): Promise<boolean> {
      const pid = child.pid;
      if (pid === undefined) return true;
      if (stopReason !== undefined) void forceKillManagedChildProcess(child, stopReason);
      const result = await runWithCeiling(async signal => {
        await raceWithAbort(closed, signal);
        while (processExists(-pid)) await sleep(TOOL_TIMEOUT_POLICY.processGroupExitPollMs, signal);
      }, PROCESS_TREE_KILL_TIMEOUT_MS, undefined, "managed process group termination");
      return result.ok;
    }
  `);
}

function engineAcquiresBeforeRegistration(source: string): boolean {
  const launch = section(source, "private async spawn(", "private async run(");
  const launchCall = section(launch, "spawnManaged(wrap.argv[0]", "const collect =");
  return /\}, \{ label: "document-engine", killProcessGroup: true \}, child => \{ const process: RunningProcess = \{ exit: observeManagedProcessGroup\(child\), .*? \}; running = process; runtime\.children\.add\(process\);$/u.test(statements(launchCall))
    && statements(section(launch, "} catch (error) {", "\n  }\n")) === statements(`
      } catch (error) {
        if (running) await this.finishProcess(runtime, running, "document engine launch failed");
        else if (error instanceof OfflineScanExitUnconfirmedError) runtime.unconfirmedExit = error;
        else wrapped?.release();
        throw runtime.unconfirmedExit ?? error;
      }
      if (!running) {
        runtime.unconfirmedExit ??= terminationUnconfirmed();
        throw runtime.unconfirmedExit;
      }
      return running;
    `)
    && (launch.match(/\b(?:wrap|wrapped|running|process)\??\.release\(/gu) ?? []).length === 1;
}

function engineRetainsUnconfirmedRuntime(source: string): boolean {
  const recovery = section(source, "await this.stopRuntime(owner.runtime);", "} finally {");
  const startup = section(source, "private async createRuntime", "private baseArguments");
  const release = section(source, "async releaseSession", "async dispose");
  const importer = section(source, "private async ensureImporter", "private async findJavaHome");
  return statements(recovery).includes(statements(`
    const recoverable = !unconfirmedExit && !owner.failure && (signal.aborted
      || (cause instanceof TableDocumentError && cause.code === "engine-runtime-unavailable"));
  `))
    && statements(recovery).includes(statements(`
      if (recoverable && owner.runtime) {
        await rm(owner.runtime.directory, { recursive: true, force: true });
        owner.runtime = undefined;
      }
      throw cause;
    `))
    && statements(section(startup, "} catch (error) {", "\n  }\n")) === statements(`
      } catch (error) {
        await this.stopRuntime(runtime);
        if (!runtime.unconfirmedExit) await rm(directory, { recursive: true, force: true });
        throw runtime.unconfirmedExit ?? error;
      }
    `)
    && statements(release).includes(statements(`
      await this.stopRuntime(session.runtime);
      await session.tail;
      await this.stopRuntime(session.runtime);
      if (session.runtime?.unconfirmedExit) throw session.runtime.unconfirmedExit;
      if (session.runtime) await rm(session.runtime.directory, { recursive: true, force: true });
    `))
    && statements(importer).includes(statements(`
      await this.stopRuntime(runtime);
      if (runtime.unconfirmedExit) throw runtime.unconfirmedExit;
      const java = await this.run(
    `))
    && (source.match(/\bawait rm\((?:owner|session)\.runtime\.directory,/gu) ?? []).length === 2
    && (source.match(/\bif \(!runtime\.unconfirmedExit\) \{\s+await rm\(source, \{ force: true \}\);\s+await rm\(output, \{ recursive: true, force: true \}\);\s+\}/gu) ?? []).length === 2
    && (source.match(/\bawait rm\((?:source|output),/gu) ?? []).length === 4;
}

function engineUsesManagedStop(source: string): boolean {
  const cleanup = section(source, "private async stopRuntime", "\n}\n");
  return statements(cleanup) === statements(`
    private async stopRuntime(runtime: SessionRuntime | undefined): Promise<void> {
      if (!runtime) return;
      const processes = [...runtime.children];
      runtime.resident = undefined;
      const verdicts = await Promise.allSettled(processes.map(process => this.finishProcess(runtime, process)));
    if (runtime.unconfirmedExit) return;
    const rejected = verdicts.find(verdict => verdict.status === "rejected");
    if (rejected) throw rejected.reason;
    }

    private finishProcess(runtime: SessionRuntime, running: RunningProcess, reason = "document engine cleanup"): Promise<void> {
      running.drain ??= (async () => {
        if (!await running.exit.confirmExit(reason)) {
          runtime.unconfirmedExit ??= terminationUnconfirmed();
          return;
        }
        running.release();
        runtime.children.delete(running);
      })();
      return running.drain;
    }
  `) && (source.match(/\b(?:wrap|wrapped|running|process)\??\.release\(/gu) ?? []).length === 2;
}

const localTerminationPolicy = /\b(?:documentEngineShutdownMs|orphanProcessCleanupMs|processTreeKillMs|processGroupExitPollMs)\b|\bprocess\.kill\(\s*-/u;

function engineHasOnlyWorkloadDeadlines(source: string): boolean {
  const waitOrTimer = /\b(?:runWithCeiling|raceWithTimeout|raceWithAbort|setInterval)\(|\bawait (?:[\w?.]+\.)?(?:closed|completion)\b/u;
  return !localTerminationPolicy.test(source) && !waitOrTimer.test(source)
    && (source.match(/\bsetTimeout\(/gu) ?? []).length === 2
    && (source.match(/\bPromise\.race\(/gu) ?? []).length === 1
    && (source.match(/Date\.now\(\) \+ TOOL_TIMEOUT_POLICY\.\w+/gu) ?? []).join("\n") === [
      "Date.now() + TOOL_TIMEOUT_POLICY.documentEngineStartupMs",
      "Date.now() + TOOL_TIMEOUT_POLICY.documentEngineReceiptMs",
    ].join("\n")
    && statements(source).includes(statements(`
      const result = await process.exit.wait(signal)
        .finally(() => this.finishProcess(runtime, process))
        .catch((error: unknown) => { throw runtime.unconfirmedExit ?? error; });
      if (runtime.unconfirmedExit) throw runtime.unconfirmedExit;
    `));
}

const earlyWindowsRelease = 'if (windowsSpawn) await forceKillManagedChildProcess(windowsSpawn.child, "hook caller aborted");';
const ownedEngineLaunch = /(spawnManaged\(wrap\.argv\[0\][\s\S]*?\}, \{ label: "document-engine", killProcessGroup: true \}), child => \{([\s\S]*?)\n {6}\}\);/u;
const managedEngineStop = "if (!await running.exit.confirmExit(reason)) {";
const lifetimeMutations = [
  ["early Windows hook hold release", hookRefresh, hookStopsAfterAuthorityRefresh, earlyWindowsRelease,
    `windowsSpawn?.releaseHold();\n    ${earlyWindowsRelease}`],
  ["missing hook authority refresh", hookRefresh, hookStopsAfterAuthorityRefresh, "await refreshCommandAllowed?.();", ""],
  ["missing recoverable runtime cleanup guard", engine, engineRetainsUnconfirmedRuntime, "if (recoverable && owner.runtime)", "if (owner.runtime)"],
  ["early managed group verdict", managedExit, managedGroupRequiresProof, "await raceWithAbort(closed, signal);",
    "return;\n    await raceWithAbort(closed, signal);"],
  ["engine registration before acquisition", engine, engineAcquiresBeforeRegistration, ownedEngineLaunch,
    "const acquired = $1);\n      ((child: typeof acquired) => {$2\n      })(acquired);"],
  ["local engine termination timer", engine, engineHasOnlyWorkloadDeadlines, managedEngineStop,
    "if (!await Promise.race([running.exit.confirmExit(reason), new Promise<boolean>(resolve => setTimeout(() => resolve(false), TOOL_TIMEOUT_POLICY.processTreeKillMs))])) {"],
] as const;

const windowsReleasePaths = [
  ["Windows relay handshake", section(confined, "export async function spawnConfinedChild", "function assertRelayableSpec"),
    relayWatchesExitAndStopsOnFailure, "child.kill();"],
  ["Windows hook authority refresh", hookRefresh,
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
    const launch = section(managed, "export function spawnManaged(", "export function trackManagedChildProcess");
    expect(statements(launch)).toContain(statements(`
      const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
      onSpawn?.(child);
      const inferredGroupKill = spawnOptions.detached === true && process.platform !== "win32";
      trackChild(child, {
        ...trackOptions,
        killProcessGroup: trackOptions.killProcessGroup ?? inferredGroupKill,
      }, undefined, onSpawn !== undefined);
      return child;
    `));
    expect(managedGroupRequiresProof(managedExit)).toBe(true);
    const observer = section(managed, "export function observeManagedProcessGroup", "export function forceKillManagedChildProcess");
    expect(statements(observer)).toContain(statements(`
      return {
        wait: (signal?: AbortSignal) => raceWithAbort(closed, signal),
        confirmExit: (stopReason?: string) => waitForManagedProcessGroupExit(child, closed, stopReason),
      };
    `));
  });

  it("requires managed launch for direct hooks and group confirmation on the POSIX path", () => {
    expect(hook).not.toMatch(/\bspawn\(/u);
    const group = section(hook, "async function runPosixHook", "async function runContainedHook");
    expect(statements(group)).toContain(statements(`
      if (!await exit.confirmExit(stopReason)) {
        return input.deny(t("be_scriptHookRunner.terminationUnverified", { code: "hook-termination-unverified" }));
      }
      const { code, signal } = await exit.wait();
      input.release();
    `));
    expect(group.match(/\binput\.release\(/gu)).toHaveLength(2);
    expect(group).not.toMatch(localTerminationPolicy);
    expect(scanner).not.toMatch(localTerminationPolicy);
  });

  it("keeps POSIX child close waits in the managed owner", () => {
    const posixHook = section(hook, "async function runPosixHook", "async function runContainedHook");
    const localCloseWait = /\.\s*(?:once|on|addListener)\(\s*["']close["']|\bawait\s+closed\b/u;
    expect([posixHook, scanner].filter(source => localCloseWait.test(source))).toEqual([]);
  });

  it("releases the Windows hook wrap and hold through the same cleanup callback", () => {
    const cleanup = section(hook, "const { releaseHold } = windowsSpawn", "else if (sandboxEnabled && process.platform !== \"win32\")");
    expect(statements(cleanup)).toBe(statements(`
      const { releaseHold } = windowsSpawn;
      let cleaned = false;
      cleanupWrap = () => {
        if (!cleaned) {
          cleaned = true;
          void cleanupAsrtSandboxAfterCommand();
        }
        releaseHold();
      };
    }
    `));
  });

  it.each(windowsReleasePaths)("%s preserves its termination and cleanup steps", (_path, source, check) => {
    expect(check(source)).toBe(true);
  });

  it.each(windowsReleasePaths)("%s rejects a missing termination or wait step", (_path, source, check, step) => {
    const missingStep = source.replace(step, "");
    expect(missingStep).not.toBe(source);
    expect(check(missingStep)).toBe(false);
  });

  it("acquires the engine exit waiter before registration and stops the acquired group on launch failure", () => {
    expect(engineAcquiresBeforeRegistration(engine)).toBe(true);
  });

  it("retains runtime and job files when engine exit is unconfirmed", () => {
    expect(engineRetainsUnconfirmedRuntime(engine)).toBe(true);
  });

  it("releases engine wraps only on the managed verdict and uses no local termination deadline or completion wait", () => {
    expect(engineUsesManagedStop(engine)).toBe(true);
    expect(engineHasOnlyWorkloadDeadlines(engine)).toBe(true);
  });

  it.each(lifetimeMutations)("rejects %s", (_name, source, check, from, to) => {
    const mutated = source.replace(from, to);
    expect(mutated).not.toBe(source);
    expect(check(mutated)).toBe(false);
  });
});

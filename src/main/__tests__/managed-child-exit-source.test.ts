import { ChildProcess } from "node:child_process";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";
import {
  createManagedExitScope, observeManagedProcessGroup, registerManagedChildCleanup, registerManagedChildPaths,
  releaseManagedChildResources, removeManagedChildPaths, type ConfirmedExit,
} from "../managed-child-processes.js";

const TEARDOWN_PRIMITIVES = new Set([
  "cleanupWrap", "cleanupAsrtSandboxAfterCommand", "cleanupBwrapMountPoints", "cleanup",
  "release", "releaseHold", "unmount", "rm", "rmSync", "unlink", "unlinkSync", "rmdir", "rmdirSync",
]);

function directTeardownCalls(source: string): string[] {
  const file = parseSourceTexts(new Map([["covered.ts", source]])).get("covered.ts") as ts.SourceFile | undefined;
  if (!file) throw new Error("Cannot parse covered source.");
  const violations: string[] = [];
  function visit(node: ts.Node, containedHook = false): void {
    const containerOwner = containedHook || (ts.isFunctionDeclaration(node)
      && (node.name?.text === "stopPreparedHolder" || node.name?.text === "runContainedHook"));
    if (ts.isImportSpecifier(node) && /^(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)$/u.test((node.propertyName ?? node.name).text)) {
      violations.push((node.propertyName ?? node.name).text);
    }
    if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type)
      && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "ConfirmedExit") {
      violations.push(node.type.typeName.text);
    }
    if (ts.isCallExpression(node)) {
      let target = node.expression;
      while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target) || ts.isAsExpression(target)) {
        target = target.expression;
      }
      const name = ts.isIdentifier(target) ? target.text
        : ts.isPropertyAccessExpression(target) ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression) ? target.argumentExpression.text
        : undefined;
      const containedStop = containerOwner && name === "release" && ts.isPropertyAccessExpression(target)
        && ts.isIdentifier(target.expression) && target.expression.text === "holder";
      if (name && TEARDOWN_PRIMITIVES.has(name) && !containedStop) violations.push(name);
    }
    node.forEachChild(child => visit(child, containerOwner));
  }
  visit(file);
  return violations;
}

function section(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Missing source section: ${from}`);
  return source.slice(start, end);
}

function appearsInOrder(source: string, ...fragments: string[]): boolean {
  let previous = -1;
  for (const fragment of fragments) {
    const position = source.indexOf(fragment, previous + 1);
    if (position < 0) return false;
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
const hook = readRepoFile("src/hooks/script-hook-runner.ts");
const confined = readRepoFile("src/permissions/confined-child.ts");
const grant = readRepoFile("src/sandbox/wrap-bundled-command.ts");
const managed = readRepoFile("src/main/managed-child-processes.ts");
const engine = readRepoFile("src/observation/libreoffice-process.ts");

const hookRefresh = section(hook, "let refreshError: unknown", "const startHook =");
const windowsHook = section(hook, "return new Promise<ScriptHookInvocationResult>", "function stopPreparedHolder");
const posixHook = section(hook, "async function runPosixHook", "async function runContainedHook");
const windowsGrant = section(grant, "export async function spawnWindowsBundledProcess", "export function hostRuntimeReads");
const managedExit = section(managed, "async function waitForManagedProcessGroupExit", "export function observeManagedProcessGroup");
const managedEngineStop = "const proof = await running.exit.confirmExit(reason);";
const earlyWindowsRelease = 'if (windowsSpawn) await forceKillManagedChildProcess(windowsSpawn.child, "hook caller aborted");';
const windowsTimeoutStop = '      forceKillManagedChildProcess(child, "hook timeout");';
const engineFirstDrain = "      const [firstDrain] = await Promise.allSettled";
const ownedEngineLaunch = /(spawnManaged\(wrap\.argv\[0\][\s\S]*?\}, \{ label: "document-engine", killProcessGroup: true \}), child => \{([\s\S]*?)\n {6}\}\);/u;

function scannerWaitsForVerdict(source: string): boolean {
  return source.indexOf(returnScan) > source.indexOf(confirmScanner)
    && appearsInOrder(source, "const child = start(acquired =>", "observeManagedProcessGroup(acquired,",
    "observeManagedWindowsJobExit(acquired,", "exit.wait(stop)", "await exit.confirmExit", confirmScanner, returnScan);
}

function hookStopsAfterAuthorityRefresh(source: string): boolean {
  const flow = section(source, "let refreshError: unknown", "if (contained)");
  return !flow.includes("windowsSpawn?.releaseHold();")
    && appearsInOrder(flow, "await refreshCommandAllowed?.();", "if (abortSignal?.aborted)", earlyWindowsRelease,
      'settlePreparedResources();', 'return deny("Hook execution cancelled");',
      "if (admittedPlan && !isHookShellPlanCurrent(admittedPlan))",
      'if (windowsSpawn) forceKillManagedChildProcess(windowsSpawn.child, "hook shell policy changed");',
      "settlePreparedResources();", "if (refreshError !== undefined) throw refreshError;", "assertHookStillAdmitted();",
      'if (windowsSpawn) forceKillManagedChildProcess(windowsSpawn.child, "hook command permission changed");',
      "settlePreparedResources();");
}

function directHookStopsAndSettles(source: string): boolean {
  const abort = section(source, "const onAbort =", "abortSignal?.addEventListener");
  const output = section(source, "const outputDrained", "const stdoutChunks");
  const finish = section(source, "const finish =", "    timer = setTimeout");
  const timeout = section(source, "    timer = setTimeout", 'child.on("close"');
  const close = section(source, 'child.on("close"', 'child.on("error"');
  const error = section(source, 'child.on("error"', "hookStdin?.write(stdinJson)");
  const write = source.slice(source.indexOf("hookStdin?.write(stdinJson)"));
  return appearsInOrder(abort, "cancelled = true", "clearTimeout(timeoutFallback)",
    'forceKillManagedChildProcess(child, "hook caller aborted")')
    && source.includes('abortSignal?.addEventListener("abort", onAbort')
    && appearsInOrder(output, 'stdout.once("end", done)', 'stdout.once("close", done)', "setTimeout(done, 1_000).unref()")
    && appearsInOrder(finish, "if (settled) return", "settlePreparedResources();", "resolve(hookOutcome(")
    && statements(timeout) === statements(
      'timer = setTimeout(() => { timedOut = true; forceKillManagedChildProcess(child, "hook timeout"); '
      + "timeoutFallback = setTimeout(() => finish(child.exitCode), 1000); }, timeoutMs);",
    )
    && close.includes("void outputDrained.then(() => finish(code, signal))")
    && appearsInOrder(error, "if (settled) return", "settlePreparedResources();", "resolve({")
    && appearsInOrder(write, 'forceKillManagedChildProcess(child, "hook stdin write failed")', "settlePreparedResources();", "resolve({");
}

function containedHookAwaitsRelease(source: string): boolean {
  return appearsInOrder(source, "const stop = (): void => { void holder.release().catch",
    "timedOut = true; stop();", "cancelled = true; stop();", 'input.abortSignal?.addEventListener("abort", onAbort',
    "if (input.abortSignal?.aborted) onAbort()", "writeError = error as Error;\n    stop();",
    "input.timeoutMs + TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs", "settleTimer = setTimeout(",
    "await Promise.race([owned.completion, unsettled])", 'if (result === "unsettled") {\n      stop();',
    'return deny(t("be_scriptHookRunner.containedSettleDeadline"', "await Promise.race([stdoutEnded,",
    "await holder.release();", 'return deny(t("be_scriptHookRunner.containedTerminationUnverified"', "return input.outcome(");
}

function relayWatchesExitAndStopsOnFailure(source: string): boolean {
  return appearsInOrder(source, "spec.onSpawn?.(running);", "assertStillValid();", "child = spawn(program, args, options);",
    "noteSpawn(child)", "trackManagedChildProcess(child", "const exited = new Promise", 'child.once("exit", (code, signal) => resolve(',
    'child.once("error", (error) => resolve(error.message))', "relayStdioOverLoopback(", "    exited,",
    "timeoutMs: WINDOWS_RELAY_CONNECT_TIMEOUT_MS", "onFailure: (error)", "child.kill();", "stdin: relayed.stdin");
}

function grantStopsBeforeCleanup(source: string): boolean {
  const settle = section(source, "const settleHold", "const acquire");
  return directTeardownCalls(source).length === 0
    && appearsInOrder(settle, "registerManagedChildCleanup(", "grant?.release, sandboxHome.cleanup",
      "const proof = lifetime.confirmedExit();", "if (proof) releaseManagedChildResources(proof, cleanup);",
      "else if (exit) void exit.then(confirmed => releaseManagedChildResources(confirmed, cleanup));")
    && appearsInOrder(source, "const acquire", "exit = observeManagedWindowsRelayExit(running, lifetime);", "onSpawn: acquire",
      "held.onLost(", "terminateChildBestEffort(running);", 'running.once("error"',
      "if (running.pid === undefined) settleHold(false);", "if (child !== undefined) terminateChildBestEffort(child);",
      "settleHold(wrapped);", "throw error");
}

function managedGroupRequiresProof(source: string): boolean {
  return statements(source) === statements(
    "async function waitForManagedProcessGroupExit(child: ChildProcess, closed: Promise<unknown>, stopReason?: string): Promise<boolean> { "
    + "const pid = child.pid; if (pid !== undefined && stopReason !== undefined) void forceKillManagedChildProcess(child, stopReason); "
    + "const result = await runWithCeiling(async signal => { await raceWithAbort(closed, signal); "
    + "while (pid !== undefined && processExists(-pid)) await sleep(TOOL_TIMEOUT_POLICY.processGroupExitPollMs, signal); "
    + '}, PROCESS_TREE_KILL_TIMEOUT_MS, undefined, "managed process group termination"); return result.ok; }',
  );
}

function engineAcquiresBeforeRegistration(source: string): boolean {
  const launch = section(source, "private async spawn(", "private async run(");
  const acquire = section(launch, "spawnManaged(wrap.argv[0]", "const collect =");
  return appearsInOrder(acquire, '}, { label: "document-engine", killProcessGroup: true }, child => {',
    "exit: observeManagedProcessGroup(child, lifetime)", "running = process;", "runtime.children.add(process);")
    && appearsInOrder(launch, 'if (running) await this.finishProcess(runtime, running, "document engine launch failed");',
      "else if (error instanceof OfflineScanExitUnconfirmedError) runtime.unconfirmedExit = error;",
      "const proof = lifetime.confirmedExit();", "if (proof) releaseManagedChildResources(proof, wrapped?.cleanup);",
      "throw runtime.unconfirmedExit ?? error;");
}

function engineRetainsUnconfirmedRuntime(source: string): boolean {
  const recovery = section(source, "await this.stopRuntime(owner.runtime);", "} finally {");
  const startup = section(source, "private async createRuntime", "private baseArguments");
  const release = section(source, "async releaseSession", "async dispose");
  const importer = section(source, "private async ensureImporter", "private async findJavaHome");
  const stages = [
    section(source, "private async probeReadiness", "private async dispatch"),
    section(source, "private async convertOne", "private async readConvertedOutput"),
  ];
  return appearsInOrder(recovery, "const recoverable = !unconfirmedExit", "if (recoverable && owner.runtime)",
    "await this.removeRuntime(owner.runtime);", "throw cause;")
    && appearsInOrder(startup, "await this.stopRuntime(runtime);", "if (!runtime.unconfirmedExit) await this.removeRuntime(runtime);",
      "throw runtime.unconfirmedExit ?? error;")
    && appearsInOrder(release, "this.stopRuntime(session.runtime)] as const", "await session.tail;", "await this.stopRuntime(session.runtime);",
      "if (session.runtime?.unconfirmedExit) throw session.runtime.unconfirmedExit;", "await this.removeRuntime(session.runtime);")
    && appearsInOrder(importer, "await this.stopRuntime(runtime);", "if (runtime.unconfirmedExit) throw runtime.unconfirmedExit;",
      "const java = await this.run(")
    && stages.every(stage => appearsInOrder(stage, "await this.stopRuntime(runtime);", "throw runtime.unconfirmedExit ?? error;",
      "const proof = completed || runtime.lifetime.confirmedExit() ? lifetime.confirmedExit() : undefined;", "if (!runtime.unconfirmedExit && proof)",
      "await removeManagedChildPaths(proof, paths);"));
}

const LOCAL_TERMINATION_POLICY = /\b(?:documentEngineShutdownMs|orphanProcessCleanupMs|processTreeKillMs|processGroupExitPollMs)\b|\bprocess\.kill\(\s*-/u;

function engineHasOnlyWorkloadDeadlines(source: string): boolean {
  const waitOrTimer = /\b(?:runWithCeiling|raceWithTimeout|raceWithAbort|setInterval)\(|\bawait (?:[\w?.]+\.)?(?:closed|completion)\b/u;
  return !LOCAL_TERMINATION_POLICY.test(source) && !waitOrTimer.test(source)
    && (source.match(/\bsetTimeout\(/gu) ?? []).length === 2
    && (source.match(/\bPromise\.race\(/gu) ?? []).length === 1
    && (source.match(/Date\.now\(\) \+ TOOL_TIMEOUT_POLICY\.\w+/gu) ?? []).join("\n") === [
      "Date.now() + TOOL_TIMEOUT_POLICY.documentEngineStartupMs",
      "Date.now() + TOOL_TIMEOUT_POLICY.documentEngineReceiptMs",
    ].join("\n")
    && appearsInOrder(source, "const result = await process.exit.wait(signal)",
      ".finally(async () => { proof = await this.finishProcess(runtime, process); })",
      ".catch((error: unknown) => { throw runtime.unconfirmedExit ?? error; });");
}

function hasNoDirectTeardown(source: string): boolean {
  return directTeardownCalls(source).length === 0;
}

const LIFETIME_MUTATIONS = [
  ["early Windows hook hold release", hookRefresh, hookStopsAfterAuthorityRefresh, earlyWindowsRelease,
    `windowsSpawn?.releaseHold();\n    ${earlyWindowsRelease}`],
  ["missing hook authority refresh", hookRefresh, hookStopsAfterAuthorityRefresh, "await refreshCommandAllowed?.();", ""],
  ["missing recoverable runtime cleanup guard", engine, engineRetainsUnconfirmedRuntime, "if (recoverable && owner.runtime)", "if (owner.runtime)"],
  ["early managed group verdict", managedExit, managedGroupRequiresProof, "await raceWithAbort(closed, signal);",
    "return;\n    await raceWithAbort(closed, signal);"],
  ["engine registration before acquisition", engine, engineAcquiresBeforeRegistration, ownedEngineLaunch,
    "const acquired = $1);\n      ((child: typeof acquired) => {$2\n      })(acquired);"],
  ["local engine termination timer", engine, engineHasOnlyWorkloadDeadlines, managedEngineStop,
    "const proof = await Promise.race([running.exit.confirmExit(reason), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), TOOL_TIMEOUT_POLICY.processTreeKillMs))]);"],
  ["engine output removal before its first drain", engine, hasNoDirectTeardown, engineFirstDrain,
    `      if (session.runtime) await rm(session.runtime.output, { recursive: true, force: true });\n${engineFirstDrain}`],
  ["Windows wrap cleanup before timeout stop", hook, hasNoDirectTeardown, windowsTimeoutStop,
    `      cleanupWrap?.();\n${windowsTimeoutStop}`],
] as const;

const WINDOWS_RELEASE_PATHS = [
  ["Windows relay handshake", section(confined, "export async function spawnConfinedChild", "function assertRelayableSpec"),
    relayWatchesExitAndStopsOnFailure, "child.kill();"],
  ["Windows hook authority refresh", hookRefresh, hookStopsAfterAuthorityRefresh,
    'await forceKillManagedChildProcess(windowsSpawn.child, "hook caller aborted")'],
  ["direct Windows hook settlement", windowsHook, directHookStopsAndSettles, "void outputDrained.then(() => finish(code, signal));"],
  ["contained Windows hook settlement", section(hook, "async function runContainedHook", "function normalizeRunnable"),
    containedHookAwaitsRelease, "await holder.release();"],
  ["Windows grant teardown", windowsGrant, grantStopsBeforeCleanup, "if (child !== undefined) terminateChildBestEffort(child);"],
] as const;

describe("managed process exit source contracts", () => {
  it.each([
    ["engine", engine], ["scanner", offline], ["hook setup and Windows relay", hook],
    ["POSIX hook", posixHook], ["Windows grant", windowsGrant],
  ])("keeps %s teardown primitives inside the managed owner", (_name, source) => {
    expect(directTeardownCalls(source)).toEqual([]);
  });

  it("cannot use a caller-created value as proof", () => {
    // @ts-expect-error The owner's unique symbol is private.
    const forged: ConfirmedExit = { confirmedExit: true };
    expect(() => releaseManagedChildResources(forged)).toThrow("Managed exit was not confirmed.");
  });

  it("rejects a proof from a different resource scope", async () => {
    const unrelated = createManagedExitScope().confirmedExit();
    if (!unrelated) throw new Error("Expected an idle scope.");
    const scope = createManagedExitScope();
    const cleanup = registerManagedChildCleanup(scope, () => { throw new Error("Should not run."); });
    expect(() => releaseManagedChildResources(unrelated, cleanup)).toThrow("Managed exit was not confirmed.");
    await expect(removeManagedChildPaths(unrelated, registerManagedChildPaths(scope))).rejects.toThrow("Managed exit was not confirmed.");
  });

  it("invalidates idle proofs when a child is acquired and issues new proof after close", async () => {
    const parent = createManagedExitScope();
    const scope = createManagedExitScope(parent);
    const idle = parent.confirmedExit();
    if (!idle) throw new Error("Expected an idle scope.");
    const child = new ChildProcess();
    const exit = observeManagedProcessGroup(child, scope);
    expect(parent.confirmedExit()).toBeUndefined();
    expect(scope.confirmedExit()).toBeUndefined();
    expect(() => releaseManagedChildResources(idle)).toThrow("Managed exit was not confirmed.");
    child.emit("close", 0, null);
    expect(await exit.confirmExit()).toBeDefined();
    expect(parent.confirmedExit()).toBeDefined();
    expect(scope.confirmedExit()).toBeDefined();
    expect(() => releaseManagedChildResources(idle)).toThrow("Managed exit was not confirmed.");
  });

  it("acquires the scanner and waits on the managed verdict before success or scratch cleanup", () => {
    expect(scanner.match(/\bspawnManaged\(/gu)).toHaveLength(2);
    expect(scanner.match(/\brunWithCeiling\(/gu)).toHaveLength(1);
    expect(scannerWaitsForVerdict(scanner)).toBe(true);
    expect(appearsInOrder(offline, "await runOfflineScan", "if (error instanceof OfflineScanExitUnconfirmedError)",
      "const proof = scanLifetime.confirmedExit();", "if (proof) await removeManagedChildPaths(proof, scanPaths);",
      "throw unconfirmedExit ?? error")).toBe(true);
  });

  it("rejects a scanner that returns success ahead of the termination verdict", () => {
    const earlyReturn = scanner.replace(confirmScanner, `${returnScan};\n    ${confirmScanner}`);
    expect(earlyReturn).not.toBe(scanner);
    expect(scannerWaitsForVerdict(earlyReturn)).toBe(false);
  });

  it("acquires the managed process before registering it and requires group absence", () => {
    const launch = section(managed, "export function spawnManaged(", "export function trackManagedChildProcess");
    expect(appearsInOrder(launch, "const child = spawn(command, args,", "onSpawn?.(child);", "trackChild(child,",
      "onSpawn !== undefined);", "return child;")).toBe(true);
    expect(managedGroupRequiresProof(managedExit)).toBe(true);
    const observer = section(managed, "export function observeManagedProcessGroup", "export function observeManagedWindowsRelayExit");
    expect(appearsInOrder(observer, "const recordExit = retainManagedExit(scope);", 'child.once("close",',
      "wait: (signal?: AbortSignal) => raceWithAbort(closed, signal),",
      "await waitForManagedProcessGroupExit(child, closed, stopReason) ? recordExit() : undefined")).toBe(true);
  });

  it("forbids local POSIX child close waits and uses the managed launch and group verdict", () => {
    expect(hook).not.toMatch(/\bspawn\(/u);
    const localCloseWait = /\.\s*(?:once|on|addListener)\(\s*["']close["']|\bawait\s+closed\b/u;
    for (const source of [scanner, posixHook]) {
      expect(source).not.toMatch(localCloseWait);
      expect(source).not.toMatch(LOCAL_TERMINATION_POLICY);
    }
    expect(appearsInOrder(posixHook, "observeManagedProcessGroup(child, input.lifetime)", "exit.wait(stopping.signal)",
      "const proof = await exit.confirmExit(stopReason);", "if (!proof)", 'return input.deny(t("be_scriptHookRunner.terminationUnverified"',
      "await exit.wait();", "releaseManagedChildResources(proof, input.cleanup);")).toBe(true);
  });

  it("holds the Windows hook wrap and grant until managed relay exit", () => {
    const setup = section(hook, "windowsExit = windowsSpawn.exit", "const startHook =");
    expect(appearsInOrder(setup, "windowsExit = windowsSpawn.exit;",
      "cleanup = registerManagedChildCleanup(windowsSpawn.lifetime, cleanupAsrtSandboxAfterCommand, windowsSpawn.releaseHold);",
      "const settlePreparedResources", "void windowsExit.then(proof => releaseManagedChildResources(proof, cleanup));")).toBe(true);
  });

  it.each(WINDOWS_RELEASE_PATHS)("%s preserves its termination and cleanup steps", (_path, source, check) => {
    expect(check(source)).toBe(true);
  });

  it.each(WINDOWS_RELEASE_PATHS)("%s rejects a missing termination or wait step", (_path, source, check, step) => {
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

  it("releases engine wraps after proof, drains every child, and uses only managed termination deadlines", () => {
    const cleanup = section(engine, "private async stopRuntime", "\n}\n");
    expect(appearsInOrder(cleanup, "await Promise.allSettled(processes.map(process => this.finishProcess(runtime, process)));",
      "if (runtime.unconfirmedExit) return;", 'find(verdict => verdict.status === "rejected")', "if (rejected) throw rejected.reason;",
      managedEngineStop, "if (!proof)", "runtime.unconfirmedExit ??= terminationUnconfirmed();", "return undefined;",
      "releaseManagedChildResources(proof, running.cleanup);", "runtime.children.delete(running);")).toBe(true);
    expect(engineHasOnlyWorkloadDeadlines(engine)).toBe(true);
  });

  it.each(LIFETIME_MUTATIONS)("rejects %s", (_name, source, check, from, to) => {
    const mutated = source.replace(from, to);
    expect(mutated).not.toBe(source);
    expect(check(mutated)).toBe(false);
  });
});

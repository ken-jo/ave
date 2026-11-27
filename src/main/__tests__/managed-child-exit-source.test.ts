// Managed-child ownership lock. The owner (`managed-child-processes.ts`) holds every covered child's teardown on an opaque handle,
// recorded at acquisition by the registering wrap modules; callers receive the handle and owner-issued receipts only.
// - Import graph: raw teardown primitives reach only the owner, the registering wrap modules and the named out-of-scope
//   launch sites below; the covered callers (hook runner, document engine) reach none, and import no fs removal by a named,
//   default, namespace, `promises` or literal dynamic import.
// - Behaviour: forged, foreign, stale (generation), wrong-kind and early receipts are refused; every step runs past a throwing one,
//   which alone stays retryable.
//   The reviewer mutations that stayed green each have a named behaviour test in the suite that owns the path.
// - Source rules kept from earlier rulings: main's Windows release paths, no local child-lifetime timer or completion wait.
// - Owner call sites in covered callers are pinned per file, so a new fresh handle, path record or abandon fails the lock.
// Residual: a covered caller can still record its own paths on an existing handle and abandon it unlaunched; only the behaviour
// tests catch that form. The owner checks only a handle's own subtree, so a path a caller records on a valid handle is removed by
// that handle's receipt even if another live child uses it. A failed request's release is enforced by the caller (stopRuntime
// and unconfirmedExit). Raw primitives inside a registering wrap module (an alias, a direct call) are caught only by the behaviour
// tests of that module. The fs check parses import forms only: `require`, a computed specifier, fs handed in from another module,
// or a removal helper defined elsewhere is not seen. The contained-hook holder's own `holder.release()` (stopPreparedHolder,
// runContainedHook) is exempt from the direct-call check; its termination evidence is the holder's. The out-of-scope importers
// listed in RAW_IMPORTERS are not covered by this owner.
import { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { describe, expect, it, vi } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";
import {
  abandonManagedLaunch, createManagedRelayResources, createManagedResources, observeManagedProcessGroup,
  observeManagedWindowsRelayExit, recordManagedCleanup, recordManagedPaths, releaseManagedResources, type ConfirmedExit,
} from "../managed-child-processes.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RAW_DEFINITIONS: Readonly<Record<string, readonly string[]>> = {
  "src/permissions/asrt-sandbox.ts": ["cleanupAsrtSandboxAfterCommand", "releaseAsrtSandboxForExit", "resetAsrtSandbox"],
  "src/permissions/egress-invocations.ts": ["releaseEgressInvocation"],
  // Returns the raw egress invocation, whose release the caller would own.
  "src/sandbox/wrap-bundled-command.ts": ["wrapBundledCommand"],
  "src/permissions/sandbox-process-home.ts": ["createSandboxProcessHome"],
  "src/permissions/windows-acl-grant-holder.ts": ["holdWindowsFilesystemGrant"],
  "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js": ["cleanupBwrapMountPoints"],
  "src/main/managed-child-processes.ts": ["recordManagedCleanup", "createManagedRelayResources", "observeManagedWindowsRelayExit"],
};
const RAW_NAMES = new Set(Object.values(RAW_DEFINITIONS).flat());

const OWNER_MODULES = ["src/sandbox/wrap-bundled-command.ts", "src/permissions/offline-process-sandbox.ts"];
const COVERED_CALLERS = ["src/hooks/script-hook-runner.ts", "src/observation/libreoffice-process.ts"];

/** Reviewed owner call sites per covered caller: root handles, nested handles, path records and never-spawned releases. */
const OWNER_CALL_SITES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "src/hooks/script-hook-runner.ts": { root: 1, nested: 0, paths: 0, abandon: 3 },
  "src/observation/libreoffice-process.ts": { root: 2, nested: 4, paths: 5, abandon: 4 },
};

function ownerCallSites(source: string): Record<string, number> {
  const count = (pattern: RegExp): number => (source.match(pattern) ?? []).length;
  return {
    root: count(/\bcreateManagedResources\(\s*\)/gu),
    nested: count(/\bcreateManagedResources\(\s*[^)\s]/gu),
    paths: count(/\brecordManagedPaths\(/gu),
    abandon: count(/\babandonManagedLaunch\(/gu),
  };
}

/** Every non-test importer of a raw teardown primitive; `module:*` marks a namespace or unbound dynamic import. */
const RAW_IMPORTERS: Readonly<Record<string, readonly string[]>> = {
  // Registering wrap modules.
  "src/sandbox/wrap-bundled-command.ts": [
    "cleanupAsrtSandboxAfterCommand", "createManagedRelayResources", "createSandboxProcessHome", "holdWindowsFilesystemGrant",
    "observeManagedWindowsRelayExit", "recordManagedCleanup",
  ],
  "src/permissions/offline-process-sandbox.ts": ["cleanupBwrapMountPoints", "recordManagedCleanup"],
  // The Linux dependency check's unbound dynamic import of the module; it calls only checkLinuxDependencies.
  "src/permissions/asrt-sandbox.ts": ["@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js:*"],
  // Out of scope for this owner: other launch sites with their own lifetime contracts, and boot/shutdown wiring.
  "src/boot/steps/marketplace-setup.ts": ["src/permissions/asrt-sandbox.ts:*"],
  "src/main/app-shutdown.ts": ["releaseAsrtSandboxForExit"],
  "src/tools/mxc-shell-launch.ts": ["releaseEgressInvocation"],
  "src/main/memory-map/inference-child.ts": ["cleanupAsrtSandboxAfterCommand", "createSandboxProcessHome"],
  "src/main/terminal/pty-manager.ts": ["cleanupAsrtSandboxAfterCommand", "createSandboxProcessHome"],
  "src/mcp/mcp-client.ts": ["cleanupAsrtSandboxAfterCommand", "createSandboxProcessHome", "wrapBundledCommand"],
  "src/permissions/worker-spawn.ts": ["cleanupAsrtSandboxAfterCommand", "createSandboxProcessHome"],
  "src/plugins/isolation/out-of-process-plugin.ts": ["cleanupAsrtSandboxAfterCommand", "createSandboxProcessHome", "holdWindowsFilesystemGrant"],
  "src/tools/powershell-launch.ts": ["createSandboxProcessHome"],
  "src/tools/prepared-shell-invocation.ts": ["createSandboxProcessHome"],
  "src/tools/shell-tools.ts": ["cleanupAsrtSandboxAfterCommand", "createSandboxProcessHome"],
};

function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map(path => posix.join("src", path.replaceAll("\\", "/")))
    .filter(path => /\.tsx?$/u.test(path) && !/\.d\.ts$/u.test(path) && !path.includes("/__tests__/") && !/\.test\.tsx?$/u.test(path));
}

function resolveSpecifier(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return posix.join(posix.dirname(from), specifier).replace(/\.js$/u, ".ts");
}

function bindingNames(pattern: ts.Node): string[] | undefined {
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  return pattern.elements.map(element => {
    const name: ts.Node | undefined = element.propertyName ?? element.name;
    return name && ts.isIdentifier(name) ? name.text : "";
  });
}

/** Raw names a file reaches through static imports, re-exports and dynamic `import()`. */
function rawImports(path: string, source: string): string[] {
  const file = parseSourceTexts(new Map([[path, source]])).get(path) as ts.SourceFile | undefined;
  if (!file) throw new Error(`Cannot parse ${path}.`);
  const reached = new Set<string>();
  const reachModule = (specifier: string, names: readonly string[] | undefined): void => {
    const module = resolveSpecifier(path, specifier);
    const raw = RAW_DEFINITIONS[module];
    if (!raw || module === path) return;
    if (names === undefined) reached.add(`${module}:*`);
    else for (const name of names) if (raw.includes(name)) reached.add(name);
  };
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) reachModule(specifier, undefined);
        else if (bindings) reachModule(specifier, bindings.elements.map(element => (element.propertyName ?? element.name).text));
      } else if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        reachModule(specifier, undefined);
      } else {
        reachModule(specifier, node.exportClause.elements.map(element => (element.propertyName ?? element.name).text));
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) {
        let parent: ts.Node = node.parent;
        while (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) parent = parent.parent;
        const names = ts.isVariableDeclaration(parent) ? bindingNames(parent.name) : undefined;
        reachModule(argument.text, names);
      }
    }
    node.forEachChild(visit);
  }
  visit(file);
  return [...reached].sort();
}

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/u;
const FS_REMOVAL = /^(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|promises)$/u;

/** fs removal reached by a named (`promises` included), default, namespace or literal dynamic import. */
function fsRemovalImports(path: string, source: string): string[] {
  const file = parseSourceTexts(new Map([[path, source]])).get(path) as ts.SourceFile | undefined;
  if (!file) throw new Error(`Cannot parse ${path}.`);
  const found: string[] = [];
  const reach = (names: readonly string[] | undefined): void => {
    if (names === undefined) found.push("*");
    else found.push(...names.filter(name => FS_REMOVAL.test(name)));
  };
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && FS_MODULE.test(node.moduleSpecifier.text)) {
      if (node.importClause?.name) found.push("default");
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) reach(undefined);
      else if (bindings) reach(bindings.elements.filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text));
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument) && FS_MODULE.test(argument.text)) {
        let parent: ts.Node = node.parent;
        while (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) parent = parent.parent;
        reach(ts.isVariableDeclaration(parent) ? bindingNames(parent.name) : undefined);
      }
    }
    node.forEachChild(visit);
  }
  visit(file);
  return found;
}

const TEARDOWN_PRIMITIVES = new Set([
  "cleanupWrap", "cleanupAsrtSandboxAfterCommand", "cleanupBwrapMountPoints", "cleanup",
  "release", "unmount", "rm", "rmSync", "unlink", "unlinkSync", "rmdir", "rmdirSync",
]);

/** Direct teardown calls outside what a registering module hands to `recordManagedCleanup`. */
function directTeardownCalls(source: string): string[] {
  const file = parseSourceTexts(new Map([["covered.ts", source]])).get("covered.ts") as ts.SourceFile | undefined;
  if (!file) throw new Error("Cannot parse covered source.");
  const violations: string[] = [];
  function visit(node: ts.Node, containedHook = false): void {
    const containerOwner = containedHook || (ts.isFunctionDeclaration(node)
      && (node.name?.text === "stopPreparedHolder" || node.name?.text === "runContainedHook"));
    if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)
      && /^(?:ConfirmedExit|RelayBestEffortExit|ManagedResources)$/u.test(node.type.typeName.text)) {
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
      if (name === "recordManagedCleanup") return;
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
const windowsHook = section(hook, "return await new Promise<ScriptHookInvocationResult>", "function stopPreparedHolder");
const posixHook = section(hook, "async function runPosixHook", "async function runContainedHook");
const windowsGrant = section(grant, "export async function spawnWindowsBundledProcess", "export function hostRuntimeReads");
const managedExit = section(managed, "async function waitForManagedProcessGroupExit", "export function observeManagedProcessGroup");
const managedEngineStop = "const proof = await running.exit.confirmExit(reason);";
const earlyWindowsRelease = 'if (windowsSpawn) await forceKillManagedChildProcess(windowsSpawn.child, "hook caller aborted");';

function scannerWaitsForVerdict(source: string): boolean {
  return source.indexOf(returnScan) > source.indexOf(confirmScanner)
    && appearsInOrder(source, "const child = start(acquired =>", "observeManagedProcessGroup(acquired,",
      "observeManagedWindowsJobExit(acquired,", "exit.wait(stop)", "await exit.confirmExit", confirmScanner, "noteExit(confirmed);", returnScan);
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
    && settle.includes("const release = exit ? exit.then(receipt => releaseManagedResources(resources, receipt)) : abandonManagedLaunch(resources);")
    && appearsInOrder(source, "const resources = createManagedRelayResources();", "recordManagedCleanup(resources,",
      "() => grant?.release(), sandboxHome.cleanup);", "const acquire", "exit = observeManagedWindowsRelayExit(running, resources);",
      "onSpawn: acquire", "held.onLost(", "terminateChildBestEffort(running);", 'running.once("error"',
      "if (running.pid === undefined) settleHold();", "if (child !== undefined) terminateChildBestEffort(child);",
      "launchFailed = true;", "settleHold();", "throw error");
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

// Timer and completion-wait rules from the earlier rulings, kept as named source mutations.
const LIFETIME_MUTATIONS = [
  ["early managed group verdict", managedExit, managedGroupRequiresProof, "await raceWithAbort(closed, signal);",
    "return;\n    await raceWithAbort(closed, signal);"],
  ["local engine termination timer", engine, engineHasOnlyWorkloadDeadlines, managedEngineStop,
    "const proof = await Promise.race([running.exit.confirmExit(reason), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), TOOL_TIMEOUT_POLICY.processTreeKillMs))]);"],
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

const LOCAL_CHILD_WAIT = /\.\s*(?:once|on|addListener)\(\s*["'](?:close|exit)["']|\bawait\s+closed\b/u;

function exitedChild(): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: undefined });
  return child;
}

async function confirmedUnder(resources: ReturnType<typeof createManagedResources>): Promise<ConfirmedExit> {
  const child = exitedChild();
  const exit = observeManagedProcessGroup(child, resources);
  child.emit("close", 0, null);
  const receipt = await exit.confirmExit();
  if (!receipt) throw new Error("Expected a confirmed exit.");
  return receipt;
}

describe("managed child ownership by import graph", () => {
  const files = sourceFiles();
  const reached = new Map<string, string[]>();
  for (const path of files) {
    const source = readFileSync(join(SRC, relative("src", path)), "utf8");
    if (![...RAW_NAMES].some(name => source.includes(name)) && !Object.keys(RAW_DEFINITIONS).some(module => source.includes(posix.basename(module, ".ts")))) continue;
    const names = rawImports(path, source);
    if (names.length > 0) reached.set(path, names);
  }

  it("reaches raw teardown primitives only from the owner, the registering wrap modules and the named launch sites", () => {
    const byPath = (left: readonly [string, unknown], right: readonly [string, unknown]): number => left[0].localeCompare(right[0]);
    expect(Object.fromEntries([...reached].sort(byPath)))
      .toEqual(Object.fromEntries(Object.entries(RAW_IMPORTERS).map(([path, names]) => [path, [...names].sort()] as const).sort(byPath)));
  });

  it.each(COVERED_CALLERS)("keeps %s on the opaque handle, with no raw primitive or fs removal import", path => {
    expect(reached.get(path)).toBeUndefined();
    expect(fsRemovalImports(path, readRepoFile(path))).toEqual([]);
    expect(directTeardownCalls(readRepoFile(path))).toEqual([]);
  });

  it.each(COVERED_CALLERS)("pins the owner call sites of %s", path => {
    expect(ownerCallSites(readRepoFile(path))).toEqual(OWNER_CALL_SITES[path]);
  });

  it("rejects an extra fresh handle that records and abandons engine output before the first drain", () => {
    const path = "src/observation/libreoffice-process.ts";
    const source = readRepoFile(path);
    const drain = "      const [firstDrain] = await Promise.allSettled";
    const early = source.replace(drain, "      if (session.runtime) { const early = createManagedResources(); "
      + "recordManagedPaths(early, { path: session.runtime.output, recursive: true }); await abandonManagedLaunch(early); }\n" + drain);
    expect(early).not.toBe(source);
    expect(ownerCallSites(early)).not.toEqual(OWNER_CALL_SITES[path]);
  });

  it("limits cleanup recording and the relay receipt to the owner's registering wrap modules", () => {
    const recorders = [...reached].filter(([, names]) => names.some(name => /^(?:recordManagedCleanup|createManagedRelayResources|observeManagedWindowsRelayExit)$/u.test(name)));
    expect(recorders.map(([path]) => path).sort()).toEqual([...OWNER_MODULES].sort());
  });

  it("detects named, namespace, re-exported and dynamic imports of a raw primitive", () => {
    const probe = (source: string) => rawImports("src/hooks/probe.ts", source);
    expect(probe('import { cleanupAsrtSandboxAfterCommand as tidy } from "../permissions/asrt-sandbox.js";')).toEqual(["cleanupAsrtSandboxAfterCommand"]);
    expect(probe('import * as asrt from "../permissions/asrt-sandbox.js";')).toEqual(["src/permissions/asrt-sandbox.ts:*"]);
    expect(probe('export { recordManagedCleanup } from "../main/managed-child-processes.js";')).toEqual(["recordManagedCleanup"]);
    expect(probe('const { cleanupBwrapMountPoints } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js");'))
      .toEqual(["cleanupBwrapMountPoints"]);
    expect(probe('const home = await import("../permissions/sandbox-process-home.js");')).toEqual(["src/permissions/sandbox-process-home.ts:*"]);
    expect(probe('import { releaseEgressInvocation } from "../permissions/egress-invocations.js";')).toEqual(["releaseEgressInvocation"]);
    expect(probe('import { wrapBundledCommand as wrap } from "../sandbox/wrap-bundled-command.js";')).toEqual(["wrapBundledCommand"]);
    expect(probe('import { resetAsrtSandbox, releaseAsrtSandboxForExit } from "../permissions/asrt-sandbox.js";'))
      .toEqual(["releaseAsrtSandboxForExit", "resetAsrtSandbox"]);
  });

  it.each([
    ["named alias", 'import { rm as remove } from "node:fs/promises";', ["rm"]],
    ["default", 'import fs from "node:fs";', ["default"]],
    ["promises alias", 'import { promises as fsp } from "fs";', ["promises"]],
    ["namespace", 'import * as fsp from "node:fs/promises";', ["*"]],
    ["unbound dynamic", 'const fsp = await import("node:fs/promises");', ["*"]],
    ["bound dynamic", 'const { rm: remove } = await import("node:fs/promises");', ["rm"]],
  ] as const)("detects a %s fs removal import, alone and added to a covered caller", (_form, statement, expected) => {
    expect(fsRemovalImports("src/hooks/probe.ts", statement)).toEqual(expected);
    for (const path of COVERED_CALLERS) {
      expect(fsRemovalImports(path, `${readRepoFile(path)}\n${statement}\n`)).toEqual(expected);
    }
    expect(fsRemovalImports("src/hooks/probe.ts", 'import type { Stats } from "node:fs";\nimport { readFile } from "node:fs/promises";')).toEqual([]);
  });
});

describe("managed child receipts", () => {
  it("refuses a caller-created value as a receipt", async () => {
    // @ts-expect-error The owner's unique symbol is private.
    const forged: ConfirmedExit = { receipt: "confirmed" };
    await expect(releaseManagedResources(createManagedResources(), forged)).rejects.toThrow("Managed exit was not confirmed.");
  });

  it("refuses a receipt from an unrelated handle", async () => {
    const unrelated = await confirmedUnder(createManagedResources());
    const resources = createManagedResources();
    recordManagedCleanup(resources, () => { throw new Error("Should not run."); });
    await expect(releaseManagedResources(resources, unrelated)).rejects.toThrow("Managed exit was not confirmed.");
  });

  it("binds a receipt to the generation it saw, so a later child keeps the handle", async () => {
    const resources = createManagedResources();
    const steps: string[] = [];
    recordManagedCleanup(resources, () => steps.push("released"));
    const first = await confirmedUnder(resources);
    const later = exitedChild();
    const laterExit = observeManagedProcessGroup(later, resources);
    await expect(releaseManagedResources(resources, first)).rejects.toThrow("Managed exit was not confirmed.");
    later.emit("close", 0, null);
    await expect(releaseManagedResources(resources, first)).rejects.toThrow("Managed exit was not confirmed.");
    const second = await laterExit.confirmExit();
    if (!second) throw new Error("Expected a confirmed exit.");
    await expect(releaseManagedResources(resources, first)).rejects.toThrow("Managed exit was not confirmed.");
    expect(steps).toEqual([]);
    await releaseManagedResources(resources, second);
    expect(steps).toEqual(["released"]);
  });

  it("refuses a parent while a nested child lacks a verdict", async () => {
    const parent = createManagedResources();
    const nested = createManagedResources(parent);
    const sibling = createManagedResources(parent);
    observeManagedProcessGroup(exitedChild(), nested);
    const done = await confirmedUnder(sibling);
    await expect(releaseManagedResources(parent, done)).rejects.toThrow("Managed exit was not confirmed.");
    await expect(abandonManagedLaunch(parent)).rejects.toThrow("Managed exit was not confirmed.");
  });

  it("refuses at the record call a path another live handle outside the subtree recorded", async () => {
    const directory = join(tmpdir(), `ave-managed-overlap-${process.pid}-${Date.now()}`);
    const holder = join(directory, "output", "holder");
    const runtime = createManagedResources();
    recordManagedPaths(runtime, { path: directory, recursive: true });
    const resident = createManagedResources(runtime);
    recordManagedPaths(resident, { path: holder, recursive: true });
    const request = createManagedResources(runtime);
    recordManagedPaths(request, { path: join(directory, "input", "a.fodt") }, { path: join(directory, "output", "a"), recursive: true });
    // The engine mutation: a request also records the resident's holder.
    expect(() => recordManagedPaths(request, { path: holder, recursive: true })).toThrow("another live handle recorded");
    expect(() => recordManagedPaths(createManagedResources(runtime), { path: join(holder, "frame.fodt") })).toThrow("another live handle recorded");
    expect(() => recordManagedPaths(createManagedResources(), { path: join(directory, "output") })).toThrow("another live handle recorded");
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(() => recordManagedPaths(createManagedResources(), { path: holder.toUpperCase() })).toThrow("another live handle recorded");
    }
    await releaseManagedResources(resident, await confirmedUnder(resident));
    await releaseManagedResources(request, await confirmedUnder(request));
    await releaseManagedResources(runtime, await confirmedUnder(runtime));
    const next = createManagedResources();
    recordManagedPaths(next, { path: holder, recursive: true });
    await abandonManagedLaunch(next);
  });

  it("refuses a forged lineage claim: lineage is only what the owner minted", async () => {
    const directory = join(tmpdir(), `ave-managed-lineage-${process.pid}-${Date.now()}`);
    const live = createManagedResources();
    recordManagedPaths(live, { path: join(directory, "a"), recursive: true });
    const lookalike = Object.freeze({ ...live });
    expect(() => createManagedResources(lookalike)).toThrow("not issued by the owner");
    expect(() => recordManagedPaths(lookalike, { path: join(directory, "a", "x") })).toThrow("not issued by the owner");
    const released = createManagedResources();
    await abandonManagedLaunch(released);
    expect(() => createManagedResources(released)).toThrow("already released");
    const claimed = { path: join(directory, "a", "x"), parent: live, lineage: [live] } as never;
    expect(() => recordManagedPaths(createManagedResources(), claimed)).toThrow("another live handle recorded");
    const parent = createManagedResources();
    const first = createManagedResources(parent);
    recordManagedPaths(first, { path: join(directory, "b"), recursive: true });
    const sibling = createManagedResources(parent);
    expect(() => recordManagedPaths(sibling, { path: join(directory, "b", "c") })).toThrow("another live handle recorded");
    // A descendant stays live after its ancestor is released, and its release still removes its paths.
    const ancestor = createManagedResources();
    recordManagedPaths(ancestor, { path: join(directory, "d"), recursive: true });
    const descendant = createManagedResources(ancestor);
    recordManagedPaths(descendant, { path: join(directory, "d", "e"), recursive: true });
    await abandonManagedLaunch(ancestor);
    expect(() => recordManagedPaths(createManagedResources(), { path: join(directory, "d", "e", "f") })).toThrow("another live handle recorded");
    for (const handle of [live, first, sibling, parent, descendant]) await abandonManagedLaunch(handle);
    const next = createManagedResources();
    recordManagedPaths(next, { path: join(directory, "a") }, { path: join(directory, "b") }, { path: join(directory, "d", "e") });
    await abandonManagedLaunch(next);
  });

  it("reads each record argument field once, so a flipping accessor cannot reach another live handle's directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-managed-snapshot-"));
    try {
      const held = join(directory, "held");
      const benign = join(directory, "benign");
      for (const dir of [held, benign]) {
        mkdirSync(dir);
        writeFileSync(join(dir, "file"), "x");
      }
      const owner = createManagedResources();
      recordManagedPaths(owner, { path: held, recursive: true });
      const reads = { path: 0, recursive: 0 };
      const flipping = {
        get path() { return ++reads.path === 1 ? benign : held; },
        get recursive() { reads.recursive++; return true; },
      };
      const attacker = createManagedResources();
      recordManagedPaths(attacker, flipping);
      await abandonManagedLaunch(attacker);
      expect(existsSync(benign)).toBe(false);
      expect(existsSync(join(held, "file"))).toBe(true);
      expect(reads).toEqual({ path: 1, recursive: 1 });
      await abandonManagedLaunch(owner);
      expect(existsSync(held)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes a relative recorded path against the working directory at the record call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-managed-cwd-"));
    const start = process.cwd();
    const recorded = join(directory, "record");
    const released = join(directory, "release");
    try {
      for (const dir of [recorded, released]) mkdirSync(join(dir, "target"), { recursive: true });
      const resources = createManagedResources();
      process.chdir(recorded);
      recordManagedPaths(resources, { path: "target", recursive: true });
      process.chdir(released);
      await abandonManagedLaunch(resources);
      process.chdir(start);
      expect(existsSync(join(recorded, "target"))).toBe(false);
      expect(existsSync(join(released, "target"))).toBe(true);
    } finally {
      process.chdir(start);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a record on a handle while its release is in flight, from the first step to the end", async () => {
    const directory = join(tmpdir(), `ave-managed-inflight-${process.pid}-${Date.now()}`);
    const inFlight = "Managed resources are being released.";
    const refused: string[] = [];
    const early = createManagedResources();
    recordManagedCleanup(early, () => {
      for (const record of [() => recordManagedPaths(early, { path: join(directory, "early") }), () => recordManagedCleanup(early, () => {})]) {
        try { record(); } catch (error) { refused.push((error as Error).message); }
      }
    });
    await abandonManagedLaunch(early);
    expect(refused).toEqual([inFlight, inFlight]);
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let fail = true;
    const late = createManagedResources();
    recordManagedCleanup(late, () => gate.then(() => { if (fail) throw new Error("Injected step failure"); }));
    const release = abandonManagedLaunch(late);
    expect(() => recordManagedPaths(late, { path: join(directory, "late") })).toThrow(inFlight);
    expect(() => recordManagedCleanup(late, () => {})).toThrow(inFlight);
    open();
    await expect(release).rejects.toThrow("Injected step failure");
    // A failed release ends the in-flight state, so the retry may record again.
    const steps: string[] = [];
    recordManagedCleanup(late, () => steps.push("retry"));
    fail = false;
    await abandonManagedLaunch(late);
    expect(steps).toEqual(["retry"]);
    const next = createManagedResources();
    recordManagedPaths(next, { path: join(directory, "early") }, { path: join(directory, "late") });
    await abandonManagedLaunch(next);
  });

  it("refuses a record argument that breaks the path contract before storing any of the call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-managed-contract-"));
    const start = process.cwd();
    const sentinel = join(directory, "sentinel");
    try {
      writeFileSync(sentinel, "x");
      process.chdir(directory);
      const resources = createManagedResources();
      const valid = join(directory, "valid");
      for (const invalid of [{ path: "" }, { path: undefined }, { path: 0 }, { path: ".", recursive: "yes" }]) {
        expect(() => recordManagedPaths(resources, { path: valid, recursive: true }, invalid as never)).toThrow(TypeError);
      }
      const other = createManagedResources();
      recordManagedPaths(other, { path: valid, recursive: true });
      await abandonManagedLaunch(other);
      const later = join(directory, "later");
      mkdirSync(later);
      recordManagedPaths(resources, { path: later, recursive: true });
      await abandonManagedLaunch(resources);
      process.chdir(start);
      expect(existsSync(later)).toBe(false);
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      process.chdir(start);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a recorded path that resolves to the working directory or a filesystem root", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-managed-cwd-root-"));
    const start = process.cwd();
    const sentinel = join(directory, "sentinel");
    try {
      writeFileSync(sentinel, "x");
      process.chdir(directory);
      const resources = createManagedResources();
      for (const path of [".", "a/.."]) {
        expect(() => recordManagedPaths(resources, { path, recursive: true })).toThrow(TypeError);
      }
      await abandonManagedLaunch(resources);
      expect(existsSync(sentinel)).toBe(true);
      // Never released: a root accepted here would stay recorded instead of being removed.
      for (const path of ["/", ...process.platform === "win32" ? ["C:\\"] : []]) {
        expect(() => recordManagedPaths(createManagedResources(), { path, recursive: true })).toThrow(TypeError);
      }
    } finally {
      process.chdir(start);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a nested release started from the handle's own first step", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-managed-nested-"));
    try {
      const kept = join(directory, "kept");
      mkdirSync(kept);
      writeFileSync(join(kept, "file"), "x");
      const resources = createManagedResources();
      let nested: Promise<void> | undefined;
      recordManagedCleanup(resources, () => { nested = abandonManagedLaunch(resources); nested.catch(() => {}); });
      recordManagedPaths(resources, { path: kept });
      await expect(abandonManagedLaunch(resources)).rejects.toThrow();
      await expect(nested).rejects.toThrow("Managed resources are being released.");
      expect(() => recordManagedPaths(createManagedResources(), { path: kept })).toThrow("another live handle recorded");
      rmSync(kept, { recursive: true });
      await abandonManagedLaunch(resources);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets an ancestor record a path containing one its live descendant recorded", async () => {
    const directory = join(tmpdir(), `ave-managed-descendant-${process.pid}-${Date.now()}`);
    const ancestor = createManagedResources();
    const descendant = createManagedResources(ancestor);
    recordManagedPaths(descendant, { path: join(directory, "x", "y"), recursive: true });
    recordManagedPaths(ancestor, { path: join(directory, "x"), recursive: true });
    await abandonManagedLaunch(descendant);
    await abandonManagedLaunch(ancestor);
  });

  it("keeps a path refused after its handle's release failed, until the retry succeeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-managed-failed-release-"));
    try {
      const kept = join(directory, "kept");
      mkdirSync(kept);
      writeFileSync(join(kept, "file"), "x");
      const resources = createManagedResources();
      // A directory recorded without recursive makes the owner's removal fail.
      recordManagedPaths(resources, { path: kept });
      await expect(abandonManagedLaunch(resources)).rejects.toThrow();
      expect(() => recordManagedPaths(createManagedResources(), { path: kept })).toThrow("another live handle recorded");
      rmSync(kept, { recursive: true });
      await abandonManagedLaunch(resources);
      const next = createManagedResources();
      recordManagedPaths(next, { path: kept });
      await abandonManagedLaunch(next);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a sibling path that only shares a name prefix with another live handle's path", async () => {
    const directory = join(tmpdir(), `ave-managed-prefix-${process.pid}-${Date.now()}`);
    const first = createManagedResources();
    recordManagedPaths(first, { path: join(directory, "a"), recursive: true });
    const second = createManagedResources();
    recordManagedPaths(second, { path: join(directory, "ab"), recursive: true });
    await abandonManagedLaunch(first);
    await abandonManagedLaunch(second);
  });

  it("issues the never-spawned release only before any child was acquired beneath the handle", async () => {
    const idle = createManagedResources();
    const steps: string[] = [];
    recordManagedCleanup(idle, () => steps.push("idle"));
    await abandonManagedLaunch(idle);
    expect(steps).toEqual(["idle"]);
    const parent = createManagedResources();
    await confirmedUnder(createManagedResources(parent));
    await expect(abandonManagedLaunch(parent)).rejects.toThrow("Managed exit was not confirmed.");
  });

  it("withholds a group receipt until the leader closed and its group is gone", async () => {
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 4242 });
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -4242 && signal === 0 && !groupAlive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);
    try {
      const resources = createManagedResources();
      const verdict = observeManagedProcessGroup(child, resources).confirmExit();
      let settled = false;
      void verdict.then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      child.emit("close", 0, null);
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      groupAlive = false;
      const receipt = await verdict;
      expect(receipt).toBeDefined();
      if (receipt) await releaseManagedResources(resources, receipt);
    } finally {
      kill.mockRestore();
    }
  });

  it("keeps a relay receipt to relay handles", async () => {
    const relayChild = exitedChild();
    const relayExit = observeManagedWindowsRelayExit(relayChild, createManagedRelayResources());
    relayChild.emit("exit", 0, null);
    const relay = await relayExit;
    await expect(releaseManagedResources(createManagedResources(), relay)).rejects.toThrow("Managed exit was not confirmed.");
    expect(() => observeManagedWindowsRelayExit(exitedChild(), createManagedResources())).toThrow("do not accept this exit evidence");
    expect(() => observeManagedProcessGroup(exitedChild(), createManagedRelayResources())).toThrow("do not accept this exit evidence");
  });

  it("runs every step past a throwing one and keeps only the failed step for the next release", async () => {
    const resources = createManagedResources();
    const steps: string[] = [];
    let fail = true;
    recordManagedCleanup(resources, () => steps.push("first"), async () => {
      if (fail) throw new Error("Injected step failure");
      steps.push("second");
    }, () => steps.push("third"));
    const receipt = await confirmedUnder(resources);
    await expect(releaseManagedResources(resources, receipt)).rejects.toThrow("Injected step failure");
    expect(steps).toEqual(["first", "third"]);
    fail = false;
    await releaseManagedResources(resources, receipt);
    await releaseManagedResources(resources, receipt);
    expect(steps).toEqual(["first", "third", "second"]);
    expect(() => recordManagedCleanup(resources, () => {})).toThrow("already released");
  });
});

describe("managed process exit source rules", () => {
  it("acquires the scanner and waits on the managed verdict before success or scratch cleanup", () => {
    expect(scanner.match(/\bspawnManaged\(/gu)).toHaveLength(2);
    expect(scanner.match(/\brunWithCeiling\(/gu)).toHaveLength(1);
    expect(scannerWaitsForVerdict(scanner)).toBe(true);
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
    expect(appearsInOrder(observer, 'const recordExit = acquireManagedExit<ConfirmedExit>(resources, "confirmed");', 'child.once("close",',
      "wait: (signal?: AbortSignal) => raceWithAbort(closed, signal),",
      "await waitForManagedProcessGroupExit(child, closed, stopReason) ? recordExit() : undefined")).toBe(true);
  });

  it("forbids local POSIX child close or exit waits and uses the managed launch and group verdict", () => {
    expect(hook).not.toMatch(/\bspawn\(/u);
    for (const source of [scanner, posixHook]) {
      expect(source).not.toMatch(LOCAL_CHILD_WAIT);
      expect(source).not.toMatch(LOCAL_TERMINATION_POLICY);
    }
    const waited = posixHook.replace("    waitingForGroup = true;", '    await new Promise<void>(resolve => child.once("exit", () => resolve()));\n    waitingForGroup = true;');
    expect(waited).not.toBe(posixHook);
    expect(waited).toMatch(LOCAL_CHILD_WAIT);
    expect(appearsInOrder(posixHook, "observeManagedProcessGroup(child, input.resources)", "exit.wait(stopping.signal)",
      "const proof = await exit.confirmExit(stopReason);", "if (!proof)", 'return input.deny(t("be_scriptHookRunner.terminationUnverified"',
      "await exit.wait();", "await releaseManagedResources(input.resources, proof).catch(logReleaseFailure(input.hookId));")).toBe(true);
  });

  it.each(WINDOWS_RELEASE_PATHS)("%s preserves main's termination and cleanup steps", (_path, source, check) => {
    expect(check(source)).toBe(true);
  });

  it.each(WINDOWS_RELEASE_PATHS)("%s rejects a missing termination or wait step", (_path, source, check, step) => {
    const missingStep = source.replace(step, "");
    expect(missingStep).not.toBe(source);
    expect(check(missingStep)).toBe(false);
  });

  it("uses only managed termination deadlines in the engine", () => {
    expect(engineHasOnlyWorkloadDeadlines(engine)).toBe(true);
  });

  it.each(LIFETIME_MUTATIONS)("rejects %s", (_name, source, check, from, to) => {
    const mutated = source.replace(from, to);
    expect(mutated).not.toBe(source);
    expect(check(mutated)).toBe(false);
  });
});

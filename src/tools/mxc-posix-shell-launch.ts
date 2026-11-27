import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { sameFileIdentity } from "../lib/file-identity.js";
import { trackManagedChildProcess } from "../main/managed-child-processes.js";
import {
  aveHomeReadBoundaryCovering, getDefaultSensitiveWriteDenyEntries, getProtectedReadDenyFloor,
  getUserReadDenies, protectedReadDenyMatcher, runWithSandboxWritePreflight,
} from "../permissions/asrt-sandbox.js";
import { openHostEgressListener } from "../permissions/egress-host-listener.js";
import { openInvocationProxyListener } from "../permissions/egress-invocation-listener.js";
import {
  egressInvocationAbortSignal, egressInvocationOwner, onEgressInvocationReleased, releaseEgressInvocation,
} from "../permissions/egress-invocations.js";
import { resolveHostLauncherPath } from "../permissions/mxc-launcher.js";
import { buildSeatbeltShellRequest } from "../permissions/mxc-macos.js";
import { posixPolicyLookups } from "../permissions/mxc-posix.js";
import { requireMxcContainerStartRoot } from "../permissions/mxc-runtime-root.js";
import { detectMxcShellCapability, onSandboxStatusChanged } from "../permissions/sandbox-capability.js";
import { policyFloorRow } from "../permissions/policy-model.js";
import { buildSeatbeltSandboxWritePolicy } from "../permissions/sandbox-write-policy.js";
import { sleep } from "../shared/abortable-deadline.js";
import { isRecord } from "../shared/is-record.js";
import { getPolicyHome } from "../shared/policy-home.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { ContainedShellLifecycle } from "./contained-shell-lifecycle.js";
import { shellPolicyModel, type PrepareMxcShellLaunchInput } from "./mxc-shell-launch.js";
import { buildSafeChildEnv } from "./safe-env.js";

interface PreparePosixShellInput extends Pick<PrepareMxcShellLaunchInput, "egressToken" | "commandLine" | "cwd" | "env" | "timeoutMs"> {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly floorPierces: readonly string[];
}

type LauncherChild = ChildProcessByStdio<null, Readable, Readable>;

function pathFoldsCase(path: string): boolean {
  const device = lstatSync(path, { bigint: true }).dev;
  for (let entry = path; entry !== "/"; entry = dirname(entry)) {
    const original = lstatSync(entry, { bigint: true });
    if (original.dev !== device) break;
    const name = basename(entry);
    const variant = name.replace(/[a-z]/iu, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    if (variant === name) continue;
    const other = lstatSync(join(dirname(entry), variant), { bigint: true, throwIfNoEntry: false });
    return other !== undefined && sameFileIdentity(original, other);
  }
  // Unknown volumes retain case-sensitive path keys and the extra write-floor variants.
  return false;
}

function directLauncherChild(parent: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid="], {
      timeout: TOOL_TIMEOUT_POLICY.mxcMacShellChildLookupMs,
      env: buildSafeChildEnv(),
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      const entries = stdout.split("\n").map(line => line.trim().split(/\s+/u).map(Number))
        .filter(([pid, ppid]) => pid !== undefined && pid > 1 && ppid === parent);
      resolve(entries.length === 1 ? entries[0]?.[0] : undefined);
    });
  });
}

function signalOwnedProcess(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function reapLauncherChild(launcher: LauncherChild, exited: Promise<unknown>, graceMs: number): Promise<void> {
  const parent = launcher.pid;
  if (parent === undefined) return;
  const stillRunning = (): boolean => launcher.exitCode === null && launcher.signalCode === null;
  const until = performance.now() + graceMs;
  while (stillRunning() && performance.now() < until) {
    const child = await directLauncherChild(parent).catch(() => undefined);
    if (child !== undefined && stillRunning()) {
      // Only the supervisor's child gets the signal. Its exit makes the supervisor reap
      // the whole sandbox, including descendants that left the launcher's process group.
      signalOwnedProcess(child, "SIGKILL");
      await Promise.race([exited, sleep(Math.max(0, until - performance.now()))]);
      break;
    }
    await Promise.race([exited, sleep(TOOL_TIMEOUT_POLICY.mxcMacShellChildPollMs)]);
  }
  if (!stillRunning()) return;
  signalOwnedProcess(-parent, "SIGTERM");
  await Promise.race([exited, sleep(graceMs)]);
  if (stillRunning()) signalOwnedProcess(-parent, "SIGKILL");
}

function isLauncherErrorEnvelope(line: string): boolean {
  if (!line.trimStart().startsWith('{"error":')) return false;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) && isRecord(value.error) && value.error.code === "backend_error" && typeof value.error.message === "string";
  } catch { return false; }
}

function superviseLauncher(
  launcher: LauncherChild, lifecycle: ContainedShellLifecycle, timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs;
  const grace = TOOL_TIMEOUT_POLICY.mxcMacShellReapGraceMs;
  let tail = "";
  let timedOut = false;
  let cancelled = false;
  let reaping: Promise<void> | undefined;

  const stop = (): void => {
    reaping ??= reapLauncherChild(launcher, close, grace);
    // The close path reports any teardown failure after the launcher leaves.
    void reaping.catch(() => {});
  };
  const handleAbort = (): void => {
    cancelled = !timedOut;
    stop();
  };
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    launcher.once("error", error => { if (launcher.pid === undefined) reject(error); });
    launcher.once("close", (code, signal) => resolve({ code, signal }));
  });
  launcher.stderr.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-8192); });
  lifecycle.jobStarted(close);
  lifecycle.signal.addEventListener("abort", handleAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    lifecycle.revoke();
  }, timeoutMs + grace);
  const completion = close.then(async ({ code, signal }) => {
    await reaping;
    // The backend's own deadline is earlier than the host watchdog. Its status 255 also
    // represents a command signal or a literal exit 255.
    const rejected = !cancelled && code === 255 && tail.split("\n").some(isLauncherErrorEnvelope);
    timedOut ||= !cancelled && !rejected && code === 255 && performance.now() >= deadline;
    return { code, signal, timedOut, cancelled, rejected };
  }).finally(() => {
    clearTimeout(timer);
    lifecycle.signal.removeEventListener("abort", handleAbort);
    lifecycle.revoke();
  });
  if (lifecycle.signal.aborted) handleAbort();
  return completion;
}

export async function prepareMxcPosixShellLaunch(input: PreparePosixShellInput, lifecycle: ContainedShellLifecycle) {
  const capability = detectMxcShellCapability();
  if (capability?.platform !== "darwin") throw new Error("macOS container shell route is unavailable");
  const runtimeRoot = requireMxcContainerStartRoot();
  const token = input.egressToken;
  const owner = egressInvocationOwner(token);
  if (owner?.kind !== "shell" || owner.requiresListener !== true) throw new Error("Container egress requires a live shell invocation");
  const invocationSignal = egressInvocationAbortSignal(token);
  const revoke = (): void => lifecycle.revoke();
  lifecycle.onRevoke(() => releaseEgressInvocation(token));
  lifecycle.defer(onEgressInvocationReleased(released => { if (released === token) revoke(); }));
  lifecycle.defer(onSandboxStatusChanged(() => { if (detectMxcShellCapability() !== capability) revoke(); }));
  invocationSignal?.addEventListener("abort", revoke, { once: true });
  lifecycle.defer(() => invocationSignal?.removeEventListener("abort", revoke));
  if (invocationSignal?.aborted) revoke();

  const assertAdmission = (): void => {
    invocationSignal?.throwIfAborted();
    lifecycle.signal.throwIfAborted();
    if (egressInvocationOwner(token) !== owner || detectMxcShellCapability() !== capability) {
      throw new Error("Container shell authority changed before start");
    }
    requireMxcContainerStartRoot();
  };
  assertAdmission();
  const launcher = await resolveHostLauncherPath("darwin-arm64");
  const hostHome = getPolicyHome();
  const inRuntime = protectedReadDenyMatcher([runtimeRoot]);
  if (inRuntime(input.cwd) !== undefined) throw new Error("Container shell working directory is inside the sandbox runtime root");
  const admittedPath = (path: string) => inRuntime(path) === undefined && aveHomeReadBoundaryCovering(path) === undefined;
  const sensitive = getDefaultSensitiveWriteDenyEntries();
  const routingPaths = sensitive.map(entry => typeof entry === "string" ? entry : entry.path);
  const mandatory = await runWithSandboxWritePreflight(lifecycle.signal, () =>
    buildSeatbeltSandboxWritePolicy(input.allowWrite.filter(admittedPath), undefined, routingPaths));
  const userDenyRead = getUserReadDenies();
  const protectedFloor = getProtectedReadDenyFloor().filter(path => !userDenyRead.includes(path));
  const model = shellPolicyModel({
    allowRead: ["/", ...input.allowRead.filter(admittedPath)], allowWrite: mandatory.allowWrite,
    denyRead: [...input.denyRead, runtimeRoot], userDenyRead, protectedFloor,
    denyWrite: [],
    floorPierces: input.floorPierces,
  }, [...mandatory.literalRows, ...mandatory.patternRows, ...sensitive.map(entry =>
    policyFloorRow(typeof entry === "string" ? entry : entry.path, "ro", "protected-name", typeof entry !== "string"))]);
  const roots = [hostHome, input.cwd, ...mandatory.allowWrite];
  const lookups = posixPolicyLookups(hostHome, false);
  const foldsCase = roots.every(path => pathFoldsCase(lookups.canonical(path)));

  let active = false;
  const admission = {
    signal: lifecycle.signal,
    assertCanBind: assertAdmission,
    acceptsConnections: () => active && !lifecycle.signal.aborted,
    adopt: (close: () => Promise<void>) => lifecycle.defer(close),
  };
  const relay = await openHostEgressListener(token, admission);
  const listener = await openInvocationProxyListener({
    admission,
    upstream: () => admission.acceptsConnections()
      ? { host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }
      : undefined,
    onRefused: relay.recordRefusal,
  });
  relay.registerPort(listener.port);

  assertAdmission();
  const { request, grants } = buildSeatbeltShellRequest({
    ...input, model, lookups: { ...lookups, foldsCase }, proxyUrl: listener.url,
  });
  const staging = await mkdtemp(join(runtimeRoot, "shell-"));
  lifecycle.defer(() => rm(staging, { recursive: true }));
  const config = join(staging, "request.json");
  await writeFile(config, JSON.stringify(request), { flag: "wx", mode: 0o600 });

  return {
    carvedReadLimitedAt: grants.carvedReadLimitedAt,
    proxyPort: listener.port,
    narrowedWriteRoots: mandatory.narrowedWriteRoots,
    start(label: string) {
      if (active) throw new Error("Container shell launch already started");
      assertAdmission();
      launcher.assertInPlace();
      active = true;
      const child = spawn(launcher.path, ["--config", config], {
        cwd: dirname(launcher.path), env: buildSafeChildEnv(), shell: false, detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const completion = superviseLauncher(child, lifecycle, input.timeoutMs);
      trackManagedChildProcess(child, { label });
      return { child, completion };
    },
  };
}

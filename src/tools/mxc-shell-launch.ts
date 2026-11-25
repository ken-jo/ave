// Prepare invocation-scoped container launch resources. The invocation's lifecycle closes the proxy only after the launcher and its job
// have exited, so a surviving process can never reach a port reused by another invocation.
import { win32 as winPath } from "node:path";
import type { ChildProcess } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { windowsSystemRoot } from "../shared/windows-system-path.js";

import { aveHomeReadBoundaryCovering, getProtectedReadDenyFloor } from "../permissions/asrt-sandbox.js";
import { openInvocationProxyListener } from "../permissions/egress-invocation-listener.js";
import { openHostEgressListener } from "../permissions/egress-host-listener.js";
import { egressInvocationAbortSignal, egressInvocationOwner, onEgressInvocationReleased, releaseEgressInvocation } from "../permissions/egress-invocations.js";
import { detectMxcShellCapability, getWindowsShellConsentRevision, onSandboxStatusChanged } from "../permissions/sandbox-capability.js";
import {
  buildMxcShellRequest,
  openMxcRequestTransport,
  rankMxcFilesystem,
  resolveHostWxcExecPath,
  type MxcDirectoryEntry,
} from "../permissions/mxc-windows.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "../permissions/policy-model.js";
import type { ContainedShellLifecycle } from "./contained-shell-lifecycle.js";

export interface MxcShellLaunch {
  /** `wxc-exec.exe` followed by its arguments; spawn with `shell: false`. */
  readonly argv: readonly string[];
  readonly proxyPort: number;
  /** Admit connections after the final shell admission checks, immediately before spawn. */
  activate(): void;
  /** Bind policy delivery immediately after spawning the launcher. */
  bindChild(child: ChildProcess): void;
}

export interface PrepareMxcShellLaunchInput {
  /** The invocation's egress token (`egress-invocations.ts`): the identity its listener stamps. */
  readonly egressToken: string;
  readonly commandLine: string;
  readonly cwd: string;
  /** What the shell computed for this command. The protected read floor is added here. */
  readonly filesystem: {
    readonly allowWrite: readonly string[];
    readonly allowRead: readonly string[];
    /** Read denies a more specific grant re-opens (the session read boundary, the Ave home, sandbox private directories). */
    readonly denyRead: readonly string[];
    /** The write floor. */
    readonly denyWrite: readonly string[];
    /** Reads the shell holds inside the protected floor on purpose (the saved session history). */
    readonly floorPierces?: readonly string[];
  };
  /** The child's secret-stripped environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly exists: (path: string) => boolean;
  /** Lists a directory without following links; defaults to the real filesystem. */
  readonly list?: (directory: string) => readonly MxcDirectoryEntry[];
}

// Listing reports every Windows reparse point as a link; lstat tells a real link (symlink, junction) from a placeholder directory such as a cloud file.
function listDirectory(directory: string): MxcDirectoryEntry[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry): MxcDirectoryEntry[] => {
    if (entry.isDirectory()) return [{ name: entry.name, kind: "directory" }];
    if (!entry.isSymbolicLink()) return [{ name: entry.name, kind: "file" }];
    let target: ReturnType<typeof lstatSync>;
    try { target = lstatSync(winPath.join(directory, entry.name)); }
    catch (error) {
      // Removed since the listing: nothing is left to deny.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return [{ name: entry.name, kind: target.isSymbolicLink() ? "link" : target.isDirectory() ? "reparse-directory" : "file" }];
  });
}

/** Margin MXC's own timeout keeps behind the host's lifetime watch. */
const MXC_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Every resource is registered with `lifecycle` as it is allocated, and every failure is thrown raw: the
 * lifecycle's owner disposes and formats. Ending the invocation (its release, its cancellation, a route or
 * consent change) revokes the lifecycle, which stops all forwarding at once.
 */
export async function prepareMxcShellLaunch(input: PrepareMxcShellLaunchInput, lifecycle: ContainedShellLifecycle): Promise<MxcShellLaunch> {
  const capability = detectMxcShellCapability();
  if (capability === undefined) throw new Error("Container shell route is unavailable");
  const consentRevision = getWindowsShellConsentRevision();
  const token = input.egressToken;
  const owner = egressInvocationOwner(token);
  if (owner?.kind !== "shell" || owner.requiresListener !== true) {
    throw new Error("Container egress requires a live shell invocation");
  }
  lifecycle.onRevoke(() => releaseEgressInvocation(token));
  const invocationSignal = egressInvocationAbortSignal(token);
  let active = false;
  const isRouteCurrent = (): boolean =>
    detectMxcShellCapability() === capability && getWindowsShellConsentRevision() === consentRevision;
  // The invocation's own end (cancellation or release) is reported before what it caused.
  const assertAdmission = (): void => {
    invocationSignal?.throwIfAborted();
    if (!isRouteCurrent()) throw new Error("Container shell route is unavailable");
    if (egressInvocationOwner(token) !== owner) throw new Error("Container egress requires a live shell invocation");
    lifecycle.signal.throwIfAborted();
  };
  const admission = {
    signal: lifecycle.signal,
    assertCanBind: assertAdmission,
    acceptsConnections: () => active && !lifecycle.signal.aborted,
    adopt: (close: () => Promise<void>) => lifecycle.defer(close),
  };
  // Watched for the whole invocation: any of these ends it, before spawn or while the job runs.
  lifecycle.defer(onEgressInvocationReleased((released) => {
    if (released === token) lifecycle.revoke();
  }));
  lifecycle.defer(onSandboxStatusChanged(() => {
    if (!isRouteCurrent()) lifecycle.revoke();
  }));
  const revokeOnAbort = (): void => lifecycle.revoke();
  invocationSignal?.addEventListener("abort", revokeOnAbort, { once: true });
  lifecycle.defer(() => invocationSignal?.removeEventListener("abort", revokeOnAbort));
  if (invocationSignal?.aborted === true) lifecycle.revoke();
  assertAdmission();
  let wxcExec: string;
  try {
    wxcExec = await resolveHostWxcExecPath();
  } catch {
    // The resolver's failures name the launcher's absolute path.
    throw new Error("Contained shell launcher could not be verified on this installation");
  }
  if (!input.exists(wxcExec)) {
    throw new Error("Contained shell launcher is missing from this installation");
  }
  // A grant would carve the Ave home deny open, so inside that home only a re-allowed child is granted.
  const insideBoundary = (path: string): boolean => aveHomeReadBoundaryCovering(path) !== undefined;
  const allowRead = input.filesystem.allowRead.filter((path) => !insideBoundary(path));
  const allowWrite = input.filesystem.allowWrite.filter((path) => !insideBoundary(path));
  const protectedFloor = getProtectedReadDenyFloor();
  // The shell's lists are spellings as the shell composed them, and its interface does not say which grant stands behind a root.
  const grants = rankMxcFilesystem(buildPolicyModel({
    floors: [
      ...input.filesystem.denyRead.map((path) => policyFloorRow(path, "denied", "read-boundary")),
      ...input.filesystem.denyWrite.map((path) => policyFloorRow(path, "ro", "protected-name")),
      ...protectedFloor.map((path) => policyFloorRow(path, "denied", "secrets")),
    ],
    userGrants: [],
    extensionManifests: [],
    launchGrants: [
      ...allowWrite.map((path) => policyGrantRow(path, "rw", "launch-grant")),
      ...allowRead.map((path) => policyGrantRow(path, "ro", "launch-grant")),
      ...(input.filesystem.floorPierces ?? []).map((path) => policyGrantRow(path, "ro", "floor-pierce")),
    ],
  }), input.exists, input.list ?? listDirectory);
  assertAdmission();
  const relay = await openHostEgressListener(token, admission);
  assertAdmission();
  const listener = await openInvocationProxyListener({
    admission,
    upstream: () => admission.acceptsConnections()
      ? { host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }
      : undefined,
    onRefused: relay.recordRefusal,
  });
  assertAdmission();
  relay.registerPort(listener.port);
  const systemRoot = windowsSystemRoot();
  const env: Record<string, string> = { ...input.env };
  if (!Object.keys(env).some((key) => key.toUpperCase() === "SYSTEMROOT")) env["SYSTEMROOT"] = systemRoot;
  const request = buildMxcShellRequest({
    commandLine: input.commandLine,
    cwd: winPath.normalize(input.cwd),
    grants,
    env,
    proxyUrl: listener.url,
    timeoutMs: input.timeoutMs + MXC_TIMEOUT_MARGIN_MS,
  });
  const transport = await openMxcRequestTransport(request, wxcExec);
  lifecycle.defer(() => transport.release());
  assertAdmission();
  return {
    argv: [wxcExec, ...transport.args],
    proxyPort: listener.port,
    activate: () => {
      assertAdmission();
      active = true;
    },
    bindChild: transport.bindChild,
  };
}

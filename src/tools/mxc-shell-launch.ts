// Prepare invocation-scoped container launch resources. The invocation's lifecycle closes the proxy only after the launcher and its job
// have exited, so a surviving process can never reach a port reused by another invocation.
import { win32 as winPath } from "node:path";
import type { ChildProcess } from "node:child_process";
import { windowsSystemRoot } from "../shared/windows-system-path.js";

import { aveHomeReadBoundaryCovering, getProtectedReadDenyFloor, getUserReadDenies } from "../permissions/asrt-sandbox.js";
import { openInvocationProxyListener } from "../permissions/egress-invocation-listener.js";
import { openHostEgressListener } from "../permissions/egress-host-listener.js";
import { egressInvocationAbortSignal, egressInvocationOwner, onEgressInvocationReleased, releaseEgressInvocation } from "../permissions/egress-invocations.js";
import { detectMxcShellCapability, onSandboxStatusChanged } from "../permissions/sandbox-capability.js";
import {
  buildMxcShellRequest,
  openMxcRequestTransport,
  rankMxcFilesystem,
  resolveHostWxcExecPath,
} from "../permissions/mxc-windows.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyModel } from "../permissions/policy-model.js";
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

/** A shell command's policy as the lists the shell composes. */
export interface MxcShellPolicyLists {
  readonly allowWrite: readonly string[];
  readonly allowRead: readonly string[];
  /** Read denies a more specific grant re-opens (the session read boundary, the Ave home, sandbox private directories). */
  readonly denyRead: readonly string[];
  /** The write floor. */
  readonly denyWrite: readonly string[];
  /** The protected read floor. A grant at or beneath a row is dropped. */
  readonly protectedFloor: readonly string[];
  /** The user's read denies. A grant at or beneath a row is dropped, and no pierce covers one. */
  readonly userDenyRead?: readonly string[];
  /** Reads the shell holds inside the protected floor on purpose (the saved session history). */
  readonly floorPierces?: readonly string[];
}

/**
 * The shell's lists as policy rows. The paths are spellings as the shell composed them, and its interface does not say which
 * grant stands behind a root. A path on both deny lists is stated twice; the container adapter reads the two lists differently.
 */
export function shellPolicyModel(lists: MxcShellPolicyLists): PolicyModel {
  return buildPolicyModel({
    floors: [
      ...lists.denyRead.map((path) => policyFloorRow(path, "denied", "read-boundary", false)),
      ...lists.denyWrite.map((path) => policyFloorRow(path, "ro", "protected-name", false)),
      ...lists.protectedFloor.map((path) => policyFloorRow(path, "denied", "secrets", false)),
      ...(lists.userDenyRead ?? []).map((path) => policyFloorRow(path, "denied", "user-deny", false)),
    ],
    userGrants: [],
    extensionManifests: [],
    launchGrants: [
      ...lists.allowWrite.map((path) => policyGrantRow(path, "rw", "launch-grant", false)),
      ...lists.allowRead.map((path) => policyGrantRow(path, "ro", "launch-grant", false)),
      ...(lists.floorPierces ?? []).map((path) => policyGrantRow(path, "ro", "floor-pierce", false)),
    ],
  });
}

export interface PrepareMxcShellLaunchInput {
  /** The invocation's egress token (`egress-invocations.ts`): the identity its listener stamps. */
  readonly egressToken: string;
  readonly commandLine: string;
  readonly cwd: string;
  /** What the shell computed for this command. The protected read floor is added here. */
  readonly filesystem: Omit<MxcShellPolicyLists, "protectedFloor" | "userDenyRead">;
  /** The child's secret-stripped environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly exists: (path: string) => boolean;
}

/** Margin MXC's own timeout keeps behind the host's lifetime watch. */
const MXC_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Every resource is registered with `lifecycle` as it is allocated, and every failure is thrown raw: the
 * lifecycle's owner disposes and formats. Ending the invocation (its release, its cancellation, a route
 * change) revokes the lifecycle, which stops all forwarding at once.
 */
export async function prepareMxcShellLaunch(input: PrepareMxcShellLaunchInput, lifecycle: ContainedShellLifecycle): Promise<MxcShellLaunch> {
  const capability = detectMxcShellCapability();
  if (capability === undefined) throw new Error("Container shell route is unavailable");
  const token = input.egressToken;
  const owner = egressInvocationOwner(token);
  if (owner?.kind !== "shell" || owner.requiresListener !== true) {
    throw new Error("Container egress requires a live shell invocation");
  }
  lifecycle.onRevoke(() => releaseEgressInvocation(token));
  const invocationSignal = egressInvocationAbortSignal(token);
  let active = false;
  const isRouteCurrent = (): boolean => detectMxcShellCapability() === capability;
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
  const userDenyRead = getUserReadDenies();
  const protectedFloor = getProtectedReadDenyFloor().filter((path) => !userDenyRead.includes(path));
  const grants = rankMxcFilesystem(shellPolicyModel({ ...input.filesystem, allowWrite, allowRead, protectedFloor, userDenyRead }));
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

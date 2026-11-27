// Prepare invocation-scoped container launch resources. The invocation's lifecycle closes the proxy only after the launcher and its job
// have exited, so a surviving process can never reach a port reused by another invocation.
import { sealTargetObservation } from "../permissions/target-seal.js";
import { resolvePathForPolicy } from "../permissions/sensitive-paths.js";
import { captureShellWorkingDirectoryIdentity } from "../permissions/shell-working-directory-identity.js";
import { win32 as winPath } from "node:path";
import { withLocalityDecision } from "../shared/local-path-io.js";
import { windowsSystemRoot } from "../shared/windows-system-path.js";
import { admitWindowsReparse, pinWindowsPaths, windowsObjectKey, windowsPathKey, type WindowsPathFacts } from "../shared/windows-path-facts.js";

import { appOwnedSandboxPrivateRoots, aveHomeReadBoundaryCovering, getProtectedReadDenyFloor, getUserReadDenies, insideOwnWindowsSandboxHome, protectedReadDenyMatcher } from "../permissions/asrt-sandbox.js";
import { assertWriteGrantsOutsideConfinementState, declaredConfinementStatePaths } from "../permissions/confinement-state-paths.js";
import { openInvocationProxyListener } from "../permissions/egress-invocation-listener.js";
import { openHostEgressListener } from "../permissions/egress-host-listener.js";
import { egressInvocationAbortSignal, egressInvocationOwner, onEgressInvocationReleased, releaseEgressInvocation } from "../permissions/egress-invocations.js";
import { detectMxcShellCapability, onSandboxStatusChanged } from "../permissions/sandbox-capability.js";
import { observeWindowsBackend, reportWindowsBackendLoss, type WindowsBackendObservation } from "../permissions/windows-confinement-evidence.js";
import {
  buildMxcShellRequest,
  getHostWxcExecIdentity,
  isWindowsPathAtOrUnder,
  MxcLauncherIntegrityError,
  type MxcRankedPath,
  mxcRankedGrantIdentity,
  openMxcRequestTransport,
  type MxcRequestTransport,
  rankMxcFilesystem,
  resolveHostWxcExecPath,
} from "../permissions/mxc-windows.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, requiredWriteDenyRow, type PolicyFloorRow, type PolicyModel } from "../permissions/policy-model.js";
import { requireMxcContainerStartRoot } from "../permissions/mxc-runtime-root.js";
import { assertIssuedContainerHomeInPlace, heldIssuedContainerHome, isIssuedContainerHome, issuedContainerHome } from "../permissions/sandbox-home-registry.js";
import { claimMxcWatchedRows, hasWatchedWork, sweepWatchedRows, WatchedQuarantineError } from "../permissions/windows-watched-rows.js";
import type { ContainedShellLifecycle } from "./contained-shell-lifecycle.js";

export interface MxcShellLaunch extends Pick<MxcRequestTransport, "bindChild" | "bindHeldPolicy"> {
  /** `wxc-exec.exe` followed by its arguments; spawn with `shell: false`. */
  readonly argv: readonly string[];
  readonly proxyPort: number;
  readonly watchedNotice?: string | undefined;
  /** Admit connections after the final shell admission checks, immediately before spawn. */
  activate(assertSpawnDirectory?: () => void): WindowsBackendObservation;
}

/** A shell command's policy as the lists the shell composes. */
export interface MxcShellPolicyLists {
  readonly allowWrite: readonly string[];
  readonly allowRead: readonly string[];
  /** Read denies a more specific grant re-opens (the session read boundary, the Ave home, sandbox private directories). */
  readonly denyRead: readonly string[];
  /** The mandatory write floor. A spelling also on `requiredWriteDenies` is that required row. */
  readonly denyWrite: readonly string[];
  /** Write denies stated on their own (the sensitive floor, configured rows): kept at a required row's spelling, with their own outcome. */
  readonly independentWriteDenies?: readonly string[];
  readonly requiredWriteDenies?: readonly string[];
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
export function shellPolicyModel(lists: MxcShellPolicyLists, literalAndPatternFloors: readonly PolicyFloorRow[] = []): PolicyModel {
  const required = new Set(lists.requiredWriteDenies);
  return buildPolicyModel({
    floors: [
      ...literalAndPatternFloors,
      ...lists.denyRead.map((path) => policyFloorRow(path, "denied", "read-boundary", false)),
      ...lists.denyWrite.filter(path => !required.has(path)).map((path) => policyFloorRow(path, "ro", "protected-name", false)),
      ...(lists.independentWriteDenies ?? []).map((path) => policyFloorRow(path, "ro", "protected-name", false)),
      ...[...required].map((path) => requiredWriteDenyRow(path)),
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
  /** The HOME the host created for this invocation: the one directory under the container runtime root it is granted. */
  readonly sandboxHome?: string;
  /** The child's secret-stripped environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly directoryHeld?: boolean;
  readonly exists: (path: string) => boolean;
  readonly assertCommand?: () => void;
  readonly assertDelivery?: () => void;
}

function matchesRankedPath({ path, obligation }: MxcRankedPath, facts: WindowsPathFacts | undefined): boolean {
  if (!facts || admitWindowsReparse(facts, "grant") !== true) return false;
  if (obligation.kind === "missing" ? facts.exists !== false : facts.exists !== true
    || facts.directory !== obligation.directory || facts.canonical === null || windowsPathKey(facts.canonical) !== windowsPathKey(path)) return false;
  const existing = [...facts.ancestors, facts].filter(component => component.exists === true);
  const anchor = existing.at(-1)?.canonical;
  return anchor != null && windowsPathKey(anchor) === windowsPathKey(obligation.anchorTarget)
    && existing.length === obligation.chain.length
    && existing.every((component, index) => {
      const identity = obligation.chain[index];
      return identity !== undefined && windowsObjectKey(identity) === windowsObjectKey(component);
    });
}

/** Margin MXC's own timeout keeps behind the host's lifetime watch. */
const MXC_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Every resource is registered with `lifecycle` as it is allocated, and every failure is thrown raw: the
 * lifecycle's owner disposes and formats. Ending the invocation (its release, its cancellation, a route
 * change) revokes the lifecycle, which stops all forwarding at once.
 */
export async function prepareMxcShellLaunch(input: PrepareMxcShellLaunchInput, lifecycle: ContainedShellLifecycle): Promise<MxcShellLaunch> {
  // The HOME issuance this launch holds through every wait below.
  const issuedHome = issuedContainerHome(input.sandboxHome);
  const capability = detectMxcShellCapability();
  if (capability === undefined) throw new Error("Container shell route is unavailable");
  // Before anything is allocated: a runtime root that was not proved private refuses every container start.
  const runtimeRoot = requireMxcContainerStartRoot();
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
  let launcherIdentity: string;
  // Taken before the launcher check starts, so its failure reaches only the evidence it was measured against.
  const backendObservation = observeWindowsBackend("container", "shell");
  try {
    launcherIdentity = getHostWxcExecIdentity();
    wxcExec = await resolveHostWxcExecPath(launcherIdentity);
  } catch (error) {
    if (error instanceof MxcLauncherIntegrityError) reportWindowsBackendLoss(backendObservation);
    // The resolver's failures name the launcher's absolute path.
    throw new Error("Contained shell launcher could not be verified on this installation");
  }
  if (!input.exists(wxcExec)) {
    reportWindowsBackendLoss(backendObservation);
    throw new Error("Contained shell launcher is missing from this installation");
  }
  // The invocation's own HOME lies in the runtime root's state; it is passed only while live and still the issuance held.
  const ownHome = (): string | undefined => {
    if (issuedHome === undefined) return undefined;
    const held = heldIssuedContainerHome(issuedHome);
    return insideOwnWindowsSandboxHome(issuedHome.home, issuedHome.home) ? held : undefined;
  };
  // A grant would carve the Ave home deny open, so inside that home only a re-allowed child is granted.
  const { observation: { grants }, seal } = sealTargetObservation(() => {
    if (requireMxcContainerStartRoot() !== runtimeRoot) throw new Error("Container runtime root changed before spawn");
    const insideBoundary = (path: string): boolean => aveHomeReadBoundaryCovering(path) !== undefined;
    // The container runtime root is closed to reads and writes alike: a grant inside it would outrank its deny. Only this invocation's own HOME is granted there, and the deny is restated so it holds beneath a granted ancestor.
    const privateRoots = appOwnedSandboxPrivateRoots();
    const privateRootCovering = protectedReadDenyMatcher(privateRoots);
    const insideClosedRoot = (path: string): boolean =>
      privateRootCovering(path) !== undefined && !insideOwnWindowsSandboxHome(path, input.sandboxHome);
    assertIssuedContainerHomeInPlace(input.sandboxHome);
    // No working directory inside the root except the invocation's own issued HOME itself, by identity.
    if (privateRootCovering(input.cwd) !== undefined && !isIssuedContainerHome(input.cwd, input.sandboxHome)) throw new Error("Container shell working directory is inside the sandbox runtime root");
    // Before ranking: the runtime root is only an ordinary read deny there, which an equal or enclosing write survives.
    const home = ownHome();
    const statePaths = declaredConfinementStatePaths();
    assertWriteGrantsOutsideConfinementState(input.filesystem.allowWrite, statePaths, undefined, home);
    const allowRead = input.filesystem.allowRead.filter((path) => !insideBoundary(path) && !insideClosedRoot(path));
    const allowWrite = input.filesystem.allowWrite.filter((path) => !insideBoundary(path) && !insideClosedRoot(path));
    const denyRead = [...new Set([...input.filesystem.denyRead, ...privateRoots])];
    const userDenyRead = getUserReadDenies();
    const protectedFloor = getProtectedReadDenyFloor().filter((path) => !userDenyRead.includes(path));
    let rankedPaths: readonly MxcRankedPath[] = [];
    const grants = rankMxcFilesystem(shellPolicyModel({ ...input.filesystem, allowWrite, allowRead, denyRead, protectedFloor, userDenyRead }),
      paths => { rankedPaths = paths; });
    const allowed = [...grants.readwrite, ...grants.readonly];
    const cwdPaths = allowed.some(path => isWindowsPathAtOrUnder(input.cwd, path)) ? [input.cwd] : [];
    const paths = [...new Set([...cwdPaths, ...allowed, ...grants.denied]
      .map(path => {
        const normalized = winPath.normalize(path);
        return normalized === winPath.parse(normalized).root ? normalized : normalized.replace(/\\+$/u, "");
      }))];
    const facts = pinWindowsPaths(paths, { batch: true });
    const byPath = new Map(paths.map((path, index) => [windowsPathKey(path), facts[index]]));
    const witnessed = new Set(rankedPaths.map(({ path }) => windowsPathKey(path)));
    if ([...allowed, ...grants.denied].some(path => !witnessed.has(windowsPathKey(path)))
      || rankedPaths.some(proof => !matchesRankedPath(proof, byPath.get(windowsPathKey(proof.path))))) {
      throw new Error("Container filesystem grant changed before spawn");
    }
    const grantFacts = facts.map(row => [...row.ancestors, row].map(part => [part.exists,
      part.exists === true ? windowsObjectKey(part) : null, part.canonical, part.directory, part.reparseTag, part.reparseTarget]));
    assertWriteGrantsOutsideConfinementState(grants.readwrite, statePaths, undefined, home);
    const cwd = resolvePathForPolicy(input.cwd);
    const directory = process.platform === "win32" ? captureShellWorkingDirectoryIdentity(input.cwd) : undefined;
    return {
      cwd,
      cwdIdentity: directory === undefined ? undefined : [directory.realpath, String(directory.dev), String(directory.ino)],
      home,
      grants,
      grantIdentity: mxcRankedGrantIdentity(grants),
      grantFacts,
    };
  }, JSON.stringify);
  const assertDispatch = (): void => withLocalityDecision(() => {
    assertAdmission();
    seal.verify();
    input.assertCommand?.();
    if (getHostWxcExecIdentity() !== launcherIdentity) throw new Error("Contained shell launcher changed before spawn");
  });
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
  assertDispatch();
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
  const transport = await openMxcRequestTransport(request, wxcExec, {
    root: runtimeRoot, signal: lifecycle.signal,
    held: input.directoryHeld === true,
    assertStillValid: () => withLocalityDecision(() => {
      assertDispatch();
      if (active) input.assertDelivery?.();
    }),
  });
  lifecycle.defer(() => transport.release());
  assertAdmission();
  let watchedNotice: string | undefined;
  const claim = grants.watched === undefined ? undefined : claimMxcWatchedRows(grants.watched, { commandId: token });
  // Command end is a detection point: this launch's own names first, then every watched name and the receipts no result carried yet.
  lifecycle.defer(async () => {
    if (!active) return;
    const notices: string[] = [];
    let failure: unknown;
    for (const check of [() => claim?.release(), () => hasWatchedWork() ? sweepWatchedRows({ commandId: token }) : undefined]) {
      try {
        const notice = await check();
        if (notice !== undefined) notices.push(notice);
      } catch (error) {
        if (error instanceof WatchedQuarantineError) notices.push(error.message);
        failure = error;
        // The wider check would only report the same failed move again.
        break;
      }
    }
    if (notices.length > 0) watchedNotice = notices.join("\n");
    if (failure !== undefined) throw failure;
  });
  const bindHeldPolicy = transport.bindHeldPolicy;
  return {
    argv: [wxcExec, ...transport.args],
    proxyPort: listener.port,
    get watchedNotice() { return watchedNotice; },
    activate: (assertSpawnDirectory) => {
      const assertStillValid = (): void => {
        assertDispatch();
        assertSpawnDirectory?.();
      };
      if (claim === undefined) withLocalityDecision(assertStillValid);
      else claim.start(assertStillValid);
      const observation = observeWindowsBackend("container", "shell");
      active = true;
      return observation;
    },
    bindChild: (child) => {
      if (!active) throw new Error("Container shell launch must be active before binding a child");
      transport.bindChild(child);
    },
    ...(bindHeldPolicy !== undefined && {
      bindHeldPolicy: (launcher, readerPid, onFailure) => {
        if (!active) throw new Error("Container shell launch must be active before binding a child");
        return bindHeldPolicy(launcher, readerPid, onFailure);
      },
    }),
  };
}

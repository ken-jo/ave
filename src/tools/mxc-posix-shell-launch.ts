import { lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import {
  aveHomeReadBoundaryCovering, getDefaultSensitiveWriteDenyEntries, getProtectedReadDenyFloor,
  getUserReadDenies, protectedReadDenyMatcher, runWithSandboxWritePreflight,
} from "../permissions/asrt-sandbox.js";
import { openHostEgressListener } from "../permissions/egress-host-listener.js";
import { openInvocationProxyListener } from "../permissions/egress-invocation-listener.js";
import {
  egressInvocationAbortSignal, egressInvocationOwner, onEgressInvocationReleased,
} from "../permissions/egress-invocations.js";
import { buildSeatbeltShellRequest } from "../permissions/mxc-macos.js";
import { posixPolicyLookups } from "../permissions/mxc-posix.js";
import { requireMxcContainerStartRoot } from "../permissions/mxc-runtime-root.js";
import { stageMxcShellRequest, startMxcShellSupervisor } from "../permissions/mxc-shell-supervisor-client.js";
import { policyFloorRow } from "../permissions/policy-model.js";
import { detectMxcShellCapability, onSandboxStatusChanged } from "../permissions/sandbox-capability.js";
import { buildSeatbeltSandboxWritePolicy } from "../permissions/sandbox-write-policy.js";
import { getPolicyHome } from "../shared/policy-home.js";
import type { ContainedShellLifecycle } from "./contained-shell-lifecycle.js";
import { shellPolicyModel, type PrepareMxcShellLaunchInput } from "./mxc-shell-launch.js";

interface PreparePosixShellInput extends Pick<PrepareMxcShellLaunchInput, "egressToken" | "commandLine" | "cwd" | "env" | "timeoutMs"> {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly floorPierces: readonly string[];
}

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

export async function prepareMxcPosixShellLaunch(input: PreparePosixShellInput, lifecycle: ContainedShellLifecycle) {
  const capability = detectMxcShellCapability();
  if (capability?.platform !== "darwin") throw new Error("macOS container shell route is unavailable");
  const runtimeRoot = requireMxcContainerStartRoot();
  const token = input.egressToken;
  const owner = egressInvocationOwner(token);
  if (owner?.kind !== "shell" || owner.requiresListener !== true) throw new Error("Container egress requires a live shell invocation");
  const invocationSignal = egressInvocationAbortSignal(token);
  const revoke = (): void => lifecycle.revoke();
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
  const staged = await stageMxcShellRequest(join(staging, "request.json"), request);

  return {
    carvedReadLimitedAt: grants.carvedReadLimitedAt,
    proxyPort: listener.port,
    narrowedWriteRoots: mandatory.narrowedWriteRoots,
    start(label: string) {
      if (active) throw new Error("Container shell launch already started");
      assertAdmission();
      active = true;
      const launch = startMxcShellSupervisor(staged, input.timeoutMs, lifecycle.signal, revoke, label);
      lifecycle.jobStarted(launch.completion);
      return launch;
    },
  };
}

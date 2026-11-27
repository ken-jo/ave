import { lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import {
  aveHomeReadBoundaryCovering, getDefaultSensitiveWriteDenyEntries, getProtectedReadDenyFloor,
  getUserReadDenies, protectedReadDenyMatcher, runWithSandboxWritePreflight,
} from "../permissions/asrt-sandbox.js";
import { buildSeatbeltShellRequest } from "../permissions/mxc-macos.js";
import { posixPolicyLookups } from "../permissions/mxc-posix.js";
import { requireMxcContainerStartRoot } from "../permissions/mxc-runtime-root.js";
import { MxcCwdChangedError, stageMxcShellRequest, startMxcShellSupervisor, type MxcShellRunAuthorizer } from "../permissions/mxc-shell-supervisor-client.js";
import { captureShellWorkingDirectoryIdentity, type ShellWorkingDirectoryIdentity } from "../permissions/shell-working-directory-identity.js";
import { policyFloorRow } from "../permissions/policy-model.js";
import { detectMxcShellCapability } from "../permissions/sandbox-capability.js";
import { buildSeatbeltSandboxWritePolicy } from "../permissions/sandbox-write-policy.js";
import { getPolicyHome } from "../shared/policy-home.js";
import type { ContainedShellLifecycle } from "./contained-shell-lifecycle.js";
import { shellPolicyModel, type PrepareMxcShellLaunchInput } from "./mxc-shell-launch.js";
import { openShellEgressAdmission } from "./shell-egress-admission.js";

interface PreparePosixShellInput extends Pick<PrepareMxcShellLaunchInput, "egressToken" | "commandLine" | "cwd" | "env" | "timeoutMs"> {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly floorPierces: readonly string[];
  /** An identity already bound to this cwd, such as the approved directory of a permit; the staged one must equal it. */
  readonly cwdIdentity?: ShellWorkingDirectoryIdentity;
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
  const egress = openShellEgressAdmission({
    token: input.egressToken, lifecycle,
    isRouteCurrent: () => detectMxcShellCapability() === capability,
    assertPlatform: () => { requireMxcContainerStartRoot(); },
  });
  const { assertAdmission } = egress;
  assertAdmission();
  // The directory the grants are ranked for: staging, the supervisor and the workload each compare it again.
  const cwdIdentity = input.cwdIdentity ?? captureShellWorkingDirectoryIdentity(input.cwd);
  if (cwdIdentity === undefined) throw new MxcCwdChangedError();
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

  const listener = await egress.openProxy();

  assertAdmission();
  const { request, grants } = buildSeatbeltShellRequest({
    ...input, model, lookups: { ...lookups, foldsCase }, proxyUrl: listener.url,
  });
  const staging = await mkdtemp(join(runtimeRoot, "shell-"));
  lifecycle.defer(() => rm(staging, { recursive: true }));
  const staged = await stageMxcShellRequest(join(staging, "request.json"), request, cwdIdentity);

  return {
    carvedReadLimitedAt: grants.carvedReadLimitedAt,
    proxyPort: listener.port,
    narrowedWriteRoots: mandatory.narrowedWriteRoots,
    /** `authorize` is the caller's final check before user code runs; this route's own admission is checked inside it. */
    start(label: string, authorize: MxcShellRunAuthorizer) {
      if (egress.active) throw new Error("Container shell launch already started");
      assertAdmission();
      egress.activate();
      // A failed admission throws out of the final check, which withholds the grant.
      const launch = startMxcShellSupervisor(staged, input.timeoutMs, lifecycle.signal, () => lifecycle.revoke(), label, undefined,
        (grant) => authorize(() => {
          assertAdmission();
          return grant();
        }));
      lifecycle.jobStarted(launch.completion);
      return launch;
    },
  };
}

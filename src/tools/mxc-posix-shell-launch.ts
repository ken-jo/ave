import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sameFileIdentity } from "../lib/file-identity.js";
import { getHostResources } from "../main/host-resources.js";
import {
  aveHomeReadBoundaryCovering, getDefaultSensitiveWriteDenyEntries, getProtectedReadDenyFloor,
  getUserReadDenies, getUserWriteDenies, protectedReadDenyMatcher, runWithSandboxWritePreflight,
} from "../permissions/asrt-sandbox.js";
import { buildSeatbeltShellRequest } from "../permissions/mxc-macos.js";
import { buildBubblewrapShellRequest, projectLinuxSavedSessionDenies, requireMxcLinuxShellPrograms } from "../permissions/mxc-linux.js";
import { holdMxcLinuxPlaceholders } from "../permissions/mxc-linux-placeholders.js";
import { atOrUnder, posixPolicyLookups, rankPosixContainerRows, type PosixFilesystemGrants } from "../permissions/mxc-posix.js";
import { requireMxcContainerStartRoot } from "../permissions/mxc-runtime-root.js";
import { stageMxcShellRequest, startMxcShellSupervisor } from "../permissions/mxc-shell-supervisor-client.js";
import { policyFloorRow } from "../permissions/policy-model.js";
import { detectMxcShellCapability } from "../permissions/sandbox-capability.js";
import { prepareSandboxBareRepositoryCleanup } from "../permissions/sandbox-bare-repository-cleanup.js";
import { buildMandatorySandboxWritePolicy, buildSeatbeltSandboxWritePolicy, restrictSandboxGitControlSnapshot } from "../permissions/sandbox-write-policy.js";
import { startMxcLinuxShell } from "../sandbox/linux-container-shell.js";
import { holdSandboxGitWrites } from "../shared/host-git.js";
import { getPolicyHome } from "../shared/policy-home.js";
import type { ContainedShellLifecycle } from "./contained-shell-lifecycle.js";
import { shellPolicyModel, type PrepareMxcShellLaunchInput } from "./mxc-shell-launch.js";
import { openShellEgressAdmission } from "./shell-egress-admission.js";

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
  if (capability?.platform !== "darwin" && capability?.platform !== "linux") throw new Error("POSIX container shell route is unavailable");
  const linux = capability.platform === "linux";
  const runtimeRoot = requireMxcContainerStartRoot();
  const egress = openShellEgressAdmission({
    token: input.egressToken, lifecycle,
    isRouteCurrent: () => detectMxcShellCapability() === capability,
    assertPlatform: () => { requireMxcContainerStartRoot(); },
  });
  const { assertAdmission } = egress;
  assertAdmission();
  const hostHome = getPolicyHome();
  const inRuntime = protectedReadDenyMatcher([runtimeRoot]);
  if (inRuntime(input.cwd) !== undefined) throw new Error("Container shell working directory is inside the sandbox runtime root");
  const admittedPath = (path: string) => inRuntime(path) === undefined && aveHomeReadBoundaryCovering(path) === undefined;
  const sensitive = getDefaultSensitiveWriteDenyEntries();
  const routingPaths = sensitive.map(entry => typeof entry === "string" ? entry : entry.path);
  const programs = linux ? await requireMxcLinuxShellPrograms(getHostResources()) : undefined;
  const mandatory = await runWithSandboxWritePreflight(lifecycle.signal, () => {
    const allowWrite = input.allowWrite.filter(admittedPath);
    if (!linux) return { ...buildSeatbeltSandboxWritePolicy(allowWrite, undefined, routingPaths), gitControlSnapshot: undefined };
    const policy = buildMandatorySandboxWritePolicy(allowWrite, undefined, routingPaths,
      routingPaths.filter(path => path.startsWith("/") && !/[*?[\]]/u.test(path)));
    return {
      ...policy,
      literalRows: policy.denyWrite.map(entry => policyFloorRow(typeof entry === "string" ? entry : entry.path, "ro", "protected-name", true)),
      patternRows: [],
    };
  });
  const userDenyRead = getUserReadDenies();
  const protectedFloor = getProtectedReadDenyFloor().filter(path => !userDenyRead.includes(path));
  const lookups = posixPolicyLookups(hostHome, false);
  const allowRead = ["/", ...input.allowRead.filter(admittedPath)];
  const denyRead = [...input.denyRead, runtimeRoot];
  const reads = linux ? await projectLinuxSavedSessionDenies({
    denyRead, userDenyRead, lookups, grants: [...allowRead, ...mandatory.allowWrite, ...input.floorPierces], signal: lifecycle.signal,
  }) : { denyRead, userDenyRead, rows: [] };
  const model = shellPolicyModel({
    allowRead, allowWrite: mandatory.allowWrite,
    denyRead: reads.denyRead, userDenyRead: reads.userDenyRead, protectedFloor,
    denyWrite: [],
    floorPierces: input.floorPierces,
  }, [...reads.rows, ...mandatory.literalRows, ...mandatory.patternRows, ...sensitive.map(entry =>
    policyFloorRow(typeof entry === "string" ? entry : entry.path, "ro", "protected-name", linux || typeof entry !== "string")),
    ...(linux ? getUserWriteDenies().map(entry => policyFloorRow(
      typeof entry === "string" ? entry : entry.path, "ro", "protected-name", typeof entry !== "string" && entry.literal === true,
    )) : []),
    ...(programs === undefined ? [] : [programs.launcher, programs.helper].map(path =>
      policyFloorRow(dirname(path), "ro", "protected-name", true))),
  ]);
  const roots = [hostHome, input.cwd, ...mandatory.allowWrite];
  const foldsCase = !linux && roots.every(path => pathFoldsCase(lookups.canonical(path)));

  const listener = await egress.openProxy();

  assertAdmission();
  const held = programs === undefined ? undefined : await holdMxcLinuxPlaceholders(lookups,
    (current) => rankPosixContainerRows(model, "bubblewrap", current));
  if (held !== undefined) lifecycle.defer(() => held.release());
  const { request, grants, environment } = programs !== undefined && held !== undefined
    ? { grants: held.grants, ...buildBubblewrapShellRequest({
      ...input, grants: held.grants, lookups, helper: programs.helper, proxyUrl: listener.url,
    }) }
    : { ...buildSeatbeltShellRequest({ ...input, model, lookups: { ...lookups, foldsCase }, proxyUrl: listener.url }), environment: undefined };
  const staging = await mkdtemp(join(runtimeRoot, "shell-"));
  lifecycle.defer(() => rm(staging, { recursive: true }));
  const staged = await stageMxcShellRequest(join(staging, "request.json"), request);
  // Linux only: the shell's environment, beside the request under the runtime root, handed over on a descriptor.
  const environmentPath = join(staging, "environment.sh");
  const stagedEnvironment = environment === undefined ? undefined : await (async () => {
    const bytes = Buffer.from(environment);
    await writeFile(environmentPath, bytes, { flag: "wx", mode: 0o600 });
    return { environmentPath, environmentSha256: createHash("sha256").update(bytes).digest("hex") };
  })();
  const writeRoots = mandatory.allowWrite.filter(path => grants.readwrite.includes(lookups.canonical(path)));
  const cleanupGit = mandatory.gitControlSnapshot === undefined ? undefined : await prepareSandboxBareRepositoryCleanup(
    writeRoots, basename(staging), restrictSandboxGitControlSnapshot(mandatory.gitControlSnapshot, writeRoots, gitExclusions(grants)),
  );

  return {
    carvedReadLimitedAt: grants.carvedReadLimitedAt,
    proxyPort: listener.port,
    narrowedWriteRoots: mandatory.narrowedWriteRoots,
    start(label: string) {
      if (egress.active) throw new Error("Container shell launch already started");
      assertAdmission();
      egress.activate();
      const revoke = (): void => lifecycle.revoke();
      if (programs !== undefined && held !== undefined) {
        if (stagedEnvironment === undefined) throw new Error("Linux container shell has no staged environment");
        programs.validate();
        held.validate();
        const releaseGit = cleanupGit === undefined ? undefined : holdSandboxGitWrites(writeRoots);
        let launch: ReturnType<typeof startMxcLinuxShell>;
        try { launch = startMxcLinuxShell(programs, { ...staged, ...stagedEnvironment }, input.timeoutMs, lifecycle.signal, revoke, label); } catch (error) {
          releaseGit?.();
          throw error;
        }
        const pid = launch.child.pid;
        const marked = pid === undefined ? Promise.resolve() : held.recordLauncher(pid).catch((error: unknown) => {
          revoke();
          return error;
        });
        const settled = launch.completion.then(exit => ({ exit }), (error: unknown) => ({ error }));
        const completion = Promise.all([settled, marked]).then(async ([outcome, markerError]) => {
          // Quarantine runs after every launch: no exit status or stderr line can prove the command did not start.
          let cleanupNotice: string | undefined;
          try { await held.release(); } finally {
            try { cleanupNotice = cleanupGit?.(); } finally { releaseGit?.(); }
          }
          if ("error" in outcome) throw outcome.error;
          if (markerError !== undefined) throw markerError;
          return { ...outcome.exit, ...(cleanupNotice === undefined ? {} : { cleanupNotice }) };
        });
        lifecycle.jobStarted(completion);
        return { child: launch.child, completion };
      }
      const launch = startMxcShellSupervisor(staged, input.timeoutMs, lifecycle.signal, revoke, label);
      lifecycle.jobStarted(launch.completion);
      return launch;
    },
  };
}

function gitExclusions(grants: PosixFilesystemGrants): (path: string, includesChildren?: boolean) => boolean {
  const protectedRows = [...grants.readonly, ...grants.denied];
  const covering = (path: string, rows: readonly string[]) => Math.max(-1,
    ...rows.filter(root => atOrUnder(path, root, false)).map(root => root.length));
  return (path, includesChildren) => covering(path, grants.readwrite) <= covering(path, protectedRows)
    || (includesChildren === true && protectedRows.some(row => atOrUnder(row, path, false)));
}

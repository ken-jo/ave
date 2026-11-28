// The Linux half of row-2 holder admission: the proven route, the holder's rows, its staging folder and the native
// start, for the orchestration in `confined-child.ts`. A Linux holder runs on the system bwrap with the call the pinned
// launcher made for its request (`mxc-linux-holder-launch.ts`); nothing here reaches the old wrap.
import { constants as osConstants } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, posix } from "node:path";
import { getPolicyHome } from "../shared/policy-home.js";
import { holdSandboxGitWrites } from "../shared/host-git.js";
import { errorMessage } from "../shared/error-message.js";
import { createLogger } from "../lib/logger.js";
import { MxcHolderStartRefusedError, MxcProcessCleanupError } from "./mxc-extension-errors.js";
import type { MxcHolderProcess } from "./holder-admission-darwin.js";
import { buildBubblewrapHolderRequest, linuxHolderPolicyModel, linuxHolderWatchedRoots } from "./mxc-linux.js";
import type { ProvenLinuxHolderRoute } from "./linux-holder-route.js";
import { ContainerPlaceholderChangedError, holdMxcLinuxPlaceholders } from "./mxc-linux-placeholders.js";
import {
  linuxHolderLaunchDigest, startLinuxHolder, translateLinuxHolderRequest, type LinuxHolder,
} from "./mxc-linux-holder-launch.js";
import { gitExclusions, posixPolicyLookups, rankPosixContainerRows, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";
import { requireMxcContainerStartRoot } from "./mxc-runtime-root.js";
import { prepareSandboxBareRepositoryCleanup } from "./sandbox-bare-repository-cleanup.js";
import { restrictSandboxGitControlSnapshot } from "./sandbox-write-policy.js";
import { claimMxcWatchedRows, deferWatchedReceipt, WatchedQuarantineError } from "./windows-watched-rows.js";
import type { PolicyModel } from "./policy-model.js";

const log = createLogger("holder-admission-linux");

/** A holder's rows, captured once per start: the model the launch ranks again under the placeholder lock. */
export interface LinuxHolderRows {
  readonly model: PolicyModel;
  readonly lookups: PosixPolicyLookups;
  readonly gitControlSnapshot: Awaited<ReturnType<typeof linuxHolderPolicyModel>>["mandatory"]["gitControlSnapshot"];
  /** The write roots after the mandatory write policy narrowed them. */
  readonly writeRoots: readonly string[];
}

/**
 * The rows of one holder start from its grants alone (design 6.1). A long-lived holder's write roots outside every
 * Ave-owned root watch their absent protected names instead of holding them with placeholders (design 7.1).
 */
export async function captureLinuxHolderRows(input: {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly floorPierces: readonly string[];
  readonly longLived: boolean;
  readonly route: ProvenLinuxHolderRoute;
  readonly signal?: AbortSignal;
}): Promise<LinuxHolderRows> {
  const base = posixPolicyLookups(getPolicyHome(), false);
  const { model, mandatory } = await linuxHolderPolicyModel({
    allowRead: input.readRoots, allowWrite: input.writeRoots, floorPierces: input.floorPierces, lookups: base,
    programs: input.route.programs, ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const watchedRoots = linuxHolderWatchedRoots(mandatory.allowWrite, input.longLived);
  return Object.freeze({
    model, lookups: { ...base, watchedRoots }, gitControlSnapshot: mandatory.gitControlSnapshot,
    writeRoots: Object.freeze([...mandatory.allowWrite]),
  });
}

/** The rows ranked without the placeholder lock: what admission measures. The launch ranks them again under it. */
export function rankLinuxHolderRows(rows: LinuxHolderRows): PosixFilesystemGrants {
  return rankPosixContainerRows(rows.model, "bubblewrap", rows.lookups);
}

/** The holder's own folder under the runtime root (0700): its request, the launcher's log and its proxy socket. */
export interface LinuxHolderStaging {
  readonly folder: string;
  readonly socketPath: string;
  /** Only after a verified stop: an unverified one keeps the folder. */
  remove(): Promise<void>;
}

export async function createLinuxHolderStaging(): Promise<LinuxHolderStaging> {
  const folder = await mkdtemp(posix.join(requireMxcContainerStartRoot(), "holder-"));
  return Object.freeze({
    folder, socketPath: posix.join(folder, "proxy.sock"),
    remove: () => rm(folder, { recursive: true, force: true }),
  });
}

/** The holder as row 2's callers see it. A signal exit reads as 128 + its number, as a shell reports it. */
export function linuxHolderProcess(holder: LinuxHolder): MxcHolderProcess {
  const completion = holder.process.completion.then(({ code, signal }) => ({
    exitCode: code ?? 128 + (signal === null ? 0 : osConstants.signals[signal] ?? 0),
    timedOut: false,
  }));
  return Object.freeze({
    id: holder.process.pid,
    stdin: holder.process.stdin,
    stdout: holder.process.stdout,
    stderr: holder.process.stderr,
    completion,
    dispose: () => holder.dispose().then(() => undefined),
  });
}

/**
 * Start one admitted holder: hold its placeholders and rank under that lock, build and stage its request, have the
 * pinned launcher translate it, then run the recorded call through the launch gate. Inside the gate, after every
 * check: the watched names are claimed, the placeholders validated and the holder's marker written. At the ready byte
 * the holder gives up the placeholders it held only to mask them. Everything this start holds is released only after
 * a verified stop; a start refused before the holder ran releases it at once.
 */
export async function startLinuxContainerHolder(input: {
  readonly label: string;
  readonly route: ProvenLinuxHolderRoute;
  readonly rows: LinuxHolderRows;
  readonly staging: LinuxHolderStaging;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly proxySocket: string | "offline";
  readonly commandId: string;
  /** Row 2's grant checks (the captured write envelope) on the rows ranked under the lock. */
  readonly assertGrants: (grants: PosixFilesystemGrants) => void;
  /** Row 2's synchronous recheck, the executable identity included. It runs again inside the gate. */
  readonly recheck: () => void;
  readonly signal: AbortSignal;
}): Promise<LinuxHolder> {
  const { route, rows, staging } = input;
  const hold = await holdMxcLinuxPlaceholders(rows.lookups, (lookups) => rankPosixContainerRows(rows.model, "bubblewrap", lookups));
  let claim: ReturnType<typeof claimMxcWatchedRows> | undefined;
  let releaseGit: (() => void) | undefined;
  let cleanupGit: (() => string | undefined) | undefined;
  let released: Promise<void> | undefined;
  // Once, whichever path gets here first: the verified stop, or a start refused before the holder ran.
  const release = (): Promise<void> => released ??= (async () => {
    const failures: unknown[] = [];
    const step = async (work: () => unknown): Promise<void> => {
      try { await work(); } catch (error) { failures.push(error); }
    };
    await step(() => hold.release());
    await step(() => {
      try {
        const notice = cleanupGit?.();
        if (notice !== undefined) deferWatchedReceipt(notice);
      } finally { releaseGit?.(); }
    });
    // Holder release is a detection point; a holder has no command result, so the next command's result carries it.
    await step(async () => {
      try {
        const notice = await claim?.release();
        if (notice !== undefined) deferWatchedReceipt(notice);
      } catch (error) {
        if (!(error instanceof WatchedQuarantineError)) throw error;
        log.warn(errorMessage(error));
        deferWatchedReceipt(error.message);
      }
    });
    if (failures.length > 0) throw new AggregateError(failures, "Linux holder release failed");
  })();
  try {
    input.assertGrants(hold.grants);
    const request = buildBubblewrapHolderRequest({
      grants: hold.grants, lookups: rows.lookups, argv: input.argv, cwd: input.cwd, env: input.env,
      proxySocket: input.proxySocket, helper: route.programs.helper,
    });
    const requestPath = posix.join(staging.folder, "request.json");
    const written = Buffer.from(JSON.stringify(request));
    await writeFile(requestPath, written, { flag: "wx", mode: 0o600 });
    const call = await translateLinuxHolderRequest({
      launcher: route.programs.launcher, env: route.programs.env, captureFolder: route.captureFolder,
      helperSha256: route.helperSha256, bwrap: route.bwrap.path, requestPath, logPath: posix.join(staging.folder, "launcher.log"),
      request, signal: input.signal,
    });
    const requestBytes = await readFile(requestPath);
    // The bytes the launcher read are the ones Ave wrote (review #758 P3-4); the digest below only fixes them from here on.
    if (!requestBytes.equals(written)) throw new MxcHolderStartRefusedError("request-rejected", "the staged request changed before the launcher's call was checked");
    const executable = input.argv[0] as string;
    // What the gate compares: the request as staged, the checked call and the executable, read again at that moment.
    const digest = (): string => linuxHolderLaunchDigest({ request: requestBytes, call, executable });
    const admitted = digest();
    // Git controls as for a shell (design 5.1): snapshot now, host Git reads of the write roots held from the gate's
    // release until the stop is verified and the sweep ran.
    const writeRoots = rows.writeRoots.filter(path => hold.grants.readwrite.includes(rows.lookups.canonical(path)));
    if (rows.gitControlSnapshot !== undefined) {
      cleanupGit = await prepareSandboxBareRepositoryCleanup(writeRoots, basename(staging.folder),
        restrictSandboxGitControlSnapshot(rows.gitControlSnapshot, writeRoots, gitExclusions(hold.grants)));
    }
    claim = hold.grants.watched === undefined ? undefined : claimMxcWatchedRows(hold.grants.watched, { commandId: input.commandId });
    const watched = claim;
    const holder = await startLinuxHolder(call, {
      label: input.label, bwrap: route.bwrap, cwd: request.process.cwd, admittedDigest: admitted, currentDigest: digest,
      online: input.proxySocket !== "offline",
      assertStillValid: () => {
        const check = (): void => {
          input.recheck();
          route.programs.validate();
          hold.validate();
        };
        if (watched === undefined) check();
        else watched.start(check);
      },
      recordHolder: (pid) => hold.recordHolder(pid, route.bwrap.path),
      beforeRelease: async () => {
        if (cleanupGit !== undefined) releaseGit = holdSandboxGitWrites(writeRoots);
      },
      afterVerifiedStop: release,
    });
    // Proved again at the ready byte (design 8.1 R4, review #758 P2-2): a folder replaced between the gate and bwrap's
    // mount would leave the mask on another object for the holder's whole life. The start is stopped and refused by name.
    try {
      hold.validate();
    } catch (error) {
      if (!(error instanceof ContainerPlaceholderChangedError)) throw error;
      await holder.dispose("holder placeholder changed before its ready byte");
      throw new MxcHolderStartRefusedError("integrity", `a placeholder folder changed between the gate and the holder's start: ${error.path}`, { cause: error });
    }
    await hold.releaseForeignClaims();
    return holder;
  } catch (error) {
    // An unverified stop keeps the placeholders, the Git hold and the watched claim.
    if (!(error instanceof MxcProcessCleanupError)) {
      await release().catch((cause: unknown) => { log.warn(`Linux holder release failed: ${errorMessage(cause)}`); });
    }
    throw error;
  }
}

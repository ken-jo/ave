// A macOS holder (MCP server, plugin child, worker, hook, offline host child) runs as one exec chain in one pid, with no
// resident supervisor: the process-group launch gate, then `/usr/bin/sandbox-exec -p <profile>`, then a three-line
// ready shim, then the holder. Its stdio is its own fds 0/1/2 on pipes to Ave. The profile ends with the holder's label
// (`holder-label-sweep.ts`), so its stop can end every process it started, including ones that left its group.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { getDefaultSensitiveWriteDenyEntries, runWithSandboxWritePreflight, seatbeltHolderFloorRows } from "./asrt-sandbox.js";
import { assertConfiguredLauncherEnvironment, buildLauncherEnvironment } from "./launcher-environment.js";
import { atOrUnder, canonicalPath, posixPathFoldsCase, posixPolicyLookups, rankPosixContainerRows, type PosixFilesystemGrants, type PosixPolicyLookups } from "./mxc-posix.js";
import { buildPolicyModel, policyGrantRow, type PolicyFloorRow, type PolicyModel } from "./policy-model.js";
import { buildSeatbeltHolderProfile, splitSeatbeltPolicyRows, type SeatbeltHolderLabels } from "./seatbelt-profile.js";
import { buildSeatbeltSandboxWritePolicy } from "./sandbox-write-policy.js";
import { getPolicyHome } from "../shared/policy-home.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const HOLDER_SHELL = "/bin/sh";
/** The first sandboxed code: one byte on fd 4 proves the profile is applied and the holder is about to be exec'd. */
export const HOLDER_READY_SHIM = 'printf "\\n" >&4 || exit 70; exec 4>&-; exec "$@"';
const PROXY_ENV_KEYS = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"]);
const HOLDER_PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
/** The read every macOS holder starts from: the whole volume, read-only, carved around every read deny (owner O4). */
const HOLDER_READ_BASE = "/";

export class SeatbeltHolderLaunchError extends Error {
  constructor(readonly code: "cwd-ungranted" | "proxy-invalid" | "read-base-supplied" | "command-invalid", message: string) {
    super(message);
    this.name = "SeatbeltHolderLaunchError";
  }
}

/** Where a holder may connect: its invocation's loopback proxy, or nowhere at all. */
export type SeatbeltHolderNetwork = { readonly proxyUrl: string } | "offline";

export interface SeatbeltHolderLaunchInput {
  /** The holder executable, absolute. It is exec'd with `args`; no shell evaluates them. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Exactly the environment the holder receives, before the host's own proxy variables. */
  readonly env: Readonly<Record<string, string>>;
  /** The holder's own reads beyond the read base (its data inside the Ave home, a declared host directory). */
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  /** Reads held inside the protected read floor on purpose; a user's deny over one refuses the start. */
  readonly floorPierces?: readonly string[];
  readonly network: SeatbeltHolderNetwork;
  readonly labels: SeatbeltHolderLabels;
}

/** Everything one holder start runs with, named by one digest. Nothing of it is written to disk. */
export interface SeatbeltHolderLaunch {
  readonly profile: string;
  /** The arguments of `sandbox-exec` (`SANDBOX_EXEC`), which the launch gate execs. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly proxyPort: number | null;
  readonly labels: SeatbeltHolderLabels;
  readonly grants: PosixFilesystemGrants;
  readonly digest: string;
}

/** The floors and write-root protections of one start: captured by the host, never supplied by the caller. */
export interface SeatbeltHolderFloors {
  readonly floors: readonly PolicyFloorRow[];
  /** The write roots as the mandatory write policy narrowed them. */
  readonly allowWrite: readonly string[];
  readonly lookups: PosixPolicyLookups;
}

/** The host's floors for a start with these write roots: `seatbeltHolderFloorRows` plus the write-root protections. */
export async function captureSeatbeltHolderFloors(input: Pick<SeatbeltHolderLaunchInput, "cwd" | "writeRoots">, signal?: AbortSignal): Promise<SeatbeltHolderFloors> {
  const sensitive = getDefaultSensitiveWriteDenyEntries();
  const mandatory = await runWithSandboxWritePreflight(signal, () => buildSeatbeltSandboxWritePolicy(
    [...input.writeRoots], undefined, sensitive.map(entry => typeof entry === "string" ? entry : entry.path)));
  const home = getPolicyHome();
  const lookups = posixPolicyLookups(home, false);
  const foldsCase = [home, input.cwd, ...mandatory.allowWrite].every(path => posixPathFoldsCase(lookups.canonical(path)));
  return {
    floors: Object.freeze([...seatbeltHolderFloorRows(), ...mandatory.literalRows, ...mandatory.patternRows]),
    allowWrite: Object.freeze([...mandatory.allowWrite]),
    lookups: { ...lookups, foldsCase },
  };
}

function proxyPortOf(network: SeatbeltHolderNetwork): number | null {
  if (network === "offline") return null;
  const port = Number(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(network.proxyUrl)?.[1]);
  if (!Number.isInteger(port) || port > 65535) throw new SeatbeltHolderLaunchError("proxy-invalid", "Container proxy must be an IPv4 loopback listener");
  return port;
}

// The launch gate and the ready shim are `/bin/sh`, which on macOS is bash: a startup variable or an exported function
// would run before the sandbox exists, so the configured environment is checked here, where no caller can skip it.
function holderEnvironment(env: Readonly<Record<string, string>>, network: SeatbeltHolderNetwork): Record<string, string> {
  const configured: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (PROXY_ENV_KEYS.has(key.toLowerCase()) || key === "SHLVL") continue;
    configured[key] = value;
  }
  const { PATH: _path, ...checked } = configured;
  assertConfiguredLauncherEnvironment(checked);
  const launcher = buildLauncherEnvironment("darwin");
  const result: Record<string, string> = { ...launcher, ...configured, SHLVL: launcher.SHLVL as string };
  if (network !== "offline") for (const key of HOLDER_PROXY_KEYS) result[key] = network.proxyUrl;
  return result;
}

function launchDigest(launch: Omit<SeatbeltHolderLaunch, "digest" | "grants" | "labels">): string {
  const env = Object.entries(launch.env).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([launch.profile, launch.argv, env, launch.cwd, launch.proxyPort])).digest("hex");
}

/** The digest of a launch record as it is now: the recheck before release compares it with the admitted one. */
export function seatbeltHolderLaunchDigest(launch: SeatbeltHolderLaunch): string {
  return launchDigest(launch);
}

/**
 * A holder's launch from Ave rows. The builder, not the caller, adds the read base, every floor and the label; a caller
 * that supplies the read base is refused, and rows cannot render a label rule. Offline holders get no network rule and
 * no proxy variable.
 */
export function composeSeatbeltHolderLaunch(input: SeatbeltHolderLaunchInput, host: SeatbeltHolderFloors): SeatbeltHolderLaunch {
  const { lookups } = host;
  if (!posix.isAbsolute(input.command) || input.command.includes("\0") || input.args.some(arg => arg.includes("\0"))) {
    throw new SeatbeltHolderLaunchError("command-invalid", "Container holder executable must be an absolute path");
  }
  for (const root of [...input.readRoots, ...input.writeRoots, ...(input.floorPierces ?? [])]) {
    if (canonicalPath(root, true, lookups) === HOLDER_READ_BASE) {
      throw new SeatbeltHolderLaunchError("read-base-supplied", "A holder's read base is added by its launch builder, not by its caller");
    }
  }
  const proxyPort = proxyPortOf(input.network);
  const model: PolicyModel = buildPolicyModel({
    floors: host.floors,
    userGrants: [],
    extensionManifests: [],
    launchGrants: [
      ...host.allowWrite.map(path => policyGrantRow(path, "rw", "launch-grant", false)),
      ...input.readRoots.map(path => policyGrantRow(path, "ro", "launch-grant", false)),
      ...(input.floorPierces ?? []).map(path => policyGrantRow(path, "ro", "floor-pierce", false)),
      policyGrantRow(HOLDER_READ_BASE, "ro", "launch-grant", true),
    ],
  });
  const grants = rankPosixContainerRows(splitSeatbeltPolicyRows(model).literalModel, "seatbelt", lookups);
  const cwd = canonicalPath(input.cwd, true, lookups);
  const coversCwd = (root: string) => atOrUnder(cwd, root, lookups.foldsCase);
  const inChain = grants.chainFolders.some(root => coversCwd(root) && atOrUnder(root, cwd, lookups.foldsCase));
  if (!lookups.exists(cwd) || grants.denied.some(coversCwd)
    || (!inChain && ![...grants.readonly, ...grants.readwrite].some(coversCwd))) {
    throw new SeatbeltHolderLaunchError("cwd-ungranted", `Container holder working directory is outside its filesystem grants: ${cwd}`);
  }
  const profile = buildSeatbeltHolderProfile({ model, grants, lookups, unixSocketRoots: [], proxyPort, labels: input.labels });
  const env = Object.freeze(holderEnvironment(input.env, input.network));
  const argv = Object.freeze(["-p", profile, HOLDER_SHELL, "-c", HOLDER_READY_SHIM, "ave-holder", input.command, ...input.args]);
  const record = { profile, argv, env, cwd, proxyPort };
  return Object.freeze({ ...record, labels: input.labels, grants, digest: launchDigest(record) });
}

/** Capture the host's floors for this start and compose its launch. */
export async function buildSeatbeltHolderLaunch(input: SeatbeltHolderLaunchInput, signal?: AbortSignal): Promise<SeatbeltHolderLaunch> {
  return composeSeatbeltHolderLaunch(input, await captureSeatbeltHolderFloors(input, signal));
}

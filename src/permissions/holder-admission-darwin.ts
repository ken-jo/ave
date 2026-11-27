// The macOS half of row-2 holder admission: path forms, executable identity, environment and the native start, for the
// orchestration in `confined-child.ts`. A macOS holder runs on `sandbox-exec` with Ave's whole profile
// (`seatbelt-holder-launch.ts`); nothing here reaches the old wrap or the MXC SDK.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import { getPolicyHome } from "../shared/policy-home.js";
import { FORWARD_ENV_KEYS, isSandboxWrapperEnvKey } from "../tools/safe-env.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import { atOrUnder, canonicalPath, posixPolicyLookups } from "./mxc-posix.js";
import type { SeatbeltHolder } from "./seatbelt-holder-launch.js";

/** What a caller of row 2 reads and writes on a started holder, on every platform. */
export interface MxcHolderProcess {
  /** The holder's pid on macOS; the native process id on Windows. */
  readonly id: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<{ readonly exitCode: number; readonly timedOut: boolean }>;
  dispose(): Promise<void>;
}

/** Path spellings for the co-holder rules. APFS volumes fold case by default; folding here only refuses more. */
export const posixHolderPaths = Object.freeze({
  normalize: (path: string): string => posix.normalize(path).replace(/(.)\/+$/u, "$1"),
  target: (path: string): string => canonicalPath(path, true, posixPolicyLookups(getPolicyHome(), true)),
  atOrUnder: (path: string, root: string): boolean => atOrUnder(path, root, true),
  strictlyUnder: (path: string, root: string): boolean => atOrUnder(path, root, true) && !atOrUnder(root, path, true),
});

/**
 * The executable's identity, measured at admission and again immediately before the release byte: its canonical path,
 * device, inode, size and times. A symbolic link at the path is followed to its target, whose identity is the one
 * measured; anything but a regular file is refused.
 */
export function measurePosixExecutableIdentity(command: string): string {
  if (!posix.isAbsolute(command)) throw new MxcProcessContractError("Container executable must be an absolute path");
  const target = posixHolderPaths.target(command);
  const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile()) throw new MxcProcessContractError("Container executable is not a regular file");
  return createHash("sha256").update([target, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join("\0")).digest("hex");
}

/**
 * Exactly the environment a macOS holder starts with: the forwarded runtime keys of the secret-stripped base, the host's
 * own variables for this holder kind, then HOME, temp and the working directory, which nothing overrides. The launch
 * builder adds the proxy variables and checks the result before the launch gate's shell can read it.
 */
export function seatbeltHolderEnvironment(input: {
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly holderEnv?: Readonly<Record<string, string>>;
  readonly home: string;
  readonly temp: string;
  readonly cwd: string;
}): Record<string, string> {
  const forwarded = new Set<string>(FORWARD_ENV_KEYS);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.baseEnv)) {
    if (value === undefined || isSandboxWrapperEnvKey(name) || !forwarded.has(name)) continue;
    environment[name] = value;
  }
  if (input.baseEnv.ELECTRON_RUN_AS_NODE === "1") environment.ELECTRON_RUN_AS_NODE = "1";
  for (const [name, value] of Object.entries(input.holderEnv ?? {})) {
    if (typeof value !== "string") throw new MxcProcessContractError("Container holder environment values must be strings");
    if (isSandboxWrapperEnvKey(name)) continue;
    environment[name] = value;
  }
  return { ...environment, HOME: input.home, TMPDIR: input.temp, TEMP: input.temp, TMP: input.temp, PWD: input.cwd };
}

/** The holder as row 2's callers see it. A signal exit reads as 128 + its number, as a shell reports it. */
export function seatbeltHolderProcess(holder: SeatbeltHolder): MxcHolderProcess {
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

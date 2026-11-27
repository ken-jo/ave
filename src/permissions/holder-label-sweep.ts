// The Seatbelt label every macOS holder profile ends with, and the helper that ends every process carrying one
// (`native/macos-holder-sweep/README.md`). A label names one holder start, one app run, or one Ave instance:
//
//   dev.ave.holder.<inst>.<boot>.<holder>   one holder start: what its stop sweeps
//   dev.ave.holder.<inst>.<boot>.all        this app run: what the watcher sweeps when Ave dies
//   dev.ave.holder.<inst>.any               this Ave home: what the boot sweep ends of an earlier run
//
// `<inst>` derives from the canonical Ave home, the key of the host instance lock (`host-instance-lock.ts`), so two
// live hosts never share one. No module of the shell supervisor or the MXC SDK is imported here.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { machoImageDigest } from "../../scripts/lib/macho-image-digest.mjs";
import { createLogger } from "../lib/logger.js";
import { aveHome } from "../shared/ave-home.js";
import { errorMessage } from "../shared/error-message.js";
import { HOLDER_LABEL_PREFIX, type SeatbeltHolderLabels } from "./seatbelt-profile.js";

const log = createLogger("holder-label-sweep");

/** Never allowed by any profile: the sweep's proof that a process is sandboxed at all. */
export const HOLDER_CONTROL_LABEL = "dev.ave.holder.ctl";

const BOOT_PART = `b${randomBytes(8).toString("hex")}`;

/** `i` + 16 hex of the canonical Ave home: one per instance lock. A symlinked spelling of one home is the same instance. */
export function holderInstancePart(home: string = aveHome()): string {
  return `i${createHash("sha256").update(realpathSync.native(home)).digest("hex").slice(0, 16)}`;
}

/** The labels of one new holder start. `<boot>` is fixed for this app run; `<holder>` is fresh each call. */
export function newHolderLabels(home?: string): SeatbeltHolderLabels {
  const instance = holderInstancePart(home);
  return Object.freeze({
    holder: `${HOLDER_LABEL_PREFIX}${instance}.${BOOT_PART}.h${randomBytes(8).toString("hex")}`,
    boot: `${HOLDER_LABEL_PREFIX}${instance}.${BOOT_PART}.all`,
    instance: `${HOLDER_LABEL_PREFIX}${instance}.any`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The helper: one pinned file, re-checked before every run.

// The signing-stable image digest of the helper built with this bundle; packaging requires the shipped helper to match.
declare const __AVE_MACOS_HOLDER_SWEEP_SHA256__: string | null;
// Unbundled source modules under unit tests carry no pin.
const pinned = (): boolean => typeof __AVE_MACOS_HOLDER_SWEEP_SHA256__ !== "undefined";

export class HolderSweepUnavailableError extends Error {
  constructor(readonly reason: "integrity" | "binary-missing", detail: string) {
    super(`Holder label sweep helper unavailable (${reason}): ${detail}`);
    this.name = "HolderSweepUnavailableError";
  }
}

interface FileIdentity {
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** The helper as measured at boot. Every later run compares the file with this record first. */
export interface HolderSweepHelper {
  readonly path: string;
  readonly identity: FileIdentity;
}

function holderSweepHelperPath(resourcePath: string): string {
  return join(resourcePath, "macos-holder-sweep", "arm64", "ave-holder-sweep");
}

function measure(path: string): FileIdentity & { readonly bytes: Buffer } {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new HolderSweepUnavailableError("binary-missing", errorMessage(error));
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HolderSweepUnavailableError("integrity", "not a regular file");
  if ((Number(stat.mode) & 0o022) !== 0) throw new HolderSweepUnavailableError("integrity", "writable by group or others");
  const bytes = readFileSync(path);
  return {
    bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
    dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
  };
}

/** Boot: the helper at its constant path, a plain file nobody else can write, carrying the image this bundle pins. */
export function verifyHolderSweepHelper(resourcePath: string): HolderSweepHelper {
  const path = holderSweepHelperPath(resourcePath);
  const { bytes, ...identity } = measure(path);
  if (pinned()) {
    let digest: string | undefined;
    try { digest = machoImageDigest(bytes); } catch { digest = undefined; }
    if (digest === undefined || digest !== __AVE_MACOS_HOLDER_SWEEP_SHA256__) {
      throw new HolderSweepUnavailableError("integrity", "the helper is not the one this build of Ave pins");
    }
  }
  return Object.freeze({ path, identity: Object.freeze(identity) });
}

/** Every run: the file is still the one measured at boot, byte for byte and by identity. */
export function assertHolderSweepHelperUnchanged(helper: HolderSweepHelper): void {
  const { bytes: _bytes, ...now } = measure(helper.path);
  const was = helper.identity;
  if (now.sha256 !== was.sha256 || now.dev !== was.dev || now.ino !== was.ino || now.size !== was.size
    || now.mtimeNs !== was.mtimeNs || now.ctimeNs !== was.ctimeNs) {
    throw new HolderSweepUnavailableError("integrity", "the helper changed since boot");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One run of the helper, and what its exit means.

export type HolderSweepOutcome =
  | { readonly verified: true; readonly signalled: number }
  | { readonly verified: false; readonly reason: string };

const SWEEP_RESULT = /^result (clean|unclean|refused|failed) signalled=(\d+)$/u;
const PROVE_RESULT = /^result (proven|unproven)(?: |$)/u;
const SWEEP_EXIT: Readonly<Record<string, number>> = { clean: 0, unclean: 3, refused: 4, failed: 70 };
const OUTPUT_LIMIT = 64 * 1024;

/**
 * Run the helper once. `verified` only for exit 0 with a last line that says the same thing; any other exit, a last line
 * that disagrees, a timeout, a signal, a spawn failure or a changed helper is unverified, with the reason.
 */
export async function runHolderSweep(helper: HolderSweepHelper, mode: "sweep" | "prove", label: string, timeoutMs: number): Promise<HolderSweepOutcome> {
  try {
    assertHolderSweepHelperUnchanged(helper);
  } catch (error) {
    return { verified: false, reason: errorMessage(error) };
  }
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (outcome: HolderSweepOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helper.path, [mode, label, HOLDER_CONTROL_LABEL], { env: {}, stdio: ["ignore", "pipe", "ignore"], shell: false });
    } catch (error) {
      finish({ verified: false, reason: `the helper did not start: ${errorMessage(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ verified: false, reason: `the helper did not finish within ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (output.length < OUTPUT_LIMIT) output += chunk;
    });
    child.once("error", (error) => finish({ verified: false, reason: `the helper did not start: ${errorMessage(error)}` }));
    child.once("close", (code, signal) => {
      const last = output.trimEnd().split("\n").at(-1) ?? "";
      if (signal !== null) return finish({ verified: false, reason: `the helper ended by ${signal}` });
      if (code === 64) {
        log.error({ mode, label }, "holder sweep helper refused its arguments");
        return finish({ verified: false, reason: "the helper refused its arguments (64)" });
      }
      if (mode === "prove") {
        const proven = PROVE_RESULT.exec(last)?.[1];
        if (code !== 0 || proven !== "proven") return finish({ verified: false, reason: `the helper's proof failed (exit ${code}: ${last})` });
        return finish({ verified: true, signalled: 0 });
      }
      const match = SWEEP_RESULT.exec(last);
      if (!match || SWEEP_EXIT[match[1] as string] !== code) return finish({ verified: false, reason: `the helper's last line and exit code disagree (exit ${code}: ${last})` });
      if (code !== 0) return finish({ verified: false, reason: `the sweep was ${match[1]} (exit ${code})` });
      finish({ verified: true, signalled: Number(match[2]) });
    });
  });
}

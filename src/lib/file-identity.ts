import { type BigIntStats, chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

function hasExactIdentity(identity: FileIdentity): boolean {
  return typeof identity.dev === "bigint" && typeof identity.ino === "bigint";
}

/** Use bigint stats; numeric file identifiers may have already lost identity bits. */
export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return hasExactIdentity(left) && hasExactIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

export function fileIdentityKey(identity: FileIdentity): string {
  if (!hasExactIdentity(identity)) throw new TypeError("File identity requires bigint identifiers");
  return `${identity.dev}:${identity.ino}`;
}

type BirthStats = Pick<BigIntStats, "birthtimeNs" | "ctimeNs">;

/**
 * Whether this host's birth times are real. Where statx is unavailable (a kernel before 4.11, or a seccomp profile
 * that refuses it) libuv reports the change time as the birth time, and a folder's change time moves whenever an entry
 * is added, so a recorded "birth" would refuse every healthy launch. Probed once: a file whose change time was moved
 * must keep its birth time. `stat` and `touch` are the probe's own file operations, replaceable by a unit test.
 */
export function probeBirthTimes(stat: () => BirthStats, touch: () => void, wait: (ms: number) => void): boolean {
  const before = stat();
  if (before.birthtimeNs === 0n) return false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // A coarse clock can give the change the creation's tick; wait a tick and look again.
    wait(10);
    touch();
    const after = stat();
    if (after.ctimeNs !== before.ctimeNs) return after.birthtimeNs === before.birthtimeNs;
  }
  // The change time never moved: nothing shows the birth time is its own, so it is not used.
  return false;
}

let birthTimesReal: boolean | undefined;

function probeHostBirthTimes(): boolean {
  const folder = mkdtempSync(join(tmpdir(), "ave-birth-probe-"));
  try {
    const file = join(folder, "probe");
    writeFileSync(file, "", { mode: 0o600 });
    let mode = 0o600;
    return probeBirthTimes(() => lstatSync(file, { bigint: true }), () => { mode = mode === 0o600 ? 0o400 : 0o600; chmodSync(file, mode); },
      (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * A Linux folder's birth time for its identity, or undefined where the filesystem reports none or the host's birth
 * times are its change times (the stated residual: device and inode alone, so a folder made again at a reused inode
 * number is not seen there).
 */
export function reportedBirthTimeNs(entry: BirthStats): bigint | undefined {
  if (entry.birthtimeNs === 0n) return undefined;
  birthTimesReal ??= probeHostBirthTimes();
  return birthTimesReal ? entry.birthtimeNs : undefined;
}

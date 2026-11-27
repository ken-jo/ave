// The Seatbelt label every macOS holder profile ends with, and the helper that ends every process carrying one
// (`native/macos-holder-sweep/README.md`). A label names one holder start, one app run, or one Ave instance:
//
//   dev.ave.holder.<inst>.<boot>.<holder>   one holder start: what its stop sweeps
//   dev.ave.holder.<inst>.<boot>.all        this app run: what the watcher sweeps when Ave dies
//   dev.ave.holder.<inst>.any               this Ave home: what the boot sweep ends of an earlier run
//
// `<inst>` derives from the canonical Ave home, the key of the host instance lock (`host-instance-lock.ts`), so two
// live hosts never share one. No module of the shell supervisor or the MXC SDK is imported here.
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { aveHome } from "../shared/ave-home.js";
import type { SeatbeltHolderLabels } from "./seatbelt-profile.js";

export const HOLDER_LABEL_PREFIX = "dev.ave.holder.";
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

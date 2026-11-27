import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import type { WindowsDirectoryHandleSource } from "../shared/windows-path-facts.js";

export interface MxcReleaseProof { readonly path: string; readonly digest: string }
const digest = (contents: string): string => createHash("sha256").update(contents).digest("hex");

function filesystemIdentity(paths: readonly string[]): string {
  const measured = new Set<string>();
  const hash = createHash("sha256");
  for (const requested of paths) {
    for (let path = normalize(requested); !measured.has(path); path = dirname(path)) {
      measured.add(path);
      const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      const identity = entry === undefined ? null : [String(entry.dev), String(entry.ino), entry.isDirectory(), entry.isSymbolicLink(),
        realpathSync.native(path), ...(entry.isDirectory() ? [] : [String(entry.size), String(entry.ctimeNs), String(entry.mtimeNs)])];
      hash.update(JSON.stringify([path, identity]));
    }
  }
  return hash.digest("hex");
}

/** A one-use marker in the already-proved host-only runtime root. */
export function createMxcReleaseGate(root: string, paths?: readonly string[], cwdHold?: WindowsDirectoryHandleSource): MxcReleaseProof & { revoke(): void } {
  const path = join(root, `release-${randomUUID()}`);
  const pinnedPaths = paths && [...new Set([root, ...paths])];
  const contents = pinnedPaths === undefined ? "" : JSON.stringify({ paths: pinnedPaths, identity: filesystemIdentity(pinnedPaths),
    deadline: Date.now() + TOOL_TIMEOUT_POLICY.mxcExtensionReadinessMs, cwdHold });
  writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  return { path, digest: digest(contents), revoke() {
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } };
}

/** Read again after measuring the filesystem so a concurrent authority withdrawal wins. */
export function assertMxcReleaseGate(proof: MxcReleaseProof): WindowsDirectoryHandleSource | undefined {
  const refuse = (): never => { throw new MxcProcessContractError("Extension authorization expired before native creation"); };
  try {
    const contents = readFileSync(proof.path, "utf8");
    if (digest(contents) !== proof.digest) refuse();
    const receipt = JSON.parse(contents) as { paths: string[]; identity: string; deadline: number; cwdHold?: WindowsDirectoryHandleSource };
    if (Date.now() >= receipt.deadline || filesystemIdentity(receipt.paths) !== receipt.identity
      || readFileSync(proof.path, "utf8") !== contents || Date.now() >= receipt.deadline) refuse();
    return receipt.cwdHold;
  } catch { refuse(); }
}

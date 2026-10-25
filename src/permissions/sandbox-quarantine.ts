import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { t } from "../i18n/index.js";
import { replaceStagedFile } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { openFeatureNamespace } from "../main/storage/feature-namespace.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("sandbox-quarantine");
const namespace = openFeatureNamespace("sandbox-quarantine");

interface SandboxQuarantineMove {
  readonly original: string;
  readonly quarantined: string;
}

export interface SandboxQuarantine {
  readonly moved: readonly SandboxQuarantineMove[];
  move(path: string, expectedParent?: { readonly dev: number | bigint; readonly ino: number | bigint }): void;
  notice(): string | undefined;
}

/** The policy denies this host-owned namespace even inside a writable root. */
export function sandboxQuarantineRoot(): string {
  return namespace.dir;
}

function entryAt(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** True only when the path, or a missing ancestor, no longer exists at all. */
function vanished(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

function sameEntry(path: string, identity: NonNullable<ReturnType<typeof lstatSync>>): boolean {
  const current = entryAt(path);
  return current?.dev === identity.dev && current.ino === identity.ino;
}

/** Quarantine retains the original inode and never copies or deletes an entry. */
export async function createSandboxQuarantine(commandId: string): Promise<SandboxQuarantine> {
  const existing = entryAt(namespace.dir);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("Sandbox quarantine namespace must be a directory, not a link");
  }
  const digest = createHash("sha256").update(commandId).digest("hex").slice(0, 12);
  const slotName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${digest}-${randomUUID()}`;
  const slot = await namespace.childDir(slotName, { exclusive: true });
  const logicalNamespaceIdentity = lstatSync(namespace.dir);
  if (!logicalNamespaceIdentity.isDirectory() || logicalNamespaceIdentity.isSymbolicLink()) {
    throw new Error("Sandbox quarantine namespace identity changed");
  }
  const physicalNamespace = realpathSync.native(namespace.dir);
  const physicalSlot = join(physicalNamespace, slotName);
  const namespaceIdentity = lstatSync(physicalNamespace);
  const slotIdentity = lstatSync(slot);
  if (!slotIdentity.isDirectory() || slotIdentity.isSymbolicLink() || realpathSync.native(slot) !== physicalSlot) {
    throw new Error("Sandbox quarantine slot identity changed");
  }
  const moved: SandboxQuarantineMove[] = [];
  const movesText = (): string => moved.map(({ original, quarantined }) =>
    `${JSON.stringify(original)} -> ${JSON.stringify(quarantined)}`).join("\n");
  const notice = (): string | undefined => moved.length
    ? t("sandboxPolicy.quarantined", { moves: movesText() }) : undefined;
  return {
    moved,
    notice,
    move(path, expectedParent): void {
      const original = resolve(path);
      let sourceDirectory: number | undefined;
      let targetDirectory: number | undefined;
      try {
        const parent = dirname(original);
        const parentIdentity = lstatSync(parent);
        if ((expectedParent && (parentIdentity.dev !== expectedParent.dev || parentIdentity.ino !== expectedParent.ino))
          || !parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()
          || realpathSync.native(parent) !== parent
          || !sameEntry(physicalNamespace, namespaceIdentity)
          || !sameEntry(namespace.dir, logicalNamespaceIdentity)
          || !sameEntry(physicalSlot, slotIdentity)
          || realpathSync.native(namespace.dir) !== physicalNamespace
          || realpathSync.native(physicalSlot) !== physicalSlot) {
          throw new Error("Sandbox quarantine directory identity changed");
        }
        const quarantined = join(physicalSlot, `${moved.length + 1}-${basename(original)}`);
        let sourceEntry = original;
        let targetEntry = quarantined;
        if (process.platform === "linux") {
          const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
          sourceDirectory = openSync(parent, flags);
          targetDirectory = openSync(physicalSlot, flags);
          const sourceIdentity = fstatSync(sourceDirectory);
          const targetIdentity = fstatSync(targetDirectory);
          if (sourceIdentity.dev !== parentIdentity.dev || sourceIdentity.ino !== parentIdentity.ino
            || targetIdentity.dev !== slotIdentity.dev || targetIdentity.ino !== slotIdentity.ino) {
            throw new Error("Sandbox quarantine directory identity changed");
          }
          // Resolve only the final entry names through pinned directory handles.
          // A concurrent parent-path replacement cannot redirect either rename.
          sourceEntry = `/proc/self/fd/${sourceDirectory}/${basename(original)}`;
          targetEntry = `/proc/self/fd/${targetDirectory}/${basename(quarantined)}`;
        }
        const identity = lstatSync(sourceEntry);
        if (entryAt(targetEntry)) throw new Error("Sandbox quarantine destination already exists");
        replaceStagedFile(sourceEntry, targetEntry);
        // Record immediately: even a later identity failure must expose the
        // restore location of every entry whose atomic rename already landed.
        moved.push({ original, quarantined });
        if (!sameEntry(parent, parentIdentity) || !sameEntry(targetEntry, identity)) {
          throw new Error("Sandbox quarantine entry identity changed");
        }
        log.warn(`Quarantined protected Git entry: ${JSON.stringify(original)} -> ${JSON.stringify(quarantined)}`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A concurrent writer in a shared root (another process's repository
        // in TMPDIR) may remove the entry, or its parent, before the sweep
        // reaches it. Nothing remains to contain; any other failure, a
        // replaced parent included, still fails the cleanup.
        if (code === "ENOENT" && vanished(original)) {
          log.warn(`Protected Git entry disappeared before quarantine: ${JSON.stringify(original)}`);
          return;
        }
        const reason = errorMessage(error);
        const failure = t("sandboxPolicy.quarantineFailed", {
          path: JSON.stringify(original), reason: code ? `${code}: ${reason}` : reason, moves: notice() ?? "",
        });
        log.warn(failure);
        throw new Error(failure, { cause: error });
      } finally {
        try {
          if (targetDirectory !== undefined) closeSync(targetDirectory);
        } finally {
          if (sourceDirectory !== undefined) closeSync(sourceDirectory);
        }
      }
    },
  };
}

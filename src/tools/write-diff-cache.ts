// Persist the line diff of each file-tool write under the feature namespace with 0o700 directories and 0o600 files.
// The chat card reads it back, so a write, an edit and a patch are all rendered from one host-computed diff.
// Session-end and boot-age cleanup remove cached sidecars.

import { mkdir, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { createLogger } from "../lib/logger.js";
import { isRecord } from "../shared/is-record.js";
import { buildFileDiffView, WRITE_DIFF_RECORD_VERSION, type FileDiffView, type WriteDiffRecord } from "../shared/line-diff.js";

const log = createLogger("write-diff-cache");

// IDs may contain alphanumerics, hyphens, and underscores, never path separators.
export function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function diffCacheRoot(): string {
  return join(aveHome(), "diff-cache");
}

function sessionDir(sessionId: string): string {
  return join(diffCacheRoot(), sessionId);
}

function sidecarPath(sessionId: string, toolUseId: string): string {
  return join(sessionDir(sessionId), `${toolUseId}.json`);
}

/**
 * Store the diff of one write. `before` is null when the file did not exist.
 * Returns whether a card can load it; a failed store is logged and the card falls back to the tool input.
 */
export async function writeDiffSidecar(
  sessionId: string,
  toolUseId: string,
  before: string | null,
  after: string,
  auditWarn: (msg: string) => void,
): Promise<boolean> {
  if (!isSafeId(sessionId) || !isSafeId(toolUseId)) {
    auditWarn(`write-diff-cache: unsafe id rejected sessionId=${sessionId} toolUseId=${toolUseId}`);
    return false;
  }

  const dir = sessionDir(sessionId);
  const path = sidecarPath(sessionId, toolUseId);
  const record: WriteDiffRecord = {
    version: WRITE_DIFF_RECORD_VERSION,
    isNewFile: before === null,
    view: buildFileDiffView(before ?? "", after),
  };

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (err) {
    auditWarn(
      `write-diff-cache: sidecar write failed path=${path} err=${(err as Error).message}`,
    );
    return false;
  }
}

function isFileDiffView(value: unknown): value is FileDiffView {
  if (!isRecord(value) || !Array.isArray(value.hunks)) return false;
  if (typeof value.added !== "number" || typeof value.removed !== "number" || typeof value.truncated !== "boolean") return false;
  return value.hunks.every(hunk => isRecord(hunk)
    && typeof hunk.oldStart === "number" && typeof hunk.newStart === "number"
    && typeof hunk.oldCount === "number" && typeof hunk.newCount === "number"
    && Array.isArray(hunk.rows)
    && hunk.rows.every(row => isRecord(row) && typeof row.text === "string"
      && (row.kind === "context" || row.kind === "added" || row.kind === "removed")));
}

// Missing, unreadable, or differently-shaped sidecars return null; the card then shows what the tool input alone supports.
export async function readDiffSidecar(
  sessionId: string,
  toolUseId: string,
): Promise<WriteDiffRecord | null> {
  if (!isSafeId(sessionId) || !isSafeId(toolUseId)) {
    return null;
  }
  const path = sidecarPath(sessionId, toolUseId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isRecord(parsed) && parsed.version === WRITE_DIFF_RECORD_VERSION
      && typeof parsed.isNewFile === "boolean" && isFileDiffView(parsed.view)) {
      return { version: WRITE_DIFF_RECORD_VERSION, isNewFile: parsed.isNewFile, view: parsed.view };
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearSessionDiffCache(sessionId: string): Promise<void> {
  if (!isSafeId(sessionId)) return;
  const dir = sessionDir(sessionId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn("write-diff-cache: clear session failed dir=%s err=%s", dir, (err as Error).message);
  }
}

// Boot-time age cleanup logs failure without throwing.
export async function purgeStaleSessionDiffDirs(maxAgeMs: number): Promise<{
  swept: string[];
  failed: string[];
}> {
  const root = diffCacheRoot();
  const swept: string[] = [];
  const failed: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { swept, failed };
  }

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (entry) => {
      const dir = join(root, entry);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) return;
        if (s.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
          swept.push(dir);
        }
      } catch (err) {
        log.warn(
          "write-diff-cache: purge entry failed dir=%s err=%s",
          dir,
          (err as Error).message,
        );
        failed.push(dir);
      }
    }),
  );

  return { swept, failed };
}

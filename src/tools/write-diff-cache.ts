// Persist oversized before/after diffs under the feature namespace with 0o700 directories and 0o600 files.
// Session-end and boot-age cleanup remove cached sidecars.

import { mkdir, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("write-diff-cache");

// Keep the sidecar threshold aligned with the renderer preview limit.
export const WRITE_DIFF_PREVIEW_LIMIT = 4096;

export interface WriteDiffBlob {
  before: string;
  after: string;
}

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

// Write when either side exceeds the preview limit; log failure and retain visible truncation state.
export async function writeDiffSidecar(
  sessionId: string,
  toolUseId: string,
  before: string,
  after: string,
  auditWarn: (msg: string) => void,
): Promise<boolean> {
  const beforeBytes = Buffer.byteLength(before, "utf8");
  const afterBytes = Buffer.byteLength(after, "utf8");
  if (beforeBytes <= WRITE_DIFF_PREVIEW_LIMIT && afterBytes <= WRITE_DIFF_PREVIEW_LIMIT) {
    return false;
  }

  if (!isSafeId(sessionId) || !isSafeId(toolUseId)) {
    auditWarn(`write-diff-cache: unsafe id rejected sessionId=${sessionId} toolUseId=${toolUseId}`);
    return false;
  }

  const dir = sessionDir(sessionId);
  const path = sidecarPath(sessionId, toolUseId);
  const blob: WriteDiffBlob = { before, after };

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(blob), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (err) {
    auditWarn(
      `write-diff-cache: sidecar write failed path=${path} err=${(err as Error).message}`,
    );
    return false;
  }
}

// Missing, invalid, or unreadable sidecars return null while callers retain truncation state.
export async function readDiffSidecar(
  sessionId: string,
  toolUseId: string,
): Promise<WriteDiffBlob | null> {
  if (!isSafeId(sessionId) || !isSafeId(toolUseId)) {
    return null;
  }
  const path = sidecarPath(sessionId, toolUseId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).before === "string" &&
      typeof (parsed as Record<string, unknown>).after === "string"
    ) {
      return parsed as WriteDiffBlob;
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

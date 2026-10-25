/** Local-only rollout UUID; invalid UUIDs are replaced, but other read errors propagate. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type InstallationIdLoad = { id: string; created: false } | { id: string; created: true; replacedInvalid: boolean };

const pending = new Map<string, Promise<InstallationIdLoad>>();

async function load(filePath: string): Promise<InstallationIdLoad> {
  let replacedInvalid = false;
  try {
    const text = (await readFile(filePath, "utf8")).trim();
    if (UUID_RE.test(text)) return { id: text, created: false };
    replacedInvalid = true;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const id = randomUUID();
  await writeFileAtomicAtPath(filePath, `${id}\n`);
  return { id, created: true, replacedInvalid };
}

export function loadInstallationId(filePath: string): Promise<InstallationIdLoad> {
  const existing = pending.get(filePath);
  if (existing) return existing;
  const run = load(filePath).finally(() => pending.delete(filePath));
  pending.set(filePath, run);
  return run;
}

/**
 * `~/.ave/installation-id` (design §2): a random UUID that places this
 * installation in rollout buckets (§6.1 step 5). It never leaves the machine.
 *
 * The id carries no authority, so a file that is not a UUID is replaced with
 * a new one: the installation then falls into fresh buckets, exactly as a new
 * installation would. Any other read failure is thrown.
 */
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

/** Read the id, creating it on first use. Concurrent callers share one read. */
export function loadInstallationId(filePath: string): Promise<InstallationIdLoad> {
  const existing = pending.get(filePath);
  if (existing) return existing;
  const run = load(filePath).finally(() => pending.delete(filePath));
  pending.set(filePath, run);
  return run;
}

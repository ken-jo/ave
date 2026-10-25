// Persist observed auth partitions so uninstall can clear names created in prior sessions; serialize writes and deletes together. Corrupt data throws;
// empty files count as absent because Windows confinement may create deny-target placeholders.
import { readdir, readFile, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { writeFileAtomicAtPath } from "./storage/feature-namespace.js";
import { isMissingPathError } from "../lib/atomic-file.js";

// Shape written to disk.
interface PartitionsFile {
  partitions: Record<string, string[]>;
}

function filePath(): string {
  return resolve(aveHome(), "plugins", "auth-partitions.json");
}

function isPartitionsFile(value: unknown): value is PartitionsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (!obj.partitions || typeof obj.partitions !== "object" || Array.isArray(obj.partitions))
    return false;
  for (const [k, v] of Object.entries(obj.partitions as Record<string, unknown>)) {
    if (typeof k !== "string") return false;
    if (
      !Array.isArray(v) ||
      (v as unknown[]).some((item) => typeof item !== "string")
    )
      return false;
  }
  return true;
}

// The sandbox's empty deny placeholder (see the header): no data yet.
function isPlaceholder(raw: string): boolean {
  return raw.trim() === "";
}

// Serialize writes and deletes together so stale snapshots cannot race uninstall deletion or overwrite unrelated plugins.

// Serial promise chain; never rejects (errors propagate via the returned promise).
let _mutationChain: Promise<void> = Promise.resolve();

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
  const result = _mutationChain.then(operation);
  _mutationChain = result.catch(() => undefined);
  return result;
}

// Deep-clone a partition map into a plain PartitionsFile object.
function snapshotMap(partitions: ReadonlyMap<string, ReadonlySet<string>>): PartitionsFile {
  const data: PartitionsFile = { partitions: {} };
  for (const [pluginId, set] of partitions) {
    data.partitions[pluginId] = [...set].sort();
  }
  return data;
}

// Use shared atomic writes with random exclusive staging, private modes, and fsync before the mutation promise settles.
async function doActualWrite(snapshot: PartitionsFile): Promise<void> {
  await writeFileAtomicAtPath(filePath(), `${JSON.stringify(snapshot, null, 2)}\n`);
}

// For test isolation only — resets module-level write queue state. @internal
export function __resetWriteQueueForTest(): void {
  _mutationChain = Promise.resolve();
}

// Missing files return null; corrupt or unexpected data throws so partition history cannot disappear silently.
export async function readPersistedPluginAuthPartitions(): Promise<
  Record<string, string[]> | null
> {
  const path = filePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw new Error(
      `plugin-auth-partition-store: failed to read ${path}: ${(err as Error).message}`,
    );
  }
  if (isPlaceholder(raw)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `plugin-auth-partition-store: corrupt JSON in ${path}: ${(err as Error).message}`,
    );
  }

  if (!isPartitionsFile(parsed)) {
    throw new Error(
      `plugin-auth-partition-store: unexpected schema in ${path} — expected { partitions: Record<string, string[]> }`,
    );
  }

  return parsed.partitions;
}

// Atomically persist the current in-memory partition map to disk. The map is deep-cloned synchronously before this function returns, then its exact
// snapshot is written in serial order with deletes.
export function writePersistedPluginAuthPartitions(
  partitions: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void> {
  const snapshot = snapshotMap(partitions);
  return enqueueMutation(() => doActualWrite(snapshot));
}

// Purge persisted auth after in-memory uninstall cleanup; a missing file is already clean.
export async function deletePersistedPluginAuthPartitions(pluginId: string): Promise<void> {
  return enqueueMutation(async () => {
    const path = filePath();
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (isMissingPathError(err)) return;
      throw new Error(
        `plugin-auth-partition-store: failed to read ${path} for deletion: ${(err as Error).message}`,
      );
    }
    if (isPlaceholder(raw)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `plugin-auth-partition-store: corrupt JSON in ${path} during deletion: ${(err as Error).message}`,
      );
    }

    if (!isPartitionsFile(parsed)) {
      throw new Error(
        `plugin-auth-partition-store: unexpected schema in ${path} during deletion`,
      );
    }
    if (!(pluginId in parsed.partitions)) return;
    delete parsed.partitions[pluginId];
    await doActualWrite(parsed);
  });
}

// Clean up any stale `.tmp` files left by a previous crash mid-write. Call once at startup, before the first read.
export async function cleanupStaleTmpFiles(): Promise<void> {
  const path = filePath();
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
        .map((entry) =>
          unlink(resolve(dir, entry)).catch(() => {
            // best-effort
          }),
        ),
    );
  } catch {
    // readdir throws if dir absent — safe to ignore on first boot
  }
}

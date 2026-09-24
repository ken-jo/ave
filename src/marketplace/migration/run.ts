/**
 * When the first-boot migration (design §16.3) runs, and that it runs once.
 *
 * It needs the official snapshot — which plugins the official source lists,
 * and the pins of their versions — so it waits for the first sync that reads
 * one; until then nothing changes. Once every entry has been read it writes
 * `packages/legacy-migration.json`, and later boots skip it. An entry that
 * could not be read leaves the marker unwritten, so the next boot tries again;
 * entries already migrated are skipped by the migration itself.
 */
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import type { SourceSnapshot } from "../sources/snapshot.js";
import type { LegacyPluginReport, OfficialPlugin } from "./legacy-plugins.js";

interface MarkerFile {
  version: 1;
  completedAt: string;
}

async function completed(path: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  const value = parseStrictJson(text) as Partial<MarkerFile> | null;
  if (typeof value !== "object" || value === null || value.version !== 1 || typeof value.completedAt !== "string") {
    throw new Error(`${path}: not a migration marker`);
  }
  return true;
}

/** The official snapshot's plugins, as the plugin migration reads them. */
export function officialPluginsFrom(snapshot: SourceSnapshot): (name: string) => OfficialPlugin | null {
  return (name) => {
    const found = snapshot.packages.find((item) => item.kind === "plugin" && item.name === name);
    if (!found) return null;
    return {
      snapshotCommit: snapshot.commit,
      packagePath: found.path,
      pins: (version) => {
        const artifact = found.versions.find((item) => item.version === version)?.artifact;
        return [artifact?.release?.sha256, artifact?.archive?.sha256]
          .filter((pin): pin is string => typeof pin === "string")
          .map((pin) => pin.toLowerCase());
      },
    };
  };
}

export interface LegacyMigrationInput {
  markerPath: string;
  /** The official snapshot, or null before the first sync that read one. */
  officialSnapshot: SourceSnapshot | null;
  plugins(officialPlugin: (name: string) => OfficialPlugin | null): Promise<LegacyPluginReport>;
  now: () => Date;
}

/** Run the migration if it is due; null when it already ran or cannot run yet. */
export async function runLegacyMigration(input: LegacyMigrationInput): Promise<LegacyPluginReport | null> {
  if (await completed(input.markerPath)) return null;
  if (!input.officialSnapshot) return null;
  const report = await input.plugins(officialPluginsFrom(input.officialSnapshot));
  if (report.failed.length === 0) {
    const marker: MarkerFile = { version: 1, completedAt: input.now().toISOString() };
    await writeFileAtomicAtPath(input.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }
  return report;
}

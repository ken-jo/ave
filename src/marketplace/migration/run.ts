/**
 * When the first-boot migration (design §16.3) runs, and that it runs once.
 *
 * It needs the official snapshot — which packages the official source lists,
 * and the pins of plugin versions — so it waits for the first sync that reads
 * one; until then nothing changes. Plugins are bound first, then content is
 * adopted. Once both finish without a failure it marks
 * `packages/legacy-migration.json` complete, and later boots skip it. A
 * plugin entry that could not be read or a content install that failed
 * leaves it incomplete, so the next boot tries again; what was already
 * migrated is skipped by each half itself. An unlisted plugin stays unbound,
 * so the plugin half names it on every run: the marker keeps the ones
 * already reported, and a retry names only new ones.
 */
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { pinnedArtifactSha256s, type SourceSnapshot } from "../sources/snapshot.js";
import type { LegacyContentKind, LegacyContentReport } from "./legacy-content.js";
import type { LegacyPluginReport, OfficialPlugin } from "./legacy-plugins.js";

interface MarkerFile {
  version: 1;
  /** Both halves finished without a failure; later boots skip the migration. */
  completedAt?: string;
  /** Plugins already named as no longer managed by an incomplete run. */
  reportedUnmanaged?: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function readMarker(path: string): Promise<MarkerFile | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  const value = parseStrictJson(text) as Partial<MarkerFile> | null;
  if (
    typeof value !== "object" ||
    value === null ||
    value.version !== 1 ||
    (value.completedAt === undefined ? !isStringArray(value.reportedUnmanaged) : typeof value.completedAt !== "string")
  ) {
    throw new Error(`${path}: not a migration marker`);
  }
  return value as MarkerFile;
}

/** The official snapshot's plugins, as the plugin migration reads them. */
export function officialPluginsFrom(snapshot: SourceSnapshot): (name: string) => OfficialPlugin | null {
  return (name) => {
    const found = snapshot.packages.find((item) => item.kind === "plugin" && item.name === name);
    if (!found) return null;
    return {
      snapshotCommit: snapshot.commit,
      packagePath: found.path,
      pins: (version) => pinnedArtifactSha256s(snapshot, name, version),
    };
  };
}

export interface LegacyMigrationInput {
  markerPath: string;
  /** The official snapshot, or null before the first sync that read one. */
  officialSnapshot: SourceSnapshot | null;
  plugins(officialPlugin: (name: string) => OfficialPlugin | null): Promise<LegacyPluginReport>;
  content(listed: (kind: LegacyContentKind, name: string) => boolean): Promise<LegacyContentReport>;
  now: () => Date;
}

export interface LegacyMigrationReport {
  plugins: LegacyPluginReport;
  content: LegacyContentReport;
}

/** Run the migration if it is due; null when it already ran or cannot run yet. */
export async function runLegacyMigration(input: LegacyMigrationInput): Promise<LegacyMigrationReport | null> {
  const previous = await readMarker(input.markerPath);
  if (previous?.completedAt !== undefined) return null;
  const snapshot = input.officialSnapshot;
  if (!snapshot) return null;
  const migrated = await input.plugins(officialPluginsFrom(snapshot));
  const reported = new Set(previous?.reportedUnmanaged ?? []);
  const plugins = { ...migrated, unmanaged: migrated.unmanaged.filter((id) => !reported.has(id)) };
  const content = await input.content((kind, name) => snapshot.packages.some((item) => item.kind === kind && item.name === name));
  const marker: MarkerFile =
    plugins.failed.length === 0 && content.failed.length === 0
      ? { version: 1, completedAt: input.now().toISOString() }
      : { version: 1, reportedUnmanaged: [...new Set([...reported, ...migrated.unmanaged])].sort() };
  await writeFileAtomicAtPath(input.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return { plugins, content };
}

/** Wait for an official snapshot, migrate plugins before content, and mark complete only after both succeed.
 * Retries skip migrated entries and suppress notices already reported. */
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { pinnedArtifactSha256s, type SourceSnapshot } from "../sources/snapshot.js";
import type { LegacyContentKind, LegacyContentReport } from "./legacy-content.js";
import type { LegacyPluginReport, OfficialPlugin } from "./legacy-plugins.js";

interface MarkerFile {
  version: 1;
  completedAt?: string;
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
  officialSnapshot: SourceSnapshot | null;
  plugins(officialPlugin: (name: string) => OfficialPlugin | null): Promise<LegacyPluginReport>;
  content(listed: (kind: LegacyContentKind, name: string) => boolean): Promise<LegacyContentReport>;
  now: () => Date;
}

export interface LegacyMigrationReport {
  plugins: LegacyPluginReport;
  content: LegacyContentReport;
}

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

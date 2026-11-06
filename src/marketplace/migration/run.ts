/** Wait for an official snapshot, adopt content, and mark complete only after it succeeds.
 * Failed content adoption is retried. */
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import type { SourceSnapshot } from "../sources/snapshot.js";
import type { LegacyContentKind, LegacyContentReport } from "./legacy-content.js";

interface MarkerFile {
  version: 1;
  completedAt?: string;
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
    (value.completedAt !== undefined && typeof value.completedAt !== "string")
  ) {
    throw new Error(`${path}: not a migration marker`);
  }
  return value as MarkerFile;
}

export interface LegacyMigrationInput {
  markerPath: string;
  officialSnapshot: SourceSnapshot | null;
  content(listed: (kind: LegacyContentKind, name: string) => boolean): Promise<LegacyContentReport>;
  now: () => Date;
}

export interface LegacyMigrationReport {
  content: LegacyContentReport;
}

export async function runLegacyMigration(input: LegacyMigrationInput): Promise<LegacyMigrationReport | null> {
  const previous = await readMarker(input.markerPath);
  if (previous?.completedAt !== undefined) return null;
  const snapshot = input.officialSnapshot;
  if (!snapshot) return null;

  const content = await input.content((kind, name) => snapshot.packages.some((item) => item.kind === kind && item.name === name));
  const marker: MarkerFile =
    content.failed.length === 0
      ? { version: 1, completedAt: input.now().toISOString() }
      : { version: 1 };
  await writeFileAtomicAtPath(input.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return { content };
}

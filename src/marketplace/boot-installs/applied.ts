/** Recorded defaults never reinstall; unreadable records stop boot installs rather than resurrect removals. */
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { PACKAGE_KINDS, type PackageKind } from "../catalog/types.js";
import type { PackageKey } from "../sources/policy.js";
import { packageKeyId } from "./default-installs.js";

export type AppliedResult = "installed" | "skipped" | "migrated";

export interface AppliedDefault extends PackageKey {
  result: AppliedResult;
  reason?: string;
  at: string;
}

interface AppliedFile {
  version: 1;
  applied: AppliedDefault[];
}

const RESULTS = new Set<AppliedResult>(["installed", "skipped", "migrated"]);
const ENTRY_KEYS = new Set(["kind", "name", "source", "result", "reason", "at"]);

function parse(text: string, path: string): AppliedDefault[] {
  const fail = (why: string): never => {
    throw new Error(`${path}: ${why}`);
  };
  const value = parseStrictJson(text) as Partial<AppliedFile> | null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("not an object");
  if (Object.keys(value!).some((key) => key !== "version" && key !== "applied")) fail("unknown field");
  if (value!.version !== 1) fail("version must be 1");
  if (!Array.isArray(value!.applied)) fail("applied must be a list");
  const seen = new Set<string>();
  return value!.applied!.map((entry, index) => {
    const at = `applied[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail(`${at} is not an object`);
    if (Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) fail(`${at} has an unknown field`);
    if (!PACKAGE_KINDS.includes(entry.kind as PackageKind)) fail(`${at}.kind is not a package kind`);
    if (typeof entry.name !== "string" || typeof entry.source !== "string") fail(`${at} needs a name and a source`);
    if (!RESULTS.has(entry.result)) fail(`${at}.result is invalid`);
    if (typeof entry.at !== "string" || (entry.reason !== undefined && typeof entry.reason !== "string")) fail(`${at} is malformed`);
    const id = packageKeyId(entry);
    if (seen.has(id)) fail(`${id} is recorded twice`);
    seen.add(id);
    return entry;
  });
}

export class AppliedDefaults {
  private constructor(
    private readonly path: string,
    private readonly entries: Map<string, AppliedDefault>,
  ) {}

  static async open(path: string): Promise<AppliedDefaults> {
    let text: string | null = null;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const entries = text === null ? [] : parse(text, path);
    return new AppliedDefaults(path, new Map(entries.map((entry) => [packageKeyId(entry), entry])));
  }

  has(key: PackageKey): boolean {
    return this.entries.has(packageKeyId(key));
  }

  get(key: PackageKey): AppliedDefault | undefined {
    return this.entries.get(packageKeyId(key));
  }

  list(): AppliedDefault[] {
    return [...this.entries.values()];
  }

  async record(key: PackageKey, result: AppliedResult, at: Date, reason?: string): Promise<void> {
    const entry: AppliedDefault = { kind: key.kind, name: key.name, source: key.source, result, ...(reason ? { reason } : {}), at: at.toISOString() };
    this.entries.set(packageKeyId(key), entry);
    const file: AppliedFile = { version: 1, applied: this.list() };
    await writeFileAtomicAtPath(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

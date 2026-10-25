/** Ledger entries bind installed bytes and provenance; unreadable ledgers stop the store.
 * Current installs have unique payload directories; legacy installs use version directories. */
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { isPackageName } from "../catalog/types.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { OriginReader } from "../sources/retained.js";
import { isSourcePin } from "../sources/source-tree.js";
import { CONTENT_KINDS, type ContentKind } from "./rules.js";
import { parseConsentFingerprint, type ConsentFingerprint } from "../updates/consent-record.js";
import { isRecord } from "../../shared/is-record.js";

interface ContentOrigin {
  sourceId: string | null;
  sourceOrigin: SourceOrigin | null;
  /** The snapshot commit the install plan was bound to (kept by snapshot pruning). */
  commit: string | null;
  packagePath: string;
  version: string;
  contentSha256: string;
  installedAt: string;
  /** Unique install UUID; absent on legacy entries. */
  installId?: string;
  /** `<kind>/<name>/.installs/<installId>`, relative to the packages root; absent for a legacy install. */
  payloadDir?: string;
  /** Accepted consent fingerprint; absent on legacy entries. */
  consent?: ConsentFingerprint;
}

export interface LedgerEntry {
  kind: ContentKind;
  name: string;
  version: string;
  origin: ContentOrigin;
}

interface LedgerFile {
  version: 1;
  packages: LedgerEntry[];
}

const SOURCE_ORIGINS = new Set<SourceOrigin>(["official", "managed", "custom", "direct"]);
const ENTRY_KEYS = new Set(["kind", "name", "version", "origin"]);
const ORIGIN_KEYS = new Set(["sourceId", "sourceOrigin", "commit", "packagePath", "version", "contentSha256", "installedAt", "installId", "payloadDir", "consent"]);
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function installPayloadDir(kind: ContentKind, name: string, installId: string): string {
  return `${kind}/${name}/.installs/${installId}`;
}

function ledgerKey(kind: ContentKind, name: string): string {
  return `${kind}:${name}`;
}

function parse(text: string, path: string): LedgerEntry[] {
  const fail = (why: string): never => {
    throw new Error(`${path}: ${why}`);
  };
  const value = parseStrictJson(text);
  if (!isRecord(value)) return fail("not an object");
  if (Object.keys(value).some((key) => key !== "version" && key !== "packages")) fail("unknown field");
  if (value.version !== 1) fail("version must be 1");
  if (!Array.isArray(value.packages)) fail("packages must be a list");
  const seen = new Set<string>();
  return (value.packages as unknown[]).map((entry, index) => {
    const at = `packages[${index}]`;
    if (!isRecord(entry)) return fail(`${at} is not an object`);
    if (Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) fail(`${at} has an unknown field`);
    if (!CONTENT_KINDS.includes(entry.kind as ContentKind)) fail(`${at}.kind is not a content kind`);
    if (!isPackageName(entry.name)) fail(`${at}.name is not a package name`);
    if (typeof entry.version !== "string" || entry.version.length === 0) fail(`${at}.version is missing`);
    const origin = entry.origin;
    if (!isRecord(origin)) return fail(`${at}.origin is not an object`);
    if (Object.keys(origin).some((key) => !ORIGIN_KEYS.has(key))) fail(`${at}.origin has an unknown field`);
    if (!(origin.sourceId === null && origin.sourceOrigin === null && origin.commit === null)
      && !(typeof origin.sourceId === "string" && origin.sourceId.length > 0
        && SOURCE_ORIGINS.has(origin.sourceOrigin as SourceOrigin)
        && isSourcePin(origin.commit))
      || typeof origin.packagePath !== "string"
      || origin.version !== entry.version
      || typeof origin.contentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(origin.contentSha256)
      || typeof origin.installedAt !== "string") {
      fail(`${at}.origin is malformed`);
    }
    if (origin.sourceId === null && entry.kind !== "agent-plugin") fail(`${at}.origin is only local for agent plugins`);
    if ((origin.installId === undefined) !== (origin.payloadDir === undefined)) fail(`${at}.origin names an install directory only in part`);
    if (origin.installId !== undefined
      && (typeof origin.installId !== "string" || !INSTALL_ID.test(origin.installId)
        || origin.payloadDir !== installPayloadDir(entry.kind as ContentKind, entry.name as string, origin.installId))) {
      fail(`${at}.origin.payloadDir is not its install directory`);
    }
    if (origin.consent !== undefined) {
      const consent = parseConsentFingerprint(origin.consent, `${path}: ${at}.origin.consent`);
      if (consent.kind !== entry.kind) fail(`${at}.origin.consent is not a ${String(entry.kind)} fingerprint`);
    }
    const key = ledgerKey(entry.kind as ContentKind, entry.name as string);
    if (seen.has(key)) fail(`${key} is recorded twice`);
    seen.add(key);
    return entry as unknown as LedgerEntry;
  });
}

export class ContentLedger {
  private constructor(
    private readonly path: string,
    private readonly entries: Map<string, LedgerEntry>,
  ) {}

  static async open(path: string): Promise<ContentLedger> {
    let text: string | null = null;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const entries = text === null ? [] : parse(text, path);
    return new ContentLedger(path, new Map(entries.map((entry) => [ledgerKey(entry.kind, entry.name), entry])));
  }

  get(kind: ContentKind, name: string): LedgerEntry | undefined {
    return this.entries.get(ledgerKey(kind, name));
  }

  list(kind?: ContentKind): LedgerEntry[] {
    const all = [...this.entries.values()];
    return kind ? all.filter((entry) => entry.kind === kind) : all;
  }

  async put(entry: LedgerEntry): Promise<void> {
    const next = new Map(this.entries);
    next.set(ledgerKey(entry.kind, entry.name), entry);
    await this.write(next);
  }

  async remove(kind: ContentKind, name: string): Promise<boolean> {
    const key = ledgerKey(kind, name);
    if (!this.entries.has(key)) return false;
    const next = new Map(this.entries);
    next.delete(key);
    await this.write(next);
    return true;
  }

  /** The file is written first, so a failed write leaves memory and disk agreeing. */
  private async write(next: Map<string, LedgerEntry>): Promise<void> {
    const file: LedgerFile = { version: 1, packages: [...next.values()] };
    await writeFileAtomicAtPath(this.path, `${JSON.stringify(file, null, 2)}\n`);
    this.entries.clear();
    for (const [key, entry] of next) this.entries.set(key, entry);
  }
}

export function contentLedgerOrigins(ledgerPath: string): OriginReader {
  return async () => (await ContentLedger.open(ledgerPath)).list()
    .filter((entry) => entry.origin.sourceId !== null && entry.origin.commit !== null)
    .map((entry) => ({ kind: entry.kind, name: entry.name, sourceId: entry.origin.sourceId!, commit: entry.origin.commit! }));
}

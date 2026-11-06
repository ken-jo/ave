/** Ledger entries bind installed bytes and provenance; unreadable ledgers stop the store.
 * Current installs have unique payload directories; legacy installs use version directories. */
import { lstat, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { createMarketplaceLogger } from "../log.js";
import { withInstalledStateMutation } from "../../main/installed-state-mutation.js";
import { readAveHomeInput } from "../../shared/ave-home-trust.js";
import { AveHomeConfigurationRefusedWriteError } from "../../shared/ave-home.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { isPackageName } from "../catalog/types.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { OriginReader } from "../sources/retained.js";
import { isSourcePin } from "../sources/source-tree.js";
import { CONTENT_KINDS, type ContentKind } from "./rules.js";
import { parseConsentFingerprint, assertRetiredThemeConsent, type ConsentFingerprint } from "../updates/consent-record.js";
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

const log = createMarketplaceLogger("content-ledger");

const SOURCE_ORIGINS = new Set<SourceOrigin>(["official", "managed", "custom", "direct"]);
const ENTRY_KEYS = new Set(["kind", "name", "version", "origin"]);
const ORIGIN_KEYS = new Set(["sourceId", "sourceOrigin", "commit", "packagePath", "version", "contentSha256", "installedAt", "installId", "payloadDir", "consent"]);
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE_LEGACY_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

export function installPayloadDir(kind: ContentKind, name: string, installId: string): string {
  return `${kind}/${name}/.installs/${installId}`;
}

function ledgerKey(kind: ContentKind, name: string): string {
  return `${kind}:${name}`;
}

function parse(text: string, path: string): { entries: LedgerEntry[]; retiredPayloadDirs: string[]; retiredCount: number } {
  const fail = (why: string): never => {
    throw new Error(`${path}: ${why}`);
  };
  const value = parseStrictJson(text);
  if (!isRecord(value)) return fail("not an object");
  if (Object.keys(value).some((key) => key !== "version" && key !== "packages")) fail("unknown field");
  if (value.version !== 1) fail("version must be 1");
  if (!Array.isArray(value.packages)) fail("packages must be a list");
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];
  const retiredPayloadDirs: string[] = [];
  let retiredCount = 0;
  (value.packages as unknown[]).forEach((entry, index) => {
    const at = `packages[${index}]`;
    if (!isRecord(entry)) return fail(`${at} is not an object`);
    if (Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) fail(`${at} has an unknown field`);
    if (entry.kind !== "theme" && !CONTENT_KINDS.includes(entry.kind as ContentKind)) fail(`${at}.kind is not a content kind`);
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
        || origin.payloadDir !== `${String(entry.kind)}/${entry.name as string}/.installs/${origin.installId}`)) {
      fail(`${at}.origin.payloadDir is not its install directory`);
    }
    if (origin.consent !== undefined) {
      if (entry.kind === "theme") assertRetiredThemeConsent(origin.consent, `${path}: ${at}.origin.consent`);
      else {
        const consent = parseConsentFingerprint(origin.consent, `${path}: ${at}.origin.consent`);
        if (consent.kind !== entry.kind) fail(`${at}.origin.consent is not a ${String(entry.kind)} fingerprint`);
      }
    }
    const key = `${String(entry.kind)}:${entry.name as string}`;
    if (seen.has(key)) fail(`${key} is recorded twice`);
    seen.add(key);
    if (entry.kind === "theme") {
      retiredCount += 1;
      if (typeof origin.payloadDir === "string") retiredPayloadDirs.push(origin.payloadDir);
      else {
        if (!SAFE_LEGACY_VERSION.test(entry.version as string)) fail(`${at}.version is not a safe payload directory`);
        retiredPayloadDirs.push(`theme/${entry.name as string}/${entry.version as string}`);
      }
    } else entries.push(entry as unknown as LedgerEntry);
  });
  return { entries, retiredPayloadDirs, retiredCount };
}

/** A missing directory permits an interrupted cleanup to resume; tampered paths fail with their location. */
async function retiredDirectoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`Retired package payload is a symbolic link: ${path}`);
    if (!entry.isDirectory()) throw new Error(`Retired package payload is not a directory: ${path}`);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** Every component, including the store root, is inspected without following links. */
async function retiredPathExists(root: string, relative: string): Promise<boolean> {
  let path = root;
  if (!await retiredDirectoryExists(path)) return false;
  for (const segment of relative.split("/")) {
    path = join(path, segment);
    if (!await retiredDirectoryExists(path)) return false;
  }
  return true;
}

/** Validate every target before deleting payloads; prune only empty package-owned parent directories. */
async function removeRetiredPayloads(root: string, payloadDirs: readonly string[]): Promise<number> {
  const existing: string[] = [];
  const parents = new Set<string>();
  for (const relative of payloadDirs) {
    if (await retiredPathExists(root, relative)) existing.push(join(root, relative));
    const parent = dirname(relative);
    if (parent.endsWith("/.installs")) parents.add(parent);
    parents.add(relative.split("/").slice(0, 2).join("/"));
  }
  for (const path of existing) await rm(path, { recursive: true, force: true });
  for (const relative of parents) {
    if (!await retiredPathExists(root, relative)) continue;
    try { await rmdir(join(root, relative)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!isMissingPathError(error) && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
  return existing.length;
}

export class ContentLedger {
  private constructor(
    private readonly path: string,
    private readonly entries: Map<string, LedgerEntry>,
    /**
     * The file was pending review in the home content trust manifest when this view was opened: it lists nothing, sweeps
     * nothing and is never rewritten from that empty view. A mutation re-reads it, so an approval made since is honoured.
     */
    public pendingReview = false,
  ) {}

  static async open(path: string): Promise<ContentLedger> {
    // The ledger's digests vouch for installed packages, like a plugin install receipt: one verified buffer, and a ledger
    // pending review installs nothing.
    const input = await readAveHomeInput(path);
    if (input.status === "untrusted") return new ContentLedger(path, new Map(), true);
    const parsed = input.status === "absent" ? { entries: [], retiredPayloadDirs: [], retiredCount: 0 } : parse(input.bytes.toString("utf8"), path);
    if (parsed.retiredCount > 0) {
      await withInstalledStateMutation(async () => {
        const payloadsRemoved = await removeRetiredPayloads(dirname(path), parsed.retiredPayloadDirs);
        await writeFileAtomicAtPath(path, `${JSON.stringify({ version: 1, packages: parsed.entries }, null, 2)}\n`);
        log.info({ entriesRemoved: parsed.retiredCount, payloadsRemoved }, "Retired content migrated");
      });
    }
    return new ContentLedger(path, new Map(parsed.entries.map((entry) => [ledgerKey(entry.kind, entry.name), entry])));
  }

  get(kind: ContentKind, name: string): LedgerEntry | undefined {
    return this.entries.get(ledgerKey(kind, name));
  }

  list(kind?: ContentKind): LedgerEntry[] {
    const all = [...this.entries.values()];
    return kind ? all.filter((entry) => entry.kind === kind) : all;
  }

  async put(entry: LedgerEntry): Promise<void> {
    return withInstalledStateMutation(async () => {
      await this.reloadIfPending();
      const next = new Map(this.entries);
      next.set(ledgerKey(entry.kind, entry.name), entry);
      await this.write(next);
    });
  }

  async remove(kind: ContentKind, name: string): Promise<boolean> {
    return withInstalledStateMutation(async () => {
      await this.reloadIfPending();
      const key = ledgerKey(kind, name);
      if (!this.entries.has(key)) return false;
      const next = new Map(this.entries);
      next.delete(key);
      await this.write(next);
      return true;
    });
  }

  /** A view opened while the file was pending review re-reads it; still pending, the mutation is refused, never applied to the empty view. */
  private async reloadIfPending(): Promise<void> {
    if (!this.pendingReview) return;
    const reopened = await ContentLedger.open(this.path);
    if (reopened.pendingReview) throw new AveHomeConfigurationRefusedWriteError(this.path, "change the installed content ledger", "pending");
    const entries = reopened.list();
    this.entries.clear();
    for (const entry of entries) this.entries.set(ledgerKey(entry.kind, entry.name), entry);
    this.pendingReview = false;
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
  return async () => (await openVouchingLedger(ledgerPath)).list()
    .filter((entry) => entry.origin.sourceId !== null && entry.origin.commit !== null)
    .map((entry) => ({ kind: entry.kind, name: entry.name, sourceId: entry.origin.sourceId!, commit: entry.origin.commit! }));
}

async function openVouchingLedger(ledgerPath: string): Promise<ContentLedger> {
  const ledger = await ContentLedger.open(ledgerPath);
  if (ledger.pendingReview) throw new Error("the installed content ledger is waiting for review");
  return ledger;
}

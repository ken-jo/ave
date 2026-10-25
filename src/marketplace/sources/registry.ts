/** Revalidate stored ids on load without rewriting invalid entries.
 * Unreadable user registries block writes while built-in sources remain available. */
import { randomBytes } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { createMarketplaceLogger } from "../log.js";
import { renameDirectory } from "../../lib/transient-fs-lock-retry.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { CREDENTIAL_ISSUER_NAMES, reservedPrefixIn } from "../../shared/dlp.js";
import { errorMessage } from "../../shared/error-message.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import {
  MARKETPLACE_ERROR_CODES,
  MarketplaceError,
  isMarketplaceError,
  parseMarketplaceErrorDetail,
  type MarketplaceErrorCode,
  type MarketplaceErrorDetail,
} from "../errors.js";
import { assertRepoPath } from "../git/repo.js";
import { normalizeFolderPath, splitFolderPath, type FolderIdentity } from "../net/source-input.js";
import { normalizeSourceHost, normalizeSourceUrl, sameSourceRepository, type NormalizedSourceUrl } from "../net/source-url.js";
import {
  OFFICIAL_MARKETPLACE,
  SOURCE_ID_RE,
  isReservedSourceId,
  isSourceId,
  isSourceLabel,
  isSourceRef,
  type OfficialMarketplace,
  type SourceAuth,
} from "./official.js";
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicySource } from "./policy.js";
import { FOLDER_REVISION_RE, GIT_COMMIT_RE } from "./source-tree.js";
import { isSourceWarning, type SourceWarning } from "./warnings.js";
import { isRecord } from "../../shared/is-record.js";

export type SourceOrigin = "official" | "managed" | "custom" | "direct";

interface SourceEntry {
  id: string;
  origin: "custom" | "direct";
  url?: string;
  path?: string;
  ref?: string;
  subdir?: string;
  auth: SourceAuth;
  addedAt: string;
  label?: string;
  /** Confirmations are address-bound; absent means no consent. */
  acknowledged?: StoredConfirmations;
}

/** Consent is bound to the complete normalized address or canonical folder path and never follows edits. */
export type StoredConfirmations = { url: string; warnings: SourceWarning[] } | { path: string; warnings: SourceWarning[] };

export type SourceIdentity = { url: string } | { path: string };

export function sourceIdentity(source: ResolvedSource): SourceIdentity {
  return source.transport === "git" ? { url: source.url.url } : { path: source.path };
}

function sameIdentity(stored: StoredConfirmations, identity: SourceIdentity): boolean {
  return "url" in stored ? "url" in identity && stored.url === identity.url : "path" in identity && stored.path === identity.path;
}

/** Return no warnings when the stored consent identity differs. */
export function confirmationsFor(stored: StoredConfirmations | undefined, identity: SourceIdentity): SourceWarning[] {
  return stored !== undefined && sameIdentity(stored, identity) ? [...stored.warnings] : [];
}

export interface SourceState {
  pinnedCommit: string | null;
  /** Hiding disables browsing and installs; bound packages keep syncing. */
  enabled: boolean;
  lastSync?: { at: string; result: "ok" | MarketplaceErrorCode; detail?: MarketplaceErrorDetail; candidate?: string };
  pendingRewrite?: { candidate: string; seenAt: string };
  /** Built-in sources store consent in state; custom and direct sources store it with their entry. */
  acknowledged?: StoredConfirmations;
  /** Stored directory and ancestor identities detect replacement and overlap through aliases. */
  folder?: StoredFolderIdentity & { ancestors: StoredFolderIdentity[] };
}

interface StoredFolderIdentity {
  dev: string;
  ino: string;
}

export function folderIdentityState(root: FolderIdentity & { ancestors: readonly FolderIdentity[] }): NonNullable<SourceState["folder"]> {
  const stored = ({ dev, ino }: FolderIdentity): StoredFolderIdentity => ({ dev: dev.toString(), ino: ino.toString() });
  return { ...stored(root), ancestors: root.ancestors.map(stored) };
}

interface SourceBase {
  id: string;
  origin: SourceOrigin;
  auth: SourceAuth;
  label?: string;
  /** Custom/direct consent lives with the entry; built-in source consent lives in state. */
  acknowledged?: readonly SourceWarning[];
}

export interface GitSource extends SourceBase {
  transport: "git";
  url: NormalizedSourceUrl;
  mirrors: readonly NormalizedSourceUrl[];
  ref?: string;
  subdir?: string;
}

/** Folders are read in place without git or auth; managed entries confer network-folder consent. */
export interface FolderSource extends SourceBase {
  transport: "folder";
  origin: "managed" | "custom" | "direct";
  path: string;
  auth: { kind: "none" };
}

export type ResolvedSource = GitSource | FolderSource;

export interface RegistryDiagnostic {
  subject: string;
  message: string;
}

export interface NewSource {
  id: string;
  origin: "custom" | "direct";
  url: string;
  ref?: string;
  subdir?: string;
  auth: SourceAuth;
  label?: string;
  acknowledged?: readonly SourceWarning[];
}

export interface NewFolderSource {
  id: string;
  origin: "custom" | "direct";
  path: string;
  dev: bigint;
  ino: bigint;
  ancestors: readonly FolderIdentity[];
  label?: string;
  acknowledged?: readonly SourceWarning[];
}

const ENTRY_KEYS = new Set(["id", "origin", "url", "path", "ref", "subdir", "auth", "addedAt", "label", "acknowledged"]);
const STATE_KEYS = new Set(["pinnedCommit", "enabled", "lastSync", "pendingRewrite", "acknowledged", "folder"]);
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

class RegistryShapeError extends Error {}

function shape(condition: boolean, message: string): asserts condition {
  if (!condition) throw new RegistryShapeError(message);
}

function knownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, what: string): void {
  for (const key of Object.keys(value)) shape(keys.has(key), `${what}: unknown key ${key}`);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function checkAuth(value: unknown, url: NormalizedSourceUrl): SourceAuth {
  shape(isRecord(value), "auth must be an object");
  if (value.kind === "none" || value.kind === "ssh") {
    knownKeys(value, new Set(["kind"]), "auth");
    shape((value.kind === "ssh") === (url.scheme === "ssh"), `auth ${value.kind} does not fit a ${url.scheme} URL`);
    return { kind: value.kind };
  }
  shape(value.kind === "token", "auth.kind must be none, token or ssh");
  knownKeys(value, new Set(["kind", "host"]), "auth");
  shape(url.scheme !== "ssh", "token auth needs an http(s) URL");
  shape(typeof value.host === "string", "auth.host must be a string");
  let host: string;
  try {
    host = normalizeSourceHost(value.host, value.host);
  } catch (error) {
    throw new RegistryShapeError(`auth.host: ${isMarketplaceError(error) ? error.message : String(error)}`);
  }
  shape(host === value.host, "auth.host must be normalized");
  shape(host === url.host, `auth.host must be the source's host ${url.host}`);
  return { kind: "token", host };
}

/** Stored confirmations contain one normalized identity and deduplicated known warnings. */
function checkAcknowledged(value: unknown, platform: NodeJS.Platform): StoredConfirmations {
  shape(isRecord(value), "acknowledged must be an object");
  const warnings = value.warnings;
  shape(Array.isArray(warnings), "acknowledged.warnings must be an array");
  shape(warnings.every(isSourceWarning), "acknowledged holds an unknown confirmation");
  shape(new Set(warnings).size === warnings.length, "acknowledged lists a confirmation twice");
  if (value.path !== undefined) {
    knownKeys(value, new Set(["path", "warnings"]), "acknowledged");
    shape(typeof value.path === "string" && isStoredFolderPath(value.path, platform), "acknowledged.path is not a canonical folder path");
    return { path: value.path, warnings: [...(warnings as SourceWarning[])] };
  }
  knownKeys(value, new Set(["url", "warnings"]), "acknowledged");
  shape(typeof value.url === "string", "acknowledged.url must be a string");
  let url: NormalizedSourceUrl;
  try {
    url = normalizeSourceUrl(value.url as string);
  } catch {
    throw new RegistryShapeError("acknowledged.url is not a source address");
  }
  shape(url.url === value.url, "acknowledged.url is not in normalized form");
  return { url: url.url, warnings: [...(warnings as SourceWarning[])] };
}

/** Stored folder paths must already be canonical for the platform without input-only aliases. */
function isStoredFolderPath(path: string, platform: NodeJS.Platform): boolean {
  if (path.startsWith("~") || /^file:/iu.test(path)) return false;
  try {
    return normalizeFolderPath(path, platform, "") === path;
  } catch {
    return false;
  }
}

function checkRef(ref: unknown): void {
  shape(isSourceRef(ref), "ref is not a branch or tag name");
}

function checkSubdir(subdir: unknown): void {
  shape(typeof subdir === "string", "subdir must be a string");
  try {
    assertRepoPath(subdir);
  } catch {
    shape(false, `subdir is not a repository path: ${subdir}`);
  }
}

type CheckedEntry = { entry: SourceEntry; url: NormalizedSourceUrl; path?: never } | { entry: SourceEntry; path: string; url?: never };

/** Stored addresses must already be normalized; folder entries cannot carry git fields. */
function checkEntry(raw: unknown, platform: NodeJS.Platform): CheckedEntry {
  shape(isRecord(raw), "entry must be an object");
  knownKeys(raw, ENTRY_KEYS, "entry");
  shape(typeof raw.id === "string" && SOURCE_ID_RE.test(raw.id), "id is not a source id");
  shape(raw.origin === "custom" || raw.origin === "direct", "origin must be custom or direct");
  if (raw.path !== undefined) {
    shape(raw.url === undefined, "an entry has url or path, not both");
    shape(typeof raw.path === "string" && isStoredFolderPath(raw.path, platform), "path is not a canonical folder path");
    shape(raw.ref === undefined, "a folder has no ref");
    shape(raw.subdir === undefined, "a folder has no subdir");
    shape(isRecord(raw.auth) && raw.auth.kind === "none" && Object.keys(raw.auth).length === 1, "a folder's auth must be none");
    shape(isIsoTime(raw.addedAt), "addedAt must be an ISO-8601 time");
    if (raw.label !== undefined) shape(isSourceLabel(raw.label), "label must be 1-100 printable characters");
    if (raw.acknowledged !== undefined) checkAcknowledged(raw.acknowledged, platform);
    return { entry: { ...(raw as unknown as SourceEntry), auth: { kind: "none" } }, path: raw.path };
  }
  shape(typeof raw.url === "string", "url must be a string");
  let url: NormalizedSourceUrl;
  try {
    url = normalizeSourceUrl(raw.url);
  } catch (error) {
    throw new RegistryShapeError(isMarketplaceError(error) ? error.message : String(error));
  }
  shape(url.url === raw.url, `url is not in normalized form (expected ${url.url})`);
  if (raw.ref !== undefined) checkRef(raw.ref);
  if (raw.subdir !== undefined) {
    shape(raw.origin === "direct", "subdir is for direct sources only");
    checkSubdir(raw.subdir);
  }
  const auth = checkAuth(raw.auth, url);
  shape(isIsoTime(raw.addedAt), "addedAt must be an ISO-8601 time");
  if (raw.label !== undefined) shape(isSourceLabel(raw.label), "label must be 1-100 printable characters");
  if (raw.acknowledged !== undefined) checkAcknowledged(raw.acknowledged, platform);
  return { entry: { ...(raw as unknown as SourceEntry), auth }, url };
}

/** Validate pin syntax here and its transport-specific meaning when the source is known. */
function checkState(raw: unknown, platform: NodeJS.Platform): SourceState {
  shape(isRecord(raw), "state must be an object");
  knownKeys(raw, STATE_KEYS, "state");
  const isPin = (value: unknown) => typeof value === "string" && (GIT_COMMIT_RE.test(value) || FOLDER_REVISION_RE.test(value));
  shape(raw.pinnedCommit === null || isPin(raw.pinnedCommit), "pinnedCommit must be null, a commit id or a folder revision");
  shape(typeof raw.enabled === "boolean", "enabled must be true or false");
  let state = raw;
  if (raw.lastSync !== undefined) {
    const last = raw.lastSync;
    shape(isRecord(last), "lastSync must be an object");
    knownKeys(last, new Set(["at", "result", "detail", "candidate"]), "lastSync");
    shape(isIsoTime(last.at), "lastSync.at must be an ISO-8601 time");
    shape(last.result === "ok" || MARKETPLACE_ERROR_CODES.includes(last.result as MarketplaceErrorCode), "lastSync.result is not a result code");
    shape(last.candidate === undefined || (typeof last.candidate === "string" && GIT_COMMIT_RE.test(last.candidate)), "lastSync.candidate must be a commit id");
    if (last.detail !== undefined) {
      // Drop unknown display details but preserve the failure code.
      const detail = last.result === "ok" ? undefined : parseMarketplaceErrorDetail(last.result as MarketplaceErrorCode, last.detail);
      const { detail: _dropped, ...rest } = last;
      state = { ...raw, lastSync: detail ? { ...rest, detail } : rest };
    }
  }
  if (raw.pendingRewrite !== undefined) {
    const pending = raw.pendingRewrite;
    shape(isRecord(pending), "pendingRewrite must be an object");
    knownKeys(pending, new Set(["candidate", "seenAt"]), "pendingRewrite");
    shape(typeof pending.candidate === "string" && GIT_COMMIT_RE.test(pending.candidate), "pendingRewrite.candidate must be a commit id");
    shape(isIsoTime(pending.seenAt), "pendingRewrite.seenAt must be an ISO-8601 time");
  }
  if (raw.acknowledged !== undefined) checkAcknowledged(raw.acknowledged, platform);
  if (raw.folder !== undefined) {
    const folder = raw.folder;
    shape(isRecord(folder), "folder must be an object");
    knownKeys(folder, new Set(["dev", "ino", "ancestors"]), "folder");
    const identity = (value: unknown) => isRecord(value) && typeof value.dev === "string" && DECIMAL.test(value.dev) && typeof value.ino === "string" && DECIMAL.test(value.ino);
    shape(identity(folder), "folder.dev and folder.ino must be decimal text");
    shape(
      Array.isArray(folder.ancestors) && folder.ancestors.every((ancestor) => identity(ancestor) && Object.keys(ancestor as object).length === 2),
      "folder.ancestors must list each directory above the folder as decimal dev and ino",
    );
  }
  return state as unknown as SourceState;
}

/** Folder state permits revisions only; git state permits commits only and no folder identity. */
function transportProblem(source: ResolvedSource, state: SourceState): string | null {
  if (source.transport === "folder") {
    if (state.pinnedCommit !== null && !FOLDER_REVISION_RE.test(state.pinnedCommit)) return "a folder source's pin must be a folder revision";
    if (state.pendingRewrite !== undefined || state.lastSync?.candidate !== undefined) return "a folder source has no history rule";
    return null;
  }
  if (state.pinnedCommit !== null && !GIT_COMMIT_RE.test(state.pinnedCommit)) return "a git source's pin must be a commit id";
  if (state.folder !== undefined) return "a git source has no folder identity";
  return null;
}

const FRESH_STATE: SourceState = Object.freeze({ pinnedCommit: null, enabled: true });

export interface SourceRegistryOptions {
  root: string;
  /** Read policy at listing time so managed sources follow the current operation policy. */
  policy: PolicySource;
  official?: OfficialMarketplace;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

/** Missing state is fresh only without synced data; unusable state requires repair rather than losing history. */
export async function readSourceState(root: string, id: string, platform: NodeJS.Platform = process.platform): Promise<SourceState> {
  const dir = join(root, id);
  let text: string;
  try {
    text = await readFile(join(dir, "state.json"), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      // Synced data without state has lost its pin; accepting fresh state would bypass history review.
      if (existsSync(join(dir, "repo.git")) || existsSync(join(dir, "snapshots"))) {
        throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `state.json of source ${id} is missing while its synced data remains`, {
          cause: error,
          detail: { reason: "state-missing", sourceId: id },
        });
      }
      return { ...FRESH_STATE };
    }
    throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `state.json of source ${id} cannot be read (${fsErrorCode(error)})`, {
      cause: error,
      detail: { reason: "state-unreadable", sourceId: id },
    });
  }
  try {
    return checkState(parseStrictJson(text), platform);
  } catch (error) {
    throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `state.json of source ${id} is invalid: ${errorMessage(error)}`, {
      cause: error,
      detail: { reason: "state-invalid", sourceId: id },
    });
  }
}

const log = createMarketplaceLogger("marketplace-registry");

const TRASH_PREFIX = ".trash-";

/** Error codes reveal no home paths, unlike filesystem error messages. */
export function fsErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : typeof error;
}

/** Remove entries without traversing links; Windows junctions require unlink or rmdir, never recursive rm. */
async function removeTreeNoFollow(path: string): Promise<void> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    try {
      await unlink(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EISDIR") throw error;
      await rmdir(path);
    }
    return;
  }
  if (!entry.isDirectory()) {
    await unlink(path);
    return;
  }
  for (const name of await readdir(path)) await removeTreeNoFollow(join(path, name));
  await rmdir(path);
}

export class SourceRegistry {
  private rawEntries: unknown[] = [];
  private stored: ResolvedSource[] = [];
  /** Preserve raw entries so removal touches only the selected served entry. */
  private storedRaw = new Map<string, unknown>();
  /** Registry-read failures expose filesystem codes, never home paths. */
  private fileProblem: { message: string; detail: MarketplaceErrorDetail<"SOURCE_LIST_UNREADABLE"> } | null = null;
  private loadDiagnostics: RegistryDiagnostic[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly official: GitSource;
  private readonly platform: NodeJS.Platform;
  private builtFor: { digest: string; sources: ResolvedSource[] } | null = null;

  private constructor(private readonly options: SourceRegistryOptions) {
    const constant = options.official ?? OFFICIAL_MARKETPLACE;
    this.platform = options.platform ?? process.platform;
    this.official = {
      transport: "git",
      id: constant.id,
      origin: "official",
      url: normalizeSourceUrl(constant.url),
      mirrors: constant.mirrors.map((mirror) => normalizeSourceUrl(mirror)),
      auth: constant.auth,
    };
  }

  private get policy(): MarketplacePolicy {
    const load = this.options.policy.load;
    return load.ok ? load.policy : EMPTY_MARKETPLACE_POLICY;
  }

  private get builtIn(): ResolvedSource[] {
    const digest = this.options.policy.digest;
    if (this.builtFor?.digest !== digest) {
      // An unreadable policy yields no managed sources; the gate blocks every non-official target then.
      const managed = this.policy.additional.map((spec): ResolvedSource => spec.transport === "folder"
        ? {
          transport: "folder",
          id: spec.id,
          origin: "managed",
          path: spec.path,
          auth: { kind: "none" },
          ...(spec.label !== undefined ? { label: spec.label } : {}),
        }
        : {
          transport: "git",
          id: spec.id,
          origin: "managed",
          url: spec.url,
          mirrors: [],
          ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
          auth: spec.auth,
          ...(spec.label !== undefined ? { label: spec.label } : {}),
        });
      this.builtFor = { digest, sources: [this.official, ...managed] };
      this.resolveStored();
    }
    return this.builtFor.sources;
  }

  static async open(options: SourceRegistryOptions): Promise<SourceRegistry> {
    const registry = new SourceRegistry(options);
    await registry.reload();
    await registry.sweepTrash();
    return registry;
  }

  /** Reclaim interrupted repair trash best-effort; leftovers may wait until the next open or repair. */
  private async sweepTrash(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.root);
    } catch (error) {
      if (!isMissingPathError(error)) log.warn({ error: fsErrorCode(error) }, "repair: could not list the marketplaces folder to sweep moved-aside copies");
      return;
    }
    for (const name of names) {
      if (name.startsWith(TRASH_PREFIX)) await this.reclaim(join(this.options.root, name));
    }
  }

  private async reclaim(trash: string): Promise<void> {
    try {
      await removeTreeNoFollow(trash);
    } catch (error) {
      log.warn({ trash: trash.slice(this.options.root.length + 1), error: fsErrorCode(error) }, "repair: could not remove a copy moved aside; the next sweep retries");
    }
  }

  /** Retry transient Windows locks during the single repair rename. */
  protected async moveAside(from: string, to: string): Promise<void> {
    await renameDirectory(from, to);
  }

  private get sourcesPath(): string {
    return join(this.options.root, "sources.json");
  }

  private statePath(id: string): string {
    return join(this.options.root, id, "state.json");
  }

  /** Serialize mutations so two writers never interleave read-modify-write. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async reload(): Promise<void> {
    this.fileProblem = null;
    this.rawEntries = [];
    let text: string | null = null;
    try {
      text = await readFile(this.sourcesPath, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) {
        const fsCode = fsErrorCode(error);
        this.fileProblem = { message: `cannot read sources.json (${fsCode})`, detail: { reason: "unreadable", fsCode } };
      }
    }
    if (text !== null) {
      try {
        const file = parseStrictJson(text);
        shape(isRecord(file), "sources.json must be an object");
        knownKeys(file, new Set(["version", "sources"]), "sources.json");
        shape(file.version === 1, "sources.json version must be 1");
        shape(Array.isArray(file.sources), "sources.json sources must be an array");
        this.rawEntries = file.sources;
      } catch (error) {
        this.fileProblem = { message: `sources.json is invalid: ${errorMessage(error)}`, detail: { reason: "invalid" } };
      }
    }
    this.resolveStored();
  }

  private resolveStored(): void {
    const diagnostics: RegistryDiagnostic[] = [];
    const taken = new Map((this.builtFor?.sources ?? this.builtIn).map((source) => [source.id, source.origin] as const));
    const stored: ResolvedSource[] = [];
    const storedRaw = new Map<string, unknown>();
    for (const [position, raw] of this.rawEntries.entries()) {
      const subject = isRecord(raw) && typeof raw.id === "string" ? raw.id : `sources[${position}]`;
      let checked: CheckedEntry;
      try {
        checked = checkEntry(raw, this.platform);
      } catch (error) {
        if (!(error instanceof RegistryShapeError)) throw error;
        diagnostics.push({ subject, message: error.message });
        continue;
      }
      const { entry } = checked;
      if (isReservedSourceId(entry.id)) {
        diagnostics.push({ subject, message: `${entry.id} is a reserved source id` });
        continue;
      }
      const owner = taken.get(entry.id);
      if (owner) {
        diagnostics.push({ subject, message: `${entry.id} is already used by a ${owner} source` });
        continue;
      }
      taken.set(entry.id, entry.origin);
      storedRaw.set(entry.id, raw);
      if (checked.path !== undefined) {
        const path = checked.path;
        stored.push({
          transport: "folder",
          id: entry.id,
          origin: entry.origin,
          path,
          auth: { kind: "none" },
          ...(entry.label !== undefined ? { label: entry.label } : {}),
          acknowledged: confirmationsFor(entry.acknowledged, { path }),
        });
        continue;
      }
      const url = checked.url;
      stored.push({
        transport: "git",
        id: entry.id,
        origin: entry.origin,
        url,
        mirrors: [],
        ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
        ...(entry.subdir !== undefined ? { subdir: entry.subdir } : {}),
        auth: entry.auth,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        acknowledged: confirmationsFor(entry.acknowledged, { url: url.url }),
      });
    }
    this.stored = stored;
    this.storedRaw = storedRaw;
    this.loadDiagnostics = this.fileProblem ? [{ subject: "sources.json", message: this.fileProblem.message }, ...diagnostics] : diagnostics;
  }

  list(): ResolvedSource[] {
    return [...this.builtIn, ...this.stored];
  }

  get(id: string): ResolvedSource | undefined {
    return this.list().find((source) => source.id === id);
  }

  diagnostics(): readonly RegistryDiagnostic[] {
    return this.loadDiagnostics;
  }

  private checkNewId(id: string): void {
    if (!SOURCE_ID_RE.test(id)) {
      throw new MarketplaceError("SOURCE_ID_INVALID", `${id} is not a valid source id (2-63 lowercase letters, digits or -)`);
    }
    if (!isSourceId(id)) {
      const reserved = reservedPrefixIn(id);
      if (reserved) {
        throw new MarketplaceError("SOURCE_ID_INVALID", `${reserved.prefix} is a reserved prefix: an id using it looks like ${CREDENTIAL_ISSUER_NAMES[reserved.issuer]}; choose a different id`, {
          detail: { reason: "reserved-prefix", prefix: reserved.prefix, issuer: reserved.issuer },
        });
      }
      throw new MarketplaceError("SOURCE_ID_INVALID", "this source id looks like a password or token", { detail: { reason: "holds-credential" } });
    }
    if (isReservedSourceId(id)) {
      throw new MarketplaceError("SOURCE_NAME_RESERVED", `${id} is a reserved source id`);
    }
    // Unserved entries still reserve their ids and remain untouched in the file.
    const unserved = this.rawEntries.some((raw) => isRecord(raw) && raw.id === id);
    if (unserved || this.list().some((existing) => existing.id === id)) {
      throw new MarketplaceError("SOURCE_ID_TAKEN", `a source named ${id} already exists`);
    }
  }

  checkNew(source: NewSource): NormalizedSourceUrl {
    this.checkNewId(source.id);
    const url = normalizeSourceUrl(source.url);
    const duplicate = this.list().find(
      (existing) => existing.transport === "git" && sameSourceRepository(existing.url, url) && (existing.subdir ?? null) === (source.subdir ?? null),
    );
    if (duplicate) {
      throw new MarketplaceError("SOURCE_ID_TAKEN", `this repository is already added as ${duplicate.id}`, {
        detail: { reason: "repository-already-added", url: url.url, existingId: duplicate.id },
      });
    }
    return url;
  }

  /** Detect overlapping folders by canonical paths, then nonzero root and ancestor identities across aliases. */
  async checkNewFolder(source: NewFolderSource): Promise<void> {
    this.checkNewId(source.id);
    const known = (identity: { dev: string; ino: string }) => identity.dev !== "0" && identity.ino !== "0";
    const sameAs = (identity: { dev: string; ino: string }) => (other: FolderIdentity) => known(identity) && identity.dev === other.dev.toString() && identity.ino === other.ino.toString();
    for (const existing of this.list()) {
      if (existing.transport !== "folder") continue;
      let relation = folderRelation(source.path, existing.path, this.platform);
      const recorded = relation === null ? (await this.readState(existing.id)).folder : undefined;
      if (recorded) {
        if (sameAs(recorded)(source)) relation = "same";
        else if (source.ancestors.some(sameAs(recorded))) relation = "inside";
        else if (recorded.ancestors.some((ancestor) => sameAs(ancestor)(source))) relation = "contains";
      }
      if (relation !== null) throw folderOverlap(source.path, existing, relation);
    }
  }

  private assertWritable(): void {
    // Never rewrite unreadable user source lists; doing so could lose entries.
    if (this.fileProblem) {
      throw new MarketplaceError("SOURCE_LIST_UNREADABLE", `${this.fileProblem.message}; no source is changed until it is fixed or deleted`, {
        detail: this.fileProblem.detail,
      });
    }
  }

  private async writeSources(entries: unknown[]): Promise<void> {
    const file = { version: 1, sources: entries };
    await writeFileAtomicAtPath(this.sourcesPath, `${JSON.stringify(file, null, 2)}\n`);
    this.rawEntries = entries;
    this.resolveStored();
  }

  async add(source: NewSource): Promise<ResolvedSource> {
    return this.exclusive(async () => {
      this.assertWritable();
      const url = this.checkNew(source);
      const entry: SourceEntry = {
        id: source.id,
        origin: source.origin,
        url: url.url,
        ...(source.ref !== undefined ? { ref: source.ref } : {}),
        ...(source.subdir !== undefined ? { subdir: source.subdir } : {}),
        auth: source.auth.kind === "token" ? { kind: "token", host: normalizeSourceHost(source.auth.host, source.auth.host) } : source.auth,
        addedAt: (this.options.now?.() ?? new Date()).toISOString(),
        ...(source.label !== undefined ? { label: source.label } : {}),
        ...(source.acknowledged !== undefined && source.acknowledged.length > 0 ? { acknowledged: { url: url.url, warnings: [...source.acknowledged] } } : {}),
      };
      try {
        checkEntry(entry, this.platform);
      } catch (error) {
        if (error instanceof RegistryShapeError) throw new MarketplaceError("SOURCE_URL_REJECTED", error.message);
        throw error;
      }
      await this.writeSources([...this.rawEntries, entry]);
      const added = this.get(source.id);
      if (!added) throw new Error(`source ${source.id} was written but does not resolve`);
      return added;
    });
  }

  async addFolder(source: NewFolderSource): Promise<FolderSource> {
    return this.exclusive(async () => {
      this.assertWritable();
      await this.checkNewFolder(source);
      const entry: SourceEntry = {
        id: source.id,
        origin: source.origin,
        path: source.path,
        auth: { kind: "none" },
        addedAt: (this.options.now?.() ?? new Date()).toISOString(),
        ...(source.label !== undefined ? { label: source.label } : {}),
        ...(source.acknowledged !== undefined && source.acknowledged.length > 0 ? { acknowledged: { path: source.path, warnings: [...source.acknowledged] } } : {}),
      };
      try {
        checkEntry(entry, this.platform);
      } catch (error) {
        if (error instanceof RegistryShapeError) throw new MarketplaceError("SOURCE_URL_REJECTED", error.message);
        throw error;
      }
      await this.writeSources([...this.rawEntries, entry]);
      const added = this.get(source.id);
      if (added?.transport !== "folder") throw new Error(`folder source ${source.id} was written but does not resolve`);
      await this.writeState(source.id, { pinnedCommit: null, enabled: true, folder: folderIdentityState(source) });
      return added;
    });
  }

  /** Wait for any source sync before removal; installed packages retain their origin binding. */
  async remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const source = this.get(id);
      if (!source) throw new Error(`no source named ${id}`);
      if (source.origin === "official" || source.origin === "managed") {
        throw new Error(`the ${source.origin} source ${id} cannot be removed`);
      }
      this.assertWritable();
      const entry = this.storedRaw.get(id);
      const remaining = this.rawEntries.filter((raw) => raw !== entry);
      await this.writeSources(remaining);
      await removeTreeNoFollow(join(this.options.root, id));
    });
  }

  /** Repair moves only source-local data aside, preserving a readable pin and switches.
     * Failed moves or pin writes must not lose the readable history boundary. */
  async resetLocalData(id: string, kept: Pick<SourceState, "pinnedCommit" | "enabled" | "folder"> | null): Promise<void> {
    return this.exclusive(async () => {
      if (!this.get(id)) throw new Error(`no source named ${id}`);
      await this.sweepTrash();
      const dir = join(this.options.root, id);
      const trash = join(this.options.root, `${TRASH_PREFIX}${id}-${randomBytes(6).toString("hex")}`);
      // Report filesystem codes without paths, distinguishing failed repairs with and without a preserved pin.
      const moveReason = kept?.pinnedCommit ? "repair-failed" : "repair-failed-unpinned";
      const damaged = (reason: "repair-failed" | "repair-failed-unpinned" | "repair-write-failed", error: unknown) =>
        new MarketplaceError(
          "SOURCE_LOCAL_DATA_DAMAGED",
          reason === "repair-write-failed"
            ? `could not write the kept pin of source ${id} (${fsErrorCode(error)})`
            : `could not move the downloaded copy of source ${id} aside (${fsErrorCode(error)})`,
          { cause: error, detail: { reason, sourceId: id } },
        );
      let entry: Stats | null;
      try {
        entry = await lstat(dir);
      } catch (error) {
        if (!isMissingPathError(error)) throw damaged(moveReason, error);
        entry = null;
      }
      const writeKept = async () => {
        if (!kept) return;
        try {
          // Preserve folder identity so repair cannot hide a moved source.
          await this.writeState(id, { pinnedCommit: kept.pinnedCommit, enabled: kept.enabled, ...(kept.folder ? { folder: kept.folder } : {}) });
        } catch (error) {
          throw damaged("repair-write-failed", error);
        }
      };
      if (entry?.isDirectory() && kept) {
        // Atomically preserve state.json before moving other entries so interruption cannot lose a readable pin.
        await writeKept();
        try {
          await mkdir(trash);
          for (const name of await readdir(dir)) {
            if (name !== "state.json") await this.moveAside(join(dir, name), join(trash, name));
          }
        } catch (error) {
          throw damaged(moveReason, error);
        }
      } else if (entry) {
        // Without a recoverable pin, move the whole entry aside without following links.
        try {
          await this.moveAside(dir, trash);
        } catch (error) {
          throw damaged(moveReason, error);
        }
        await writeKept();
      } else {
        await writeKept();
        return;
      }
      await this.reclaim(trash);
    });
  }

  async acknowledged(source: ResolvedSource): Promise<ReadonlySet<SourceWarning>> {
    if (source.transport === "folder" && source.origin === "managed") return new Set(["network-folder"]);
    if (source.origin === "custom" || source.origin === "direct") return new Set(source.acknowledged ?? []);
    return new Set(confirmationsFor((await this.readState(source.id)).acknowledged, sourceIdentity(source)));
  }

  /** Consent only grows for the same identity; withdrawal requires removing the source. */
  async acknowledge(id: string, warnings: readonly SourceWarning[]): Promise<void> {
    const source = this.get(id);
    if (!source) throw new MarketplaceError("SOURCE_ID_INVALID", `no source named ${id}`);
    const identity = sourceIdentity(source);
    if (source.origin === "official" || source.origin === "managed") {
      // Confirmations given for another address are dropped, not merged.
      await this.updateState(id, (state) => {
        const merged = [...new Set([...confirmationsFor(state.acknowledged, identity), ...warnings])];
        return { ...state, acknowledged: { ...identity, warnings: merged } };
      });
      return;
    }
    await this.exclusive(async () => {
      this.assertWritable();
      const raw = this.storedRaw.get(id);
      if (!isRecord(raw)) throw new Error(`source ${id} has no stored entry`);
      const current = raw.acknowledged === undefined ? [] : confirmationsFor(checkAcknowledged(raw.acknowledged, this.platform), identity);
      const next = { ...raw, acknowledged: { ...identity, warnings: [...new Set([...current, ...warnings])] } };
      await this.writeSources(this.rawEntries.map((entry) => (entry === raw ? next : entry)));
    });
  }

  /** Pins inconsistent with the source transport are damaged state. */
  async readState(id: string): Promise<SourceState> {
    const state = await readSourceState(this.options.root, id, this.platform);
    const source = this.get(id);
    const problem = source ? transportProblem(source, state) : null;
    if (problem) {
      throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `state.json of source ${id} is invalid: ${problem}`, {
        detail: { reason: "state-invalid", sourceId: id },
      });
    }
    return state;
  }

  async writeState(id: string, state: SourceState): Promise<void> {
    const source = this.get(id);
    if (!source) throw new Error(`no source named ${id}`);
    try {
      checkState(state, this.platform);
    } catch (error) {
      throw new Error(`refusing to write an invalid state for ${id}: ${(error as Error).message}`, { cause: error });
    }
    const problem = transportProblem(source, state);
    if (problem) throw new Error(`refusing to write an invalid state for ${id}: ${problem}`);
    await writeFileAtomicAtPath(this.statePath(id), `${JSON.stringify(state, null, 2)}\n`);
  }

  async updateState(id: string, update: (state: SourceState) => SourceState): Promise<SourceState> {
    return this.exclusive(async () => {
      const next = update(await this.readState(id));
      await this.writeState(id, next);
      return next;
    });
  }

  /** Legacy credential-shaped ids are neither served nor synced; session handles permit removal only. */
  isQuarantined(source: ResolvedSource): boolean {
    return !isSourceId(source.id);
  }

  canDisable(source: ResolvedSource): boolean {
    if (this.isQuarantined(source)) return false;
    if (source.origin === "managed") return false;
    if (source.origin === "official") return this.policy.allowDisablingOfficial;
    return true;
  }

  isEnabled(source: ResolvedSource, state: SourceState): boolean {
    return state.enabled || !this.canDisable(source);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const source = this.get(id);
    if (!source) throw new Error(`no source named ${id}`);
    if (!enabled && !this.canDisable(source)) {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the ${source.origin} source ${id} cannot be hidden`);
    }
    await this.updateState(id, (state) => ({ ...state, enabled }));
  }
}

/** Compare canonical path components byte-for-byte; resolution already established on-disk spelling. */
export function folderRelation(path: string, other: string, platform: NodeJS.Platform): "same" | "inside" | "contains" | null {
  const a = splitFolderPath(path, platform);
  const b = splitFolderPath(other, platform);
  if (a.root !== b.root) return null;
  const shared = Math.min(a.segments.length, b.segments.length);
  for (let index = 0; index < shared; index += 1) if (a.segments[index] !== b.segments[index]) return null;
  if (a.segments.length === b.segments.length) return "same";
  return a.segments.length > b.segments.length ? "inside" : "contains";
}

/** Folder overlap is an identity conflict, so choosing another id cannot resolve it. */
function folderOverlap(path: string, existing: FolderSource, relation: "same" | "inside" | "contains"): MarketplaceError {
  switch (relation) {
    case "same":
      return new MarketplaceError("SOURCE_ID_TAKEN", `this folder is already added as ${existing.id}`, {
        detail: { reason: "folder-already-added", path, existingId: existing.id },
      });
    case "inside":
      return new MarketplaceError("SOURCE_ID_TAKEN", `this folder lies inside ${existing.id} (${existing.path})`, {
        detail: { reason: "folder-inside-source", path, existingId: existing.id, existingPath: existing.path },
      });
    case "contains":
      return new MarketplaceError("SOURCE_ID_TAKEN", `this folder contains ${existing.id} (${existing.path})`, {
        detail: { reason: "folder-contains-source", path, existingId: existing.id, existingPath: existing.path },
      });
  }
}

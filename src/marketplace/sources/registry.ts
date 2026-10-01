/**
 * The source registry (design §2.1, §7.2, §7.6, §10.5, §12).
 *
 * Four origins, three homes:
 *   - official: the build constant `OFFICIAL_MARKETPLACE`;
 *   - managed: `marketplaces.additional` in the system policy file;
 *   - custom and direct: `~/.ave/marketplaces/sources.json`.
 * Every origin keeps its pin and switches in `marketplaces/<id>/state.json`.
 *
 * Ids are re-checked on every load: an entry in `sources.json` that uses a
 * reserved id, collides with a managed id, or no longer normalizes is left in
 * the file untouched but not served, with a diagnostic. A `sources.json` that
 * cannot be read at all serves the official and managed sources only, and
 * refuses writes (`SOURCE_LIST_UNREADABLE`) until the user fixes or deletes
 * it, so nothing the user added is overwritten.
 */
import { randomBytes } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { createLogger } from "../../lib/logger.js";
import { renameDirectory } from "../../lib/transient-fs-lock-retry.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
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
import { normalizeSourceHost, normalizeSourceUrl, sameSourceRepository, type NormalizedSourceUrl } from "../net/source-url.js";
import {
  OFFICIAL_MARKETPLACE,
  SOURCE_ID_RE,
  isReservedSourceId,
  isSourceLabel,
  isSourceRef,
  type OfficialMarketplace,
  type SourceAuth,
} from "./official.js";
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicySource } from "./policy.js";
import { isSourceWarning, type SourceWarning } from "./warnings.js";

export type SourceOrigin = "official" | "managed" | "custom" | "direct";

interface SourceEntry {
  id: string;
  origin: "custom" | "direct";
  /** Normalized form (§7.1). */
  url: string;
  ref?: string;
  /** Direct sources only: the package path inside the repository. */
  subdir?: string;
  auth: SourceAuth;
  addedAt: string;
  label?: string;
  /** The confirmations the source holds (design §18.5); absent is none. */
  acknowledged?: SourceWarning[];
}

export interface SourceState {
  pinnedCommit: string | null;
  /** Browsing and installing only; sync continues while installed packages are bound (§7.3). */
  enabled: boolean;
  /** `detail` is why a failed sync failed, when it said (design §18.8). */
  lastSync?: { at: string; result: "ok" | MarketplaceErrorCode; detail?: MarketplaceErrorDetail; candidate?: string };
  pendingRewrite?: { candidate: string; seenAt: string };
  /** Official and managed sources keep their confirmations here; custom and direct ones in `sources.json` (§18.5). */
  acknowledged?: SourceWarning[];
}

export interface ResolvedSource {
  id: string;
  origin: SourceOrigin;
  url: NormalizedSourceUrl;
  /** Official only; tried in order after `url`. */
  mirrors: readonly NormalizedSourceUrl[];
  ref?: string;
  subdir?: string;
  auth: SourceAuth;
  label?: string;
  /** Custom and direct sources: the confirmations stored with the entry; official and managed keep theirs in the state. */
  acknowledged?: readonly SourceWarning[];
}

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
  /** Exactly the confirmations the preview carried (§18.5 step 5). */
  acknowledged?: readonly SourceWarning[];
}

const COMMIT_RE = /^[0-9a-f]{40}$/u;
const ENTRY_KEYS = new Set(["id", "origin", "url", "ref", "subdir", "auth", "addedAt", "label", "acknowledged"]);
const STATE_KEYS = new Set(["pinnedCommit", "enabled", "lastSync", "pendingRewrite", "acknowledged"]);

class RegistryShapeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** A stored list of confirmations: known warnings, each once. */
function checkAcknowledged(value: unknown): SourceWarning[] {
  shape(Array.isArray(value), "acknowledged must be an array");
  shape(value.every(isSourceWarning), "acknowledged holds an unknown confirmation");
  shape(new Set(value).size === value.length, "acknowledged lists a confirmation twice");
  return value as SourceWarning[];
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

/** One stored entry, checked as written; the stored URL must already be normalized. */
function checkEntry(raw: unknown): { entry: SourceEntry; url: NormalizedSourceUrl } {
  shape(isRecord(raw), "entry must be an object");
  knownKeys(raw, ENTRY_KEYS, "entry");
  shape(typeof raw.id === "string" && SOURCE_ID_RE.test(raw.id), "id is not a source id");
  shape(raw.origin === "custom" || raw.origin === "direct", "origin must be custom or direct");
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
  if (raw.acknowledged !== undefined) checkAcknowledged(raw.acknowledged);
  return { entry: { ...(raw as unknown as SourceEntry), auth }, url };
}

function checkState(raw: unknown): SourceState {
  shape(isRecord(raw), "state must be an object");
  knownKeys(raw, STATE_KEYS, "state");
  shape(raw.pinnedCommit === null || (typeof raw.pinnedCommit === "string" && COMMIT_RE.test(raw.pinnedCommit)), "pinnedCommit must be null or a commit id");
  shape(typeof raw.enabled === "boolean", "enabled must be true or false");
  let state = raw;
  if (raw.lastSync !== undefined) {
    const last = raw.lastSync;
    shape(isRecord(last), "lastSync must be an object");
    knownKeys(last, new Set(["at", "result", "detail", "candidate"]), "lastSync");
    shape(isIsoTime(last.at), "lastSync.at must be an ISO-8601 time");
    shape(last.result === "ok" || MARKETPLACE_ERROR_CODES.includes(last.result as MarketplaceErrorCode), "lastSync.result is not a result code");
    shape(last.candidate === undefined || (typeof last.candidate === "string" && COMMIT_RE.test(last.candidate)), "lastSync.candidate must be a commit id");
    if (last.detail !== undefined) {
      // A detail is display data: one this build does not know for the code
      // (written by a newer build, or edited) is dropped, and the code stays.
      const detail = last.result === "ok" ? undefined : parseMarketplaceErrorDetail(last.result as MarketplaceErrorCode, last.detail);
      const { detail: _dropped, ...rest } = last;
      state = { ...raw, lastSync: detail ? { ...rest, detail } : rest };
    }
  }
  if (raw.pendingRewrite !== undefined) {
    const pending = raw.pendingRewrite;
    shape(isRecord(pending), "pendingRewrite must be an object");
    knownKeys(pending, new Set(["candidate", "seenAt"]), "pendingRewrite");
    shape(typeof pending.candidate === "string" && COMMIT_RE.test(pending.candidate), "pendingRewrite.candidate must be a commit id");
    shape(isIsoTime(pending.seenAt), "pendingRewrite.seenAt must be an ISO-8601 time");
  }
  if (raw.acknowledged !== undefined) checkAcknowledged(raw.acknowledged);
  return state as unknown as SourceState;
}

const FRESH_STATE: SourceState = Object.freeze({ pinnedCommit: null, enabled: true });

export interface SourceRegistryOptions {
  /** `~/.ave/marketplaces`. */
  root: string;
  /** Read when the sources are listed: a policy change adds or drops managed sources at the next operation (§18.6). */
  policy: PolicySource;
  /** The build constant; tests substitute a fixture repository. */
  official?: OfficialMarketplace;
  now?: () => Date;
}

/**
 * One source's state under `root`, without opening the registry: boot reads
 * pins before anything else is wired. A missing state is a fresh source
 * unless synced data exists beside it. A state that cannot be used throws
 * SOURCE_LOCAL_DATA_DAMAGED, which Repair clears ({@link SourceRegistry.resetLocalData});
 * its message names files relative to the source, never a home path.
 */
export async function readSourceState(root: string, id: string): Promise<SourceState> {
  const dir = join(root, id);
  let text: string;
  try {
    text = await readFile(join(dir, "state.json"), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      // Synced data without a state lost its pin; a fresh state would accept any history (§2.1).
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
    return checkState(parseStrictJson(text));
  } catch (error) {
    throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", `state.json of source ${id} is invalid: ${errorMessage(error)}`, {
      cause: error,
      detail: { reason: "state-invalid", sourceId: id },
    });
  }
}

const log = createLogger("marketplace-registry");

/** Where Repair moves a source's copy before walking it: `.trash-<id>-<random>` beside the sources. */
const TRASH_PREFIX = ".trash-";

/** A file system error's code (else the error's name), which unlike its message names no path under the user's home. */
export function fsErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Remove a host-owned tree without following a link inside it. Every entry is
 * `lstat`ed and removed one by one, never by a recursive `rm`: on Windows a
 * recursive removal follows a junction and deletes its target. A link (a
 * junction too) is removed as a link, `rmdir` where Windows refuses `unlink`
 * on a directory link. Nothing else writes under `marketplaces/<id>`, and the
 * callers hold the registry's queue.
 */
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
  /** The raw entry each served source came from, so a removal touches only that entry. */
  private storedRaw = new Map<string, unknown>();
  /**
   * Why `sources.json` cannot be used, when it cannot (§14
   * `SOURCE_LIST_UNREADABLE`). Its message names the file and an fs error by
   * its code, never a home path, since it reaches *Copy details*.
   */
  private fileProblem: { message: string; detail: MarketplaceErrorDetail<"SOURCE_LIST_UNREADABLE"> } | null = null;
  private loadDiagnostics: RegistryDiagnostic[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly official: ResolvedSource;
  /** The built-in sources under the policy digest they were built for. */
  private builtFor: { digest: string; sources: ResolvedSource[] } | null = null;

  private constructor(private readonly options: SourceRegistryOptions) {
    const constant = options.official ?? OFFICIAL_MARKETPLACE;
    this.official = {
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

  /** Official, then the policy's managed sources, rebuilt when the policy in force changes. */
  private get builtIn(): ResolvedSource[] {
    const digest = this.options.policy.digest;
    if (this.builtFor?.digest !== digest) {
      // An unreadable policy yields no managed sources; the gate blocks every non-official target then.
      const managed = this.policy.additional.map((spec): ResolvedSource => ({
        id: spec.id,
        origin: "managed",
        url: spec.url,
        mirrors: [],
        ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
        auth: spec.auth,
        ...(spec.label !== undefined ? { label: spec.label } : {}),
      }));
      this.builtFor = { digest, sources: [this.official, ...managed] };
      // The ids a stored entry may use depend on the managed ones.
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

  /**
   * Remove what an interrupted Repair left aside (`.trash-*`; a source id
   * never starts with a dot). Best effort: a leftover only takes disk space,
   * and the next open or Repair tries again.
   */
  private async sweepTrash(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.root);
    } catch (error) {
      // Best effort, so it never fails an open or a Repair: a leftover waits for the next sweep.
      if (!isMissingPathError(error)) log.warn({ error: fsErrorCode(error) }, "repair: could not list the marketplaces folder to sweep moved-aside copies");
      return;
    }
    for (const name of names) {
      if (name.startsWith(TRASH_PREFIX)) await this.reclaim(join(this.options.root, name));
    }
  }

  /** Walk a copy moved aside by Repair; a failure is logged and left for the next sweep. */
  private async reclaim(trash: string): Promise<void> {
    try {
      await removeTreeNoFollow(trash);
    } catch (error) {
      log.warn({ trash: trash.slice(this.options.root.length + 1), error: fsErrorCode(error) }, "repair: could not remove a copy moved aside; the next sweep retries");
    }
  }

  /**
   * One rename (retrying a transient Windows lock), the step an interrupted
   * Repair can stop between (a seam for tests).
   */
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
      let checked: ReturnType<typeof checkEntry>;
      try {
        checked = checkEntry(raw);
      } catch (error) {
        if (!(error instanceof RegistryShapeError)) throw error;
        diagnostics.push({ subject, message: error.message });
        continue;
      }
      const { entry, url } = checked;
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
      stored.push({
        id: entry.id,
        origin: entry.origin,
        url,
        mirrors: [],
        ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
        ...(entry.subdir !== undefined ? { subdir: entry.subdir } : {}),
        auth: entry.auth,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.acknowledged !== undefined ? { acknowledged: [...entry.acknowledged] } : {}),
      });
    }
    this.stored = stored;
    this.storedRaw = storedRaw;
    this.loadDiagnostics = this.fileProblem ? [{ subject: "sources.json", message: this.fileProblem.message }, ...diagnostics] : diagnostics;
  }

  /** Official first, then managed, then custom and direct in file order. */
  list(): ResolvedSource[] {
    return [...this.builtIn, ...this.stored];
  }

  get(id: string): ResolvedSource | undefined {
    return this.list().find((source) => source.id === id);
  }

  diagnostics(): readonly RegistryDiagnostic[] {
    return this.loadDiagnostics;
  }

  /** The id and URL checks of §7.2 step 6, without writing anything. */
  checkNew(source: NewSource): NormalizedSourceUrl {
    if (!SOURCE_ID_RE.test(source.id)) {
      throw new MarketplaceError("SOURCE_ID_INVALID", `${source.id} is not a valid source id (2-63 lowercase letters, digits or -)`);
    }
    if (isReservedSourceId(source.id)) {
      throw new MarketplaceError("SOURCE_NAME_RESERVED", `${source.id} is a reserved source id`);
    }
    // An entry that is not served still owns its id: it stays in the file untouched (§2.1).
    const unserved = this.rawEntries.some((raw) => isRecord(raw) && raw.id === source.id);
    if (unserved || this.list().some((existing) => existing.id === source.id)) {
      throw new MarketplaceError("SOURCE_ID_TAKEN", `a source named ${source.id} already exists`);
    }
    const url = normalizeSourceUrl(source.url);
    const duplicate = this.list().find(
      (existing) => sameSourceRepository(existing.url, url) && (existing.subdir ?? null) === (source.subdir ?? null),
    );
    if (duplicate) {
      throw new MarketplaceError("SOURCE_ID_TAKEN", `this repository is already added as ${duplicate.id}`);
    }
    return url;
  }

  private assertWritable(): void {
    // The file is the user's list: it is never rewritten or repaired here, so nothing they added is lost (§14).
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
        ...(source.acknowledged !== undefined && source.acknowledged.length > 0 ? { acknowledged: [...source.acknowledged] } : {}),
      };
      try {
        checkEntry(entry);
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

  /**
   * Custom and direct only (§7.6). Installed packages stay; their origin keeps
   * the source id. Callers go through `SourceSyncer.removeSource`, which lets a
   * running sync of the source finish first.
   */
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

  /**
   * Repair (design §18.8): move the source's downloaded copy (repository,
   * snapshots, a damaged state) aside to `.trash-<id>-<random>` and walk it
   * there with `lstat`, so the next sync starts it over. Only
   * `marketplaces/<id>` moves; installed packages, tokens, policy and
   * `sources.json` live elsewhere and stay. `kept` is the readable part of
   * the old state, its pin and switch, written back so the history rule and
   * the user's choice survive; without it the source starts unpinned.
   * Writing the pin fails as `repair-write-failed`, moving the copy aside as
   * `repair-failed`; neither loses a readable pin.
   */
  async resetLocalData(id: string, kept: Pick<SourceState, "pinnedCommit" | "enabled"> | null): Promise<void> {
    return this.exclusive(async () => {
      if (!this.get(id)) throw new Error(`no source named ${id}`);
      await this.sweepTrash();
      const dir = join(this.options.root, id);
      const trash = join(this.options.root, `${TRASH_PREFIX}${id}-${randomBytes(6).toString("hex")}`);
      // Messages name the source and an fs error by its code, never a path (the error's own message has one).
      // A failed move says whether a pin is still there to keep (`repair-failed`) or the state had none (`-unpinned`).
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
          await this.writeState(id, { pinnedCommit: kept.pinnedCommit, enabled: kept.enabled });
        } catch (error) {
          throw damaged("repair-write-failed", error);
        }
      };
      if (entry?.isDirectory() && kept) {
        // The kept pin is written first, atomically and in place; everything
        // else then goes aside one rename at a time. `state.json` never
        // leaves, so a failure or crash at any step leaves the pin, and the
        // next sync fetches what is gone.
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
        // The pin is already lost (or the copy is a link Ave did not make):
        // the whole entry goes aside in one rename, a link as a link.
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

  /** The confirmations `source` holds: its entry's for custom and direct sources, its state's for official and managed ones (§18.5). */
  async acknowledged(source: ResolvedSource): Promise<ReadonlySet<SourceWarning>> {
    if (source.origin === "custom" || source.origin === "direct") return new Set(source.acknowledged ?? []);
    return new Set((await this.readState(source.id)).acknowledged ?? []);
  }

  /**
   * Add confirmations to a source (*Allow…*, §18.5): the entry of a custom or
   * direct source, the state of an official or managed one. Confirmations
   * only grow here; withdrawing one is removing the source.
   */
  async acknowledge(id: string, warnings: readonly SourceWarning[]): Promise<void> {
    const source = this.get(id);
    if (!source) throw new MarketplaceError("SOURCE_ID_INVALID", `no source named ${id}`);
    if (source.origin === "official" || source.origin === "managed") {
      await this.updateState(id, (state) => {
        const merged = [...new Set([...(state.acknowledged ?? []), ...warnings])];
        return { ...state, acknowledged: merged };
      });
      return;
    }
    await this.exclusive(async () => {
      this.assertWritable();
      const raw = this.storedRaw.get(id);
      if (!isRecord(raw)) throw new Error(`source ${id} has no stored entry`);
      const current = raw.acknowledged === undefined ? [] : checkAcknowledged(raw.acknowledged);
      const next = { ...raw, acknowledged: [...new Set([...current, ...warnings])] };
      await this.writeSources(this.rawEntries.map((entry) => (entry === raw ? next : entry)));
    });
  }

  async readState(id: string): Promise<SourceState> {
    return readSourceState(this.options.root, id);
  }

  async writeState(id: string, state: SourceState): Promise<void> {
    if (!this.get(id)) throw new Error(`no source named ${id}`);
    try {
      checkState(state);
    } catch (error) {
      throw new Error(`refusing to write an invalid state for ${id}: ${(error as Error).message}`, { cause: error });
    }
    await writeFileAtomicAtPath(this.statePath(id), `${JSON.stringify(state, null, 2)}\n`);
  }

  /** Read-modify-write of one source's state under the registry's lock. */
  async updateState(id: string, update: (state: SourceState) => SourceState): Promise<SourceState> {
    return this.exclusive(async () => {
      const next = update(await this.readState(id));
      await this.writeState(id, next);
      return next;
    });
  }

  /** Whether a source may be hidden at all (§10.5). */
  canDisable(source: ResolvedSource): boolean {
    if (source.origin === "managed") return false;
    if (source.origin === "official") return this.policy.allowDisablingOfficial;
    return true;
  }

  /** The stored switch, overridden where policy forbids hiding the source. */
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

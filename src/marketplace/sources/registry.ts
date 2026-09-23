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
 * refuses writes until it is repaired, so nothing the user added is
 * overwritten.
 */
import { existsSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, isMarketplaceError, type MarketplaceErrorCode } from "../errors.js";
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
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicyLoad } from "./policy.js";

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
}

export interface SourceState {
  pinnedCommit: string | null;
  /** Browsing and installing only; sync continues while installed packages are bound (§7.3). */
  enabled: boolean;
  lastSync?: { at: string; result: "ok" | MarketplaceErrorCode; candidate?: string };
  pendingRewrite?: { candidate: string; seenAt: string };
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
}

const COMMIT_RE = /^[0-9a-f]{40}$/u;
const ENTRY_KEYS = new Set(["id", "origin", "url", "ref", "subdir", "auth", "addedAt", "label"]);
const STATE_KEYS = new Set(["pinnedCommit", "enabled", "lastSync", "pendingRewrite"]);

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
  return { entry: { ...(raw as unknown as SourceEntry), auth }, url };
}

function checkState(raw: unknown): SourceState {
  shape(isRecord(raw), "state must be an object");
  knownKeys(raw, STATE_KEYS, "state");
  shape(raw.pinnedCommit === null || (typeof raw.pinnedCommit === "string" && COMMIT_RE.test(raw.pinnedCommit)), "pinnedCommit must be null or a commit id");
  shape(typeof raw.enabled === "boolean", "enabled must be true or false");
  if (raw.lastSync !== undefined) {
    const last = raw.lastSync;
    shape(isRecord(last), "lastSync must be an object");
    knownKeys(last, new Set(["at", "result", "candidate"]), "lastSync");
    shape(isIsoTime(last.at), "lastSync.at must be an ISO-8601 time");
    shape(last.result === "ok" || MARKETPLACE_ERROR_CODES.includes(last.result as MarketplaceErrorCode), "lastSync.result is not a result code");
    shape(last.candidate === undefined || (typeof last.candidate === "string" && COMMIT_RE.test(last.candidate)), "lastSync.candidate must be a commit id");
  }
  if (raw.pendingRewrite !== undefined) {
    const pending = raw.pendingRewrite;
    shape(isRecord(pending), "pendingRewrite must be an object");
    knownKeys(pending, new Set(["candidate", "seenAt"]), "pendingRewrite");
    shape(typeof pending.candidate === "string" && COMMIT_RE.test(pending.candidate), "pendingRewrite.candidate must be a commit id");
    shape(isIsoTime(pending.seenAt), "pendingRewrite.seenAt must be an ISO-8601 time");
  }
  return raw as unknown as SourceState;
}

const FRESH_STATE: SourceState = Object.freeze({ pinnedCommit: null, enabled: true });

export interface SourceRegistryOptions {
  /** `~/.ave/marketplaces`. */
  root: string;
  policy: PolicyLoad;
  /** The build constant; tests substitute a fixture repository. */
  official?: OfficialMarketplace;
  now?: () => Date;
}

export class SourceRegistry {
  private rawEntries: unknown[] = [];
  private stored: ResolvedSource[] = [];
  /** The raw entry each served source came from, so a removal touches only that entry. */
  private storedRaw = new Map<string, unknown>();
  private fileError: string | null = null;
  private loadDiagnostics: RegistryDiagnostic[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly policy: MarketplacePolicy;
  private readonly builtIn: ResolvedSource[];

  private constructor(private readonly options: SourceRegistryOptions) {
    this.policy = options.policy.ok ? options.policy.policy : EMPTY_MARKETPLACE_POLICY;
    const constant = options.official ?? OFFICIAL_MARKETPLACE;
    const official: ResolvedSource = {
      id: constant.id,
      origin: "official",
      url: normalizeSourceUrl(constant.url),
      mirrors: constant.mirrors.map((mirror) => normalizeSourceUrl(mirror)),
      auth: constant.auth,
    };
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
    this.builtIn = [official, ...managed];
  }

  static async open(options: SourceRegistryOptions): Promise<SourceRegistry> {
    const registry = new SourceRegistry(options);
    await registry.reload();
    return registry;
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
    this.fileError = null;
    this.rawEntries = [];
    let text: string | null = null;
    try {
      text = await readFile(this.sourcesPath, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) this.fileError = `cannot read sources.json: ${(error as Error).message}`;
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
        this.fileError = `sources.json is invalid: ${(error as Error).message}`;
      }
    }
    this.resolveStored();
  }

  private resolveStored(): void {
    const diagnostics: RegistryDiagnostic[] = [];
    const taken = new Map(this.builtIn.map((source) => [source.id, source.origin] as const));
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
      });
    }
    this.stored = stored;
    this.storedRaw = storedRaw;
    this.loadDiagnostics = this.fileError ? [{ subject: "sources.json", message: this.fileError }, ...diagnostics] : diagnostics;
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
    if (this.fileError) throw new Error(`${this.fileError}; repair or remove it before changing sources`);
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
      await rm(join(this.options.root, id), { recursive: true, force: true });
    });
  }

  async readState(id: string): Promise<SourceState> {
    let text: string;
    try {
      text = await readFile(this.statePath(id), "utf8");
    } catch (error) {
      if (isMissingPathError(error)) {
        // Synced data without a state lost its pin; a fresh state would accept any history (§2.1).
        const dir = join(this.options.root, id);
        if (existsSync(join(dir, "repo.git")) || existsSync(join(dir, "snapshots"))) {
          throw new Error(`${this.statePath(id)} is missing while ${dir} holds synced data; remove the directory to start the source over`, { cause: error });
        }
        return { ...FRESH_STATE };
      }
      throw error;
    }
    try {
      return checkState(parseStrictJson(text));
    } catch (error) {
      throw new Error(`${this.statePath(id)} is invalid: ${(error as Error).message}`, { cause: error });
    }
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

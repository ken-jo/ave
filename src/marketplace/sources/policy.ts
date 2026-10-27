/** Only system policy applies; absent restrictions are allowed, malformed restrictions fail closed. */
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, stat as fsStat } from "node:fs/promises";
import { isAdminPolicyFileAbsent, readAdminPolicyFile } from "../../lib/admin-policy-file.js";
import { fileIdentityKey } from "../../lib/file-identity.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { parseStrictJson, StrictJsonError } from "../catalog/strict-json.js";
import { PACKAGE_KINDS, isPackageName, type PackageKind } from "../catalog/types.js";
import { isMarketplaceError } from "../errors.js";
import { normalizeFolderPath } from "../net/source-input.js";
import {
  folderPatternKey,
  matchesFolderPattern,
  matchesSourcePattern,
  normalizeSourceHost,
  normalizeSourceUrl,
  parseSourcePattern,
  sameSourceRepository,
  type NormalizedSourceUrl,
  type PatternTarget,
  type SourcePattern,
} from "../net/source-url.js";
import {
  OFFICIAL_MARKETPLACE,
  SOURCE_ID_RE,
  isReservedSourceId,
  isSourceId,
  isSourceLabel,
  isSourceRef,
  type SourceAuth,
} from "./official.js";
import { isRecord } from "../../shared/is-record.js";

export interface PackageKey {
  kind: PackageKind;
  name: string;
  source: string;
}

/** Managed folder entries confer network-folder consent. */
type ManagedSourceSpec =
  | { transport: "git"; id: string; url: NormalizedSourceUrl; ref?: string; auth: SourceAuth; label?: string }
  | { transport: "folder"; id: string; path: string; label?: string };

export interface MarketplacePolicy {
  /** null = no allow list, every target not blocked is allowed. */
  allow: readonly SourcePattern[] | null;
  block: readonly SourcePattern[];
  allowHttpHosts: ReadonlySet<string>;
  /** HTTPS policy may exempt only allowHttpHosts entries. */
  requireHttps: boolean;
  /** Private-network policy exempts listed hosts. */
  blockPrivateNetworks: boolean;
  allowDirectInstall: boolean;
  allowLocalSources: boolean;
  allowDisablingOfficial: boolean;
  /** Policy on/off locks all package switches; user delegates to user settings. */
  autoUpdate: "user" | "on" | "off";
  additional: readonly ManagedSourceSpec[];
  defaultInstalls: readonly PackageKey[];
  /** Required entries override matching defaults. */
  requiredInstalls: readonly PackageKey[];
}

export type PolicyLoad = { ok: true; policy: MarketplacePolicy; path: string } | { ok: false; error: string; path: string };

export const EMPTY_MARKETPLACE_POLICY: MarketplacePolicy = Object.freeze({
  allow: null,
  block: Object.freeze([]),
  allowHttpHosts: new Set<string>(),
  requireHttps: false,
  blockPrivateNetworks: false,
  allowDirectInstall: true,
  allowLocalSources: true,
  allowDisablingOfficial: false,
  autoUpdate: "user",
  additional: Object.freeze([]),
  defaultInstalls: Object.freeze([]),
  requiredInstalls: Object.freeze([]),
});

const SECTION_KEYS = new Set([
  "allow",
  "block",
  "allowHttpHosts",
  "requireHttps",
  "blockPrivateNetworks",
  "allowDirectInstall",
  "allowLocalSources",
  "allowDisablingOfficial",
  "autoUpdate",
  "additional",
  "defaultInstalls",
  "requiredInstalls",
]);
const ADDITIONAL_KEYS = new Set(["id", "url", "path", "ref", "auth", "label"]);
const PACKAGE_KEY_KEYS = new Set(["kind", "name", "source"]);

class PolicyShapeError extends Error {}

function fail(path: string, message: string): never {
  throw new PolicyShapeError(`marketplaces${path}: ${message}`);
}

function record(value: unknown, path: string, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`${path}.${key}`, "is not a known key");
  }
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(path, "must be an array of strings");
  return value as string[];
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(path, "must be true or false");
  return value;
}

function parsed<T>(path: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (isMarketplaceError(error)) fail(path, error.message);
    throw error;
  }
}

function patterns(value: unknown, path: string): SourcePattern[] {
  return stringList(value, path).map((text, index) => parsed(`${path}[${index}]`, () => parseSourcePattern(text)));
}

function auth(value: unknown, path: string, url: NormalizedSourceUrl): SourceAuth {
  if (value === undefined) return url.scheme === "ssh" ? { kind: "ssh" } : { kind: "none" };
  const entry = isRecord(value) ? value : fail(path, "must be an object");
  if (entry.kind === "none" || entry.kind === "ssh") {
    record(entry, path, new Set(["kind"]));
    if ((entry.kind === "ssh") !== (url.scheme === "ssh")) fail(path, `kind ${entry.kind} does not fit a ${url.scheme} URL`);
    return { kind: entry.kind };
  }
  if (entry.kind === "token") {
    record(entry, path, new Set(["kind", "host"]));
    if (url.scheme === "ssh") fail(path, "token auth needs an http(s) URL");
    if (typeof entry.host !== "string") fail(`${path}.host`, "must be a string");
    const host = parsed(`${path}.host`, () => normalizeSourceHost(entry.host as string, entry.host as string));
    // Offer source tokens only to the source own host.
    if (host !== url.host) fail(`${path}.host`, `must be the source's host ${url.host}`);
    return { kind: "token", host };
  }
  return fail(`${path}.kind`, "must be none, token or ssh");
}

/** Contradictory required sources for one package invalidate the policy. */
function packageKeys(value: unknown, path: string, sourceIds: ReadonlySet<string>, oneSourcePerPackage = false): PackageKey[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const seen = new Set<string>();
  const byPackage = new Map<string, { at: string; source: string }>();
  return value.map((item, index) => {
    const at = `${path}[${index}]`;
    const entry = record(item, at, PACKAGE_KEY_KEYS);
    if (!PACKAGE_KINDS.includes(entry.kind as PackageKind)) fail(`${at}.kind`, "is not a package kind");
    if (!isPackageName(entry.name)) {
      fail(`${at}.name`, "is not a package name");
    }
    if (typeof entry.source !== "string" || !sourceIds.has(entry.source)) {
      fail(`${at}.source`, "must name the official source or an additional source");
    }
    const key = `${entry.kind}/${entry.name}@${entry.source}`;
    if (seen.has(key)) fail(at, `${key} is listed twice`);
    seen.add(key);
    const named = `${entry.kind}/${entry.name}`;
    const earlier = byPackage.get(named);
    if (oneSourcePerPackage && earlier) {
      fail(at, `requires ${named} from ${entry.source}, but marketplaces${path}[${earlier.at}] requires it from ${earlier.source}; a package is installed from one source`);
    }
    byPackage.set(named, { at: String(index), source: entry.source });
    return { kind: entry.kind as PackageKind, name: entry.name, source: entry.source };
  });
}

export function policyBlock(
  policy: MarketplacePolicy,
  url: NormalizedSourceUrl,
  target: PatternTarget = "repository",
): { reason: "blocked-by-pattern"; pattern: string } | { reason: "not-in-allow-list" } | null {
  const blocked = policy.block.find((pattern) => matchesSourcePattern(url, pattern, target));
  if (blocked) return { reason: "blocked-by-pattern", pattern: blocked.text };
  if (policy.allow !== null && !policy.allow.some((pattern) => matchesSourcePattern(url, pattern, target))) return { reason: "not-in-allow-list" };
  return null;
}

export function isBlockedByPolicy(policy: MarketplacePolicy, url: NormalizedSourceUrl, target: PatternTarget = "repository"): boolean {
  return policyBlock(policy, url, target) !== null;
}

/** Check lexical and canonical folder paths; allow is case-sensitive and block is not. */
export function folderPolicyBlock(
  policy: MarketplacePolicy,
  path: string,
): { reason: "local-sources-blocked" } | { reason: "blocked-by-pattern"; pattern: string } | { reason: "not-in-allow-list" } | null {
  if (!policy.allowLocalSources) return { reason: "local-sources-blocked" };
  const blocked = policy.block.find((pattern) => pattern.kind === "path" && matchesFolderPattern(path, pattern, "block"));
  if (blocked) return { reason: "blocked-by-pattern", pattern: blocked.text };
  if (policy.allow !== null && !policy.allow.some((pattern) => pattern.kind === "path" && matchesFolderPattern(path, pattern, "allow"))) {
    return { reason: "not-in-allow-list" };
  }
  return null;
}

/** An absent key is the empty list; `null` is a typo, not "nothing". */
function orEmpty(value: unknown): unknown {
  return value === undefined ? [] : value;
}

/** Missing autoUpdate means user; unknown values invalidate the section. */
function autoUpdateRule(value: unknown): MarketplacePolicy["autoUpdate"] {
  if (value === undefined) return "user";
  if (value === "user" || value === "on" || value === "off") return value;
  return fail(".autoUpdate", 'must be "user", "on" or "off"');
}

function parseSection(value: unknown, platform: NodeJS.Platform): MarketplacePolicy {
  const section = record(value, "", SECTION_KEYS);
  const allowHttpHosts = new Set(
    stringList(orEmpty(section.allowHttpHosts), ".allowHttpHosts").map((host, index) =>
      parsed(`.allowHttpHosts[${index}]`, () => normalizeSourceHost(host, host)),
    ),
  );
  const policy: MarketplacePolicy = {
    allow: section.allow === undefined ? null : patterns(section.allow, ".allow"),
    block: patterns(orEmpty(section.block), ".block"),
    allowHttpHosts,
    requireHttps: bool(section.requireHttps, ".requireHttps", false),
    blockPrivateNetworks: bool(section.blockPrivateNetworks, ".blockPrivateNetworks", false),
    allowDirectInstall: bool(section.allowDirectInstall, ".allowDirectInstall", true),
    allowLocalSources: bool(section.allowLocalSources, ".allowLocalSources", true),
    allowDisablingOfficial: bool(section.allowDisablingOfficial, ".allowDisablingOfficial", false),
    autoUpdate: autoUpdateRule(section.autoUpdate),
    additional: [],
    defaultInstalls: [],
    requiredInstalls: [],
  };

  const official = normalizeSourceUrl(OFFICIAL_MARKETPLACE.url);
  const additional: ManagedSourceSpec[] = [];
  if (section.additional !== undefined && !Array.isArray(section.additional)) fail(".additional", "must be an array");
  for (const [index, item] of ((section.additional as unknown[] | undefined) ?? []).entries()) {
    const at = `.additional[${index}]`;
    const entry = record(item, at, ADDITIONAL_KEYS);
    if (typeof entry.id !== "string" || !SOURCE_ID_RE.test(entry.id)) fail(`${at}.id`, "is not a source id");
    if (!isSourceId(entry.id)) fail(`${at}.id`, "looks like a password or token; choose another id");
    if (isReservedSourceId(entry.id)) fail(`${at}.id`, `${entry.id} is reserved`);
    if (additional.some((other) => other.id === entry.id)) fail(`${at}.id`, `${entry.id} is used twice`);
    if (entry.label !== undefined && !isSourceLabel(entry.label)) {
      fail(`${at}.label`, "must be 1-100 printable characters");
    }
    if (entry.path !== undefined) {
      additional.push(managedFolder(entry, at, policy, additional, platform));
      continue;
    }
    if (typeof entry.url !== "string") fail(`${at}.url`, "must be a string");
    const url = parsed(`${at}.url`, () => normalizeSourceUrl(entry.url as string));
    // Additional-source listing does not bypass requireHttps without allowHttpHosts.
    if (url.scheme === "http" && policy.requireHttps && !allowHttpHosts.has(url.host)) {
      fail(`${at}.url`, `plain http while requireHttps is true needs ${url.host} in allowHttpHosts`);
    }
    if (isBlockedByPolicy(policy, url)) fail(`${at}.url`, "is blocked by this policy's own allow/block lists");
    if (sameSourceRepository(url, official) || additional.some((other) => other.transport === "git" && sameSourceRepository(url, other.url))) {
      fail(`${at}.url`, "names a repository that is already a source");
    }
    if (entry.ref !== undefined && !isSourceRef(entry.ref)) {
      fail(`${at}.ref`, "is not a branch or tag name");
    }
    additional.push({
      transport: "git",
      id: entry.id,
      url,
      ...(entry.ref !== undefined ? { ref: entry.ref as string } : {}),
      auth: auth(entry.auth, `${at}.auth`, url),
      ...(entry.label !== undefined ? { label: entry.label as string } : {}),
    });
  }

  const sourceIds = new Set([OFFICIAL_MARKETPLACE.id, ...additional.map((spec) => spec.id)]);
  const required = packageKeys(orEmpty(section.requiredInstalls), ".requiredInstalls", sourceIds, true);
  const requiredKeys = new Set(required.map((key) => `${key.kind}/${key.name}@${key.source}`));
  const defaults = packageKeys(orEmpty(section.defaultInstalls), ".defaultInstalls", sourceIds).filter(
    (key) => !requiredKeys.has(`${key.kind}/${key.name}@${key.source}`),
  );
  return { ...policy, additional, defaultInstalls: defaults, requiredInstalls: required };
}

/** Managed folders cannot use refs, subdirs, auth, home expansion or overlapping folder roots. */
function managedFolder(
  entry: Record<string, unknown>,
  at: string,
  policy: MarketplacePolicy,
  additional: readonly ManagedSourceSpec[],
  platform: NodeJS.Platform,
): ManagedSourceSpec {
  if (entry.url !== undefined) fail(at, "takes url or path, not both");
  if (entry.ref !== undefined) fail(`${at}.ref`, "a folder has no branch or tag");
  if (entry.auth !== undefined) fail(`${at}.auth`, "a folder has no sign-in");
  if (!policy.allowLocalSources) fail(`${at}.path`, "a folder source while allowLocalSources is false");
  if (typeof entry.path !== "string") fail(`${at}.path`, "must be a string");
  if (entry.path.trim().startsWith("~")) fail(`${at}.path`, "must be an absolute path; ~ names no home in the system policy");
  const path = parsed(`${at}.path`, () => normalizeFolderPath(entry.path as string, platform, ""));
  if (folderPolicyBlock(policy, path)) fail(`${at}.path`, "is blocked by this policy's own allow/block lists");
  const key = folderPatternKey(path);
  for (const other of additional) {
    if (other.transport !== "folder") continue;
    const otherKey = folderPatternKey(other.path);
    if (key === otherKey || key.startsWith(`${otherKey.replace(/\/$/u, "")}/`) || otherKey.startsWith(`${key.replace(/\/$/u, "")}/`)) {
      fail(`${at}.path`, `is, contains or lies inside the folder of ${other.id}`);
    }
  }
  return { transport: "folder", id: entry.id as string, path, ...(entry.label !== undefined ? { label: entry.label as string } : {}) };
}

function parsePolicyText(path: string, text: string, platform: NodeJS.Platform): PolicyLoad {
  try {
    const file = parseStrictJson(text);
    if (!isRecord(file)) return { ok: false, error: `${path}: the policy file must be a JSON object`, path };
    if (file.marketplaces === undefined) return { ok: true, policy: EMPTY_MARKETPLACE_POLICY, path };
    return { ok: true, policy: parseSection(file.marketplaces, platform), path };
  } catch (error) {
    if (error instanceof PolicyShapeError || error instanceof StrictJsonError) {
      return { ok: false, error: `${path}: ${error.message}`, path };
    }
    throw error;
  }
}

type PolicyFileStat = Pick<BigIntStats, "size" | "mtimeMs" | "ctimeMs" | "mtimeNs" | "ctimeNs" | "ino" | "dev">;

/** Filesystem and clock seams let tests expose rewrites within a single timestamp tick. */
export interface PolicyFileAccess {
  stat(path: string): Promise<PolicyFileStat>;
  lstat(path: string): Promise<unknown>;
  readFile(path: string): Promise<string>;
  now(): number;
}

const NODE_FILE_ACCESS: PolicyFileAccess = {
  stat: (path) => fsStat(path, { bigint: true }),
  lstat: (path) => lstat(path),
  readFile: async (path) => (await readAdminPolicyFile(path)).toString("utf8"),
  now: () => Date.now(),
};

/** Trust stat equality only after the coarse-timestamp window and reject future or backward clock readings.
 * Rewrites beyond the clock-skew bound may remain unnoticed until a compared field changes. */
const RACY_WINDOW_MS = 3_000;

interface PolicyRead {
  load: PolicyLoad;
  /** Digest is sha256, absent, or unreadable:<code>, never an error path. */
  digest: string;
  /** Null forces another read after a racy timestamp, read failure or unapplied-stat update. */
  stat: RecordedStat | null;
}

interface RecordedStat {
  key: string;
  readBegan: number;
}

/** Size, times and identity detect rewrites, permissions and replacements only outside the racy window. */
function statKey(info: PolicyFileStat): string {
  return `${fileIdentityKey(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Same-tick rewrites can preserve every stat field. */
function isRacy(info: PolicyFileStat, readBegan: number): boolean {
  const latest = info.ctimeMs > info.mtimeMs ? info.ctimeMs : info.mtimeMs;
  return latest > BigInt(Math.floor(readBegan - RACY_WINDOW_MS));
}

async function policyStat(path: string, access: PolicyFileAccess): Promise<string> {
  try {
    return statKey(await access.stat(path));
  } catch (error) {
    if (await isAdminPolicyFileAbsent(path, error, (file) => access.lstat(file))) return "absent";
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

async function readPolicy(path: string, platform: NodeJS.Platform, access: PolicyFileAccess = NODE_FILE_ACCESS): Promise<PolicyRead> {
  const began = access.now();
  let text: string;
  let info: PolicyFileStat;
  try {
    info = await access.stat(path);
    text = await access.readFile(path);
  } catch (error) {
    if (await isAdminPolicyFileAbsent(path, error, (file) => access.lstat(file))) {
      return { load: { ok: true, policy: EMPTY_MARKETPLACE_POLICY, path }, digest: "absent", stat: { key: "absent", readBegan: began } };
    }
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    // A file that could not be read is read again each time.
    return { load: { ok: false, error: `cannot read ${path}: ${(error as Error).message}`, path }, digest: `unreadable:${code}`, stat: null };
  }
  return {
    load: parsePolicyText(path, text, platform),
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    stat: (access === NODE_FILE_ACCESS && process.platform === "win32") || isRacy(info, began) ? null : { key: statKey(info), readBegan: began },
  };
}

export async function loadMarketplacePolicy(
  path: string = getAdminPolicyPath(),
  platform: NodeJS.Platform = process.platform,
): Promise<PolicyLoad> {
  return (await readPolicy(path, platform)).load;
}

export interface PolicyUpdate {
  readonly load: PolicyLoad;
  readonly digest: string;
}

/** All consumers share the applied policy; the service serializes checks and exclusive-lock application. */
export interface PolicySource {
  readonly load: PolicyLoad;
  /** A changed content digest expires plans made under the previous policy. */
  readonly digest: string;
  check(): Promise<PolicyUpdate | null>;
  apply(update: PolicyUpdate): void;
}

/** Re-read unless identity and timestamps came from a read safely after the last change. */
export class FilePolicySource implements PolicySource {
  private current: PolicyRead;

  private constructor(
    private readonly path: string,
    private readonly access: PolicyFileAccess,
    private readonly platform: NodeJS.Platform,
    first: PolicyRead,
  ) {
    this.current = first;
  }

  static async open(
    path: string = getAdminPolicyPath(),
    access: PolicyFileAccess = NODE_FILE_ACCESS,
    platform: NodeJS.Platform = process.platform,
  ): Promise<FilePolicySource> {
    return new FilePolicySource(path, access, platform, await readPolicy(path, platform, access));
  }

  get load(): PolicyLoad {
    return this.current.load;
  }

  get digest(): string {
    return this.current.digest;
  }

  async check(): Promise<PolicyUpdate | null> {
    const base = this.current;
    // Equal stats are trustworthy only outside the racy window and without a backward clock step.
    const recorded = base.stat;
    if (recorded !== null && this.access.now() >= recorded.readBegan && (await policyStat(this.path, this.access)) === recorded.key) {
      return null;
    }
    const next = await readPolicy(this.path, this.platform, this.access);
    if (next.digest === base.digest) {
      // Unchanged content needs no apply, but record fresh times for the next check.
      this.current = { ...base, stat: next.stat };
      return null;
    }
    return { load: next.load, digest: next.digest };
  }

  apply(update: PolicyUpdate): void {
    this.current = { load: update.load, digest: update.digest, stat: null };
  }
}

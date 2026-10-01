/**
 * The `marketplaces` section of the system policy file (design §12).
 *
 * Only the system-scope file counts: it is owned by the machine's
 * administrator, which no git repository and no user-level process can
 * write. A missing file or a file without the section means "no
 * restrictions". A section that cannot be read exactly as written — bad
 * JSON, duplicate keys, an unknown key, a pattern that does not parse —
 * fails closed: the caller treats every non-official source as
 * `SOURCE_POLICY_BLOCKED` rather than guessing what a typo meant.
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat as fsStat } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { parseStrictJson, StrictJsonError } from "../catalog/strict-json.js";
import { PACKAGE_KINDS, isPackageName, type PackageKind } from "../catalog/types.js";
import { isMarketplaceError } from "../errors.js";
import {
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
  isSourceLabel,
  isSourceRef,
  type SourceAuth,
} from "./official.js";

export interface PackageKey {
  kind: PackageKind;
  name: string;
  source: string;
}

/** A source pre-registered by `marketplaces.additional` (origin `managed`). */
interface ManagedSourceSpec {
  id: string;
  url: NormalizedSourceUrl;
  ref?: string;
  auth: SourceAuth;
  label?: string;
}

export interface MarketplacePolicy {
  /** null = no allow list, every target not blocked is allowed. */
  allow: readonly SourcePattern[] | null;
  block: readonly SourcePattern[];
  /** Normalized hosts that may be reached over plain http. */
  allowHttpHosts: ReadonlySet<string>;
  /** Plain http is a policy block, `allowHttpHosts` excepted (design §18.6). */
  requireHttps: boolean;
  /** Internal and this-computer targets are a policy block, policy-listed hosts excepted (§18.6). */
  blockPrivateNetworks: boolean;
  allowDirectInstall: boolean;
  allowDisablingOfficial: boolean;
  additional: readonly ManagedSourceSpec[];
  defaultInstalls: readonly PackageKey[];
  /** A key listed in both lists appears here only (§12). */
  requiredInstalls: readonly PackageKey[];
}

/** The policy file's `marketplaces` section, or why it cannot be used; `path` is the file it came from, named in policy messages (§18.8). */
export type PolicyLoad = { ok: true; policy: MarketplacePolicy; path: string } | { ok: false; error: string; path: string };

export const EMPTY_MARKETPLACE_POLICY: MarketplacePolicy = Object.freeze({
  allow: null,
  block: Object.freeze([]),
  allowHttpHosts: new Set<string>(),
  requireHttps: false,
  blockPrivateNetworks: false,
  allowDirectInstall: true,
  allowDisablingOfficial: false,
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
  "allowDisablingOfficial",
  "additional",
  "defaultInstalls",
  "requiredInstalls",
]);
const ADDITIONAL_KEYS = new Set(["id", "url", "ref", "auth", "label"]);
const PACKAGE_KEY_KEYS = new Set(["kind", "name", "source"]);

class PolicyShapeError extends Error {}

function fail(path: string, message: string): never {
  throw new PolicyShapeError(`marketplaces${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Parse errors from source-url.ts carry the offending text; keep them. */
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
    // The token is only ever offered to the source's own host (§12).
    if (host !== url.host) fail(`${path}.host`, `must be the source's host ${url.host}`);
    return { kind: "token", host };
  }
  return fail(`${path}.kind`, "must be none, token or ssh");
}

function packageKeys(value: unknown, path: string, sourceIds: ReadonlySet<string>): PackageKey[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const seen = new Set<string>();
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
    return { kind: entry.kind as PackageKind, name: entry.name, source: entry.source };
  });
}

/** Why the policy blocks `url`: the first `block` pattern it matches, or an `allow` list it is not on; null when it does not. */
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

/** An absent key is the empty list; `null` is a typo, not "nothing". */
function orEmpty(value: unknown): unknown {
  return value === undefined ? [] : value;
}

/** Parse the `marketplaces` value (not the whole file); throws on anything it cannot read exactly. */
function parseSection(value: unknown): MarketplacePolicy {
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
    allowDisablingOfficial: bool(section.allowDisablingOfficial, ".allowDisablingOfficial", false),
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
    if (isReservedSourceId(entry.id)) fail(`${at}.id`, `${entry.id} is reserved`);
    if (additional.some((other) => other.id === entry.id)) fail(`${at}.id`, `${entry.id} is used twice`);
    if (typeof entry.url !== "string") fail(`${at}.url`, "must be a string");
    const url = parsed(`${at}.url`, () => normalizeSourceUrl(entry.url as string));
    // An additional source is itself a listing (§18.2.2): plain http needs no other entry, unless the
    // same policy requires https, which only allowHttpHosts excepts.
    if (url.scheme === "http" && policy.requireHttps && !allowHttpHosts.has(url.host)) {
      fail(`${at}.url`, `plain http while requireHttps is true needs ${url.host} in allowHttpHosts`);
    }
    if (isBlockedByPolicy(policy, url)) fail(`${at}.url`, "is blocked by this policy's own allow/block lists");
    if (sameSourceRepository(url, official) || additional.some((other) => sameSourceRepository(url, other.url))) {
      fail(`${at}.url`, "names a repository that is already a source");
    }
    if (entry.ref !== undefined && !isSourceRef(entry.ref)) {
      fail(`${at}.ref`, "is not a branch or tag name");
    }
    if (entry.label !== undefined && !isSourceLabel(entry.label)) {
      fail(`${at}.label`, "must be 1-100 printable characters");
    }
    additional.push({
      id: entry.id,
      url,
      ...(entry.ref !== undefined ? { ref: entry.ref as string } : {}),
      auth: auth(entry.auth, `${at}.auth`, url),
      ...(entry.label !== undefined ? { label: entry.label as string } : {}),
    });
  }

  const sourceIds = new Set([OFFICIAL_MARKETPLACE.id, ...additional.map((spec) => spec.id)]);
  const required = packageKeys(orEmpty(section.requiredInstalls), ".requiredInstalls", sourceIds);
  const requiredKeys = new Set(required.map((key) => `${key.kind}/${key.name}@${key.source}`));
  const defaults = packageKeys(orEmpty(section.defaultInstalls), ".defaultInstalls", sourceIds).filter(
    (key) => !requiredKeys.has(`${key.kind}/${key.name}@${key.source}`),
  );
  return { ...policy, additional, defaultInstalls: defaults, requiredInstalls: required };
}

/** The `marketplaces` section of a policy file's text; a file problem is a result, only a bug throws. */
function parsePolicyText(path: string, text: string): PolicyLoad {
  try {
    const file = parseStrictJson(text);
    if (!isRecord(file)) return { ok: false, error: `${path}: the policy file must be a JSON object`, path };
    if (file.marketplaces === undefined) return { ok: true, policy: EMPTY_MARKETPLACE_POLICY, path };
    return { ok: true, policy: parseSection(file.marketplaces), path };
  } catch (error) {
    if (error instanceof PolicyShapeError || error instanceof StrictJsonError) {
      return { ok: false, error: `${path}: ${error.message}`, path };
    }
    throw error;
  }
}

/** The stat fields {@link statKey} compares. */
type PolicyFileStat = Pick<Stats, "size" | "mtimeMs" | "ctimeMs" | "ino" | "dev">;

/**
 * The file system and clock a {@link FilePolicySource} reads through. Production
 * uses node's; a test substitutes a file system whose clock did not tick
 * between two writes, which real file systems do only by timing luck.
 */
export interface PolicyFileAccess {
  stat(path: string): Promise<PolicyFileStat>;
  readFile(path: string): Promise<string>;
  /** Wall-clock milliseconds: the clock the file's times are stamped from. */
  now(): number;
}

const NODE_FILE_ACCESS: PolicyFileAccess = {
  stat: (path) => fsStat(path),
  readFile: (path) => readFile(path, "utf8"),
  now: () => Date.now(),
};

/**
 * How long after the file's last change a read must begin before the stat it
 * recorded is trusted to tell the next change apart. File times are stamped
 * from a coarse clock: one kernel tick on NTFS (15.6 ms by default) and Linux,
 * two seconds for a FAT modification time, the server's clock on SMB and NFS.
 * A rewrite in the same tick as the change the read saw keeps every recorded
 * time, and with the size kept and the modification time put back the stat is
 * identical. A write that lands after a read began is stamped no earlier than
 * that moment, less one tick, less how far the writer's clock lags this one,
 * less how far this clock has stepped back since; while those three together
 * stay under the window, a change older than the window cannot be stamped
 * again. Three seconds covers the two-second FAT tick with a second for lag
 * and steps. A change time ahead of the clock (skew, or a modification time
 * set forward) is always racy, and a check that finds the clock behind the
 * moment the recorded read began does not trust the stat. Outside these
 * bounds a rewrite can be noticed late: at the next change that moves the
 * compared fields.
 */
const RACY_WINDOW_MS = 3_000;

/** One read of the policy file: its load, and the digest that names its content (§18.6). */
interface PolicyRead {
  load: PolicyLoad;
  /** sha256 of the file, `absent` without one, `unreadable:<code>` when it cannot be read. */
  digest: string;
  /**
   * The file's identity and change times when read (see {@link statKey}), for
   * the next comparison, with the moment that read began; null when they
   * cannot tell the next change apart and the next check must read the file
   * again: the read was racy ({@link RACY_WINDOW_MS}), the file could not be
   * read, or the policy in force came from an applied update.
   */
  stat: RecordedStat | null;
}

interface RecordedStat {
  key: string;
  /** `now()` when the read that recorded `key` began. */
  readBegan: number;
}

/**
 * What tells a rewrite, a replacement or a permission change apart without
 * reading the file: size, modification and status-change times, and the
 * file's identity. `chmod` changes only the status-change time, and a file
 * renamed into place has a new inode. Trusted only for a read that began
 * clearly after the file's last change ({@link RACY_WINDOW_MS}).
 */
function statKey(info: PolicyFileStat): string {
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.dev}`;
}

/** The file changed so close to `readBegan` (or after it) that a rewrite in the same clock tick would leave its stat unchanged. */
function isRacy(info: PolicyFileStat, readBegan: number): boolean {
  return Math.max(info.ctimeMs, info.mtimeMs) > readBegan - RACY_WINDOW_MS;
}

async function policyStat(path: string, access: PolicyFileAccess): Promise<string> {
  try {
    return statKey(await access.stat(path));
  } catch (error) {
    if (isMissingPathError(error)) return "absent";
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

async function readPolicy(path: string, access: PolicyFileAccess = NODE_FILE_ACCESS): Promise<PolicyRead> {
  const began = access.now();
  let text: string;
  let info: PolicyFileStat;
  try {
    info = await access.stat(path);
    text = await access.readFile(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { load: { ok: true, policy: EMPTY_MARKETPLACE_POLICY, path }, digest: "absent", stat: { key: "absent", readBegan: began } };
    }
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    // A file that could not be read is read again each time.
    return { load: { ok: false, error: `cannot read ${path}: ${(error as Error).message}`, path }, digest: `unreadable:${code}`, stat: null };
  }
  return {
    load: parsePolicyText(path, text),
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    stat: isRacy(info, began) ? null : { key: statKey(info), readBegan: began },
  };
}

/** Read the system policy file's `marketplaces` section. A file problem is a result; only a bug throws. */
export async function loadMarketplacePolicy(path: string = getAdminPolicyPath()): Promise<PolicyLoad> {
  return (await readPolicy(path)).load;
}

/** A newer read of the policy, not yet in force. */
export interface PolicyUpdate {
  readonly load: PolicyLoad;
  readonly digest: string;
}

/**
 * Where every part of the marketplace reads the managed policy (design
 * §18.6): the gate, the registry's managed sources and the installers read
 * {@link PolicySource.load} when they need it, so one {@link PolicySource.apply}
 * changes all of them at once. The service refreshes it before every
 * operation through one queue: one check at a time, its update applied under
 * the exclusive operation lock before the next check begins (§12). A source
 * relies on that order and keeps none of its own.
 */
export interface PolicySource {
  /** The policy in force. */
  readonly load: PolicyLoad;
  /** Names the content `load` came from; a plan made under one digest expires under another. */
  readonly digest: string;
  /** Read the file again: the update when its content differs from the policy in force, else null. */
  check(): Promise<PolicyUpdate | null>;
  /** Put the update the last check returned in force. */
  apply(update: PolicyUpdate): void;
}

/**
 * The system policy file as a {@link PolicySource}: compared by identity,
 * change times and sha256 at each check, the times trusted only when the last
 * read began clearly after the file's last change ({@link RACY_WINDOW_MS}).
 */
export class FilePolicySource implements PolicySource {
  private current: PolicyRead;

  private constructor(
    private readonly path: string,
    private readonly access: PolicyFileAccess,
    first: PolicyRead,
  ) {
    this.current = first;
  }

  static async open(path: string = getAdminPolicyPath(), access: PolicyFileAccess = NODE_FILE_ACCESS): Promise<FilePolicySource> {
    return new FilePolicySource(path, access, await readPolicy(path, access));
  }

  get load(): PolicyLoad {
    return this.current.load;
  }

  get digest(): string {
    return this.current.digest;
  }

  async check(): Promise<PolicyUpdate | null> {
    const base = this.current;
    // Unchanged identity and change times, recorded by a read that was not racy: the file was not written,
    // replaced or re-permissioned since that read. A clock now behind that read has stepped back, and a write
    // since may carry the recorded times again.
    const recorded = base.stat;
    if (recorded !== null && this.access.now() >= recorded.readBegan && (await policyStat(this.path, this.access)) === recorded.key) {
      return null;
    }
    const next = await readPolicy(this.path, this.access);
    if (next.digest === base.digest) {
      // Same content, perhaps touched: nothing to apply; the next check compares against these times.
      this.current = { ...base, stat: next.stat };
      return null;
    }
    return { load: next.load, digest: next.digest };
  }

  apply(update: PolicyUpdate): void {
    // The next check reads the file again and records its identity and times.
    this.current = { load: update.load, digest: update.digest, stat: null };
  }
}

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
import { readFile } from "node:fs/promises";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { parseStrictJson, StrictJsonError } from "../catalog/strict-json.js";
import { PACKAGE_KINDS, type PackageKind } from "../catalog/types.js";
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
  allowDirectInstall: boolean;
  allowDisablingOfficial: boolean;
  additional: readonly ManagedSourceSpec[];
  defaultInstalls: readonly PackageKey[];
  /** A key listed in both lists appears here only (§12). */
  requiredInstalls: readonly PackageKey[];
}

export type PolicyLoad = { ok: true; policy: MarketplacePolicy } | { ok: false; error: string };

export const EMPTY_MARKETPLACE_POLICY: MarketplacePolicy = Object.freeze({
  allow: null,
  block: Object.freeze([]),
  allowHttpHosts: new Set<string>(),
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
  "allowDirectInstall",
  "allowDisablingOfficial",
  "additional",
  "defaultInstalls",
  "requiredInstalls",
]);
const ADDITIONAL_KEYS = new Set(["id", "url", "ref", "auth", "label"]);
const PACKAGE_KEY_KEYS = new Set(["kind", "name", "source"]);
const PACKAGE_NAME_RE = /^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$/u;

/** A package name as the descriptor schema defines it (`definitions.packageName`). */
export function isPackageName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 64 && PACKAGE_NAME_RE.test(value);
}

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

export function isBlockedByPolicy(policy: MarketplacePolicy, url: NormalizedSourceUrl, target: PatternTarget = "repository"): boolean {
  if (policy.block.some((pattern) => matchesSourcePattern(url, pattern, target))) return true;
  return policy.allow !== null && !policy.allow.some((pattern) => matchesSourcePattern(url, pattern, target));
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
    if (url.scheme === "http" && !allowHttpHosts.has(url.host)) fail(`${at}.url`, `plain http needs ${url.host} in allowHttpHosts`);
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

/** Read the system policy file's `marketplaces` section. A file problem is a result; only a bug throws. */
export async function loadMarketplacePolicy(path: string = getAdminPolicyPath()): Promise<PolicyLoad> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { ok: true, policy: EMPTY_MARKETPLACE_POLICY };
    return { ok: false, error: `cannot read ${path}: ${(error as Error).message}` };
  }
  try {
    const file = parseStrictJson(text);
    if (!isRecord(file)) return { ok: false, error: `${path}: the policy file must be a JSON object` };
    if (file.marketplaces === undefined) return { ok: true, policy: EMPTY_MARKETPLACE_POLICY };
    return { ok: true, policy: parseSection(file.marketplaces) };
  } catch (error) {
    if (error instanceof PolicyShapeError || error instanceof StrictJsonError) {
      return { ok: false, error: `${path}: ${error.message}` };
    }
    throw error;
  }
}

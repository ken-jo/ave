import { sep, win32 } from "node:path";
import { expandWindowsEnvRefs, stripExtendedPathPrefix } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { createLogger } from "../lib/logger.js";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { admitLocalPath, admitLocalRoute, decisionMemo, type LocalFilesystemFacts, localFs, withLocalityDecision } from "../shared/local-path-io.js";
import { isWindowsPathKindHelperUnavailable } from "../main/windows-path-kind-launcher.js";
import { admitWindowsReparse, isWindowsPathFactsPathFailure, pinWindowsPaths, type WindowsPathFacts } from "../shared/windows-path-facts.js";
import { WINDOWS_COMMAND_LINE_LIMIT } from "../shared/windows-command-line.js";
import { classifyWindowsSpelling } from "../shared/windows-path-spelling.js";
import { SENSITIVE_PATH_ENTRIES } from "./sensitive-paths.js";
import { isPlainWindowsStampPath } from "./windows-stamp-targets.js";

const log = createLogger("admitted-obligation");

/*
 * The one producer of Windows path obligations (docs/architecture/permission-decision-tree.md, "Path obligations").
 * Every sandbox row and every command-derived lookup is admitted here once: its spelling is anchored, its drive mapping
 * read before anything is opened, its route walked from the volume root with every link re-admitted, and its object
 * pinned by the native helper. Consumers take `target`, `identity` and `chain` literally and never resolve a spelling.
 */

type ObjectIdentity = Readonly<{ volumeSerial: string; fileId: string }>;
type ObligationKind = "file" | "dir" | "missing";
export type Polarity = Readonly<{ effect: "allow" | "deny"; access: "read" | "write" | "lookup" }>;
type Principal = "srt-sandbox" | "mxc" | "host-lookup";
export type ObligationPurpose =
  | "sandbox-config" | "per-exec" | "worker-grant" | "mxc-launch"
  | "shell-cwd" | "pm-cwd-identity" | "git-pin" | "preview";
export type ObligationSource = "floor" | "read-mask" | "settings" | "per-command" | "live-grant" | "worker-request" | "command-operand";
type EnforcementMode = "acl-exact" | "acl-subtree" | "acl-placeholder" | "mxc-rule" | "lookup";

export type UnresolvedReason =
  | "unbound-rooted" | "drive-relative" | "relative" | "share" | "mapped-drive" | "subst" | "device"
  | "helper-unavailable" | "incomplete-walk" | "unclassifiable-reparse" | "link-to-remote"
  | "glob-budget" | "glob-not-subtree" | "root-level" | "unstampable-no-evidence" | "link-spelling";

type ObligationScope = Readonly<{
  purpose: ObligationPurpose;
  principal: Principal;
  denyRevision: number;
  grantRevision: number;
  boundBase: `${string}:` | null;
}>;

type Origin = Readonly<{ row: string; source: ObligationSource; kind: "floor" | "user" | "product"; glob?: string }>;

export interface AdmittedObligation {
  /** The final path of the object (or, for `missing`, of its anchor joined with the literal remainder). */
  readonly target: string;
  readonly kind: ObligationKind;
  /** A missing target that names a directory (its row ended in a separator). */
  readonly directory: boolean;
  readonly identity: ObjectIdentity | null;
  readonly changeTime: string | null;
  /** The deepest existing component: the object itself unless it is missing. */
  readonly anchor: ObjectIdentity;
  readonly anchorTarget: string;
  readonly parent: ObjectIdentity | null;
  /** Volume root .. anchor; containment between obligations is by identity-chain prefix. */
  readonly chain: readonly ObjectIdentity[];
  readonly polarity: Polarity;
  readonly extent: "exact" | "subtree";
  readonly scope: ObligationScope;
  /** Every link on the route was admitted in this set, so a consumer may follow the target. */
  readonly followCapable: boolean;
  readonly enforcement: EnforcementMode;
  /** Audit only; never a consumer input. */
  readonly origin: Origin;
}

interface UnresolvedObligation {
  readonly polarity: Polarity;
  readonly reason: UnresolvedReason;
  readonly scope: ObligationScope;
  readonly origin: Origin;
}

export interface ObligationSet {
  readonly admitted: readonly AdmittedObligation[];
  readonly unresolved: readonly UnresolvedObligation[];
  /** POSIX-only rows on Windows: dropped before any lookup. */
  readonly inapplicable: readonly Readonly<{ row: string; reason: "posix-only" }>[];
  readonly scope: ObligationScope;
}

export type ObligationRow = Readonly<{
  spelling: string | Readonly<{ path: string; literal: true }>;
  polarity: Polarity;
  source: ObligationSource;
}>;

function originOf(row: ObligationRow, glob?: string): Origin {
  const { source, spelling } = row;
  const kind = source === "floor" ? "floor" : source === "settings" ? "user" : "product";
  return { row: typeof spelling === "string" ? spelling : spelling.path, source, kind, ...(glob === undefined ? {} : { glob }) };
}

export interface ObligationRequest {
  readonly purpose: ObligationPurpose;
  readonly principal: Principal;
  readonly rows: readonly ObligationRow[];
  /** The drive a rooted row (`\x`) is bound to; null refuses rooted rows. */
  readonly boundBase?: `${string}:` | null;
  /** Final paths a deny cannot be stamped on (the profile root): its parent ACE would change every sibling. */
  readonly unstampableRoots?: readonly string[];
  readonly revisions?: Readonly<{ deny: number; grant: number }>;
}

/** A deny the backend cannot enforce, or a worker grant it cannot prove: confinement and the grant are refused. */
export class ObligationRefusedError extends Error {
  readonly code = "sandbox-obligation-unenforceable";
  constructor(readonly rows: readonly Readonly<{ row: string; reason: UnresolvedReason }>[]) {
    super(`Windows sandbox obligations cannot be enforced: ${rows.map(entry => `${entry.row} (${entry.reason})`).join(", ")}`);
    this.name = "ObligationRefusedError";
  }
}

function obligationRefusalOf(error: unknown): ObligationRefusedError | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === "sandbox-obligation-unenforceable") return current as ObligationRefusedError;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isObligationRefusal(error: unknown): boolean {
  return obligationRefusalOf(error) !== undefined;
}

/** Which question a refusal asks: only rows that name, or route to, a network location are reported as network rows. */
export type DenyUnenforceableKind = "network" | "path";
const NETWORK_REASONS: ReadonlySet<UnresolvedReason> = new Set(["share", "mapped-drive", "link-to-remote"]);

export function denyUnenforceableKind(error: unknown): DenyUnenforceableKind | undefined {
  const refusal = obligationRefusalOf(error);
  if (refusal === undefined) return undefined;
  const rows = Array.isArray(refusal.rows) ? refusal.rows : [];
  return rows.length > 0 && rows.every(entry => NETWORK_REASONS.has(entry.reason)) ? "network" : "path";
}

export const POSIX_CRON_DENIES = [
  "/usr/lib/cron/tabs", // macOS user crontab spool
  "/var/spool/cron/crontabs", // Linux (Debian/Ubuntu) user crontab spool
  "/var/spool/cron", // Linux (RHEL/Fedora) user crontab spool
  "/etc/cron.d", // system cron drop-in dir
] as const;
const POSIX_ASRT_TEMP_DENIES = ["/tmp/claude", "/private/tmp/claude"] as const;

/** Rows that name POSIX locations only; on Windows they are inapplicable and never looked up. */
export function posixOnlyDenyPaths(): ReadonlySet<string> {
  return new Set([
    ...SENSITIVE_PATH_ENTRIES.filter(entry => entry.anchor === "root").map(entry => `/${entry.segments.join("/")}`),
    ...POSIX_CRON_DENIES, ...POSIX_ASRT_TEMP_DENIES,
  ]);
}

const issued = new WeakSet<object>();
// What one glob may enumerate before its row is left unresolved.
const GLOB_ENTRY_BUDGET = 10_000;
const LOOKUP_PURPOSES: ReadonlySet<ObligationPurpose> = new Set(["shell-cwd", "pm-cwd-identity", "git-pin", "preview"]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function brand<T extends object>(value: T): T {
  const frozen = deepFreeze(value);
  issued.add(frozen);
  return frozen;
}

const fold = (path: string) => win32.normalize(path).replace(/[\\/]+$/u, "").toLowerCase();

type Anchored = { path: string } | { reason: UnresolvedReason };

/** Home references in a spelling expanded once (a marked literal names an object as is), then anchored to a drive without any lookup. */
function anchorSpelling(raw: string, boundBase: `${string}:` | null, literal: boolean): Anchored {
  const expanded = literal ? raw : expandWindowsEnvRefs(expandLeadingTilde(raw));
  const spelling = classifyWindowsSpelling(expanded, "win32");
  if (spelling.kind === "share") return { reason: "share" };
  if (spelling.kind === "device-opaque" || spelling.kind === "ambiguous") return { reason: "device" };
  const path = stripExtendedPathPrefix(expanded);
  if (/^[A-Za-z]:[\\/]/u.test(path)) return lexicallyPlain(path);
  if (/^[\\/](?![\\/])/u.test(path)) return boundBase === null ? { reason: "unbound-rooted" } : lexicallyPlain(`${boundBase}${path}`);
  if (/^[A-Za-z]:/u.test(path)) return { reason: "drive-relative" };
  if (/^[\\/]{2}/u.test(path)) return { reason: "device" };
  return { reason: "relative" };
}

function lexicallyPlain(spelling: string): Anchored {
  const path = win32.normalize(spelling).replace(/^[a-z]:/u, drive => drive.toUpperCase());
  // Trailing dots or spaces, stream suffixes and reserved names spell no ordinary object; a short name or `%` is a
  // name the walk resolves, and glob components are judged by what they match.
  const literal = path.split("\\").map(component => /[*?]/u.test(component) ? "glob" : component.replace(/[%~]/gu, "_")).join("\\");
  return isPlainWindowsStampPath(literal) ? { path } : { reason: "device" };
}

const GLOB_DENY = /[*?[\]]/u;
const GLOB_ALLOW = /[*?]/u;

type Literal = Readonly<{ path: string; directory: boolean; extent: "exact" | "subtree"; glob?: string }>;

/** Why the drive of `path` is not a local volume, read from its mapping before anything on it is opened. */
function driveRefusal(path: string): UnresolvedReason | undefined {
  try {
    admitLocalPath(`${path.slice(0, 2)}\\`);
    return undefined;
  } catch (error) {
    // Only a locality refusal names a reason; anything else is a broken contract and fails as itself.
    if ((error as { code?: unknown }).code !== "ENETWORKSHAREPATH") throw error;
    if (isWindowsPathKindHelperUnavailable(error)) return "helper-unavailable";
    const root = String((error as { path?: unknown }).path ?? "");
    if (/^\\\\(?!\?)/u.test(root)) return "mapped-drive";
    return /^\\\\\?\\GLOBALROOT\\\?\?\\[A-Za-z]:\\/u.test(root) ? "subst" : "device";
  }
}

/** The physical route of `path` with every link admitted, or why it is not proven local. */
function walkRoute(path: string, facts: LocalFilesystemFacts, preview = false): { physical: string; followedLink: boolean } | { reason: UnresolvedReason } {
  const drive = driveRefusal(path);
  if (drive !== undefined) return { reason: drive };
  try {
    const { physical, followedLink } = admitLocalRoute(path, { projectMissing: true, rejectDanglingLink: preview, facts });
    return physical === undefined ? { reason: "incomplete-walk" } : { physical, followedLink };
  } catch (error) {
    const { code, incomplete, cause } = error as { code?: unknown; incomplete?: unknown; cause?: unknown };
    if (preview && cause instanceof TypeError) throw cause;
    // The row's own drive is local, so a refusal on the walk came through a link.
    if (code === "ENETWORKSHAREPATH" && incomplete !== true) return { reason: "link-to-remote" };
    return { reason: "incomplete-walk" };
  }
}

/** Matches of an allow glob beneath its walked base; `[` and `]` are name characters. Links are matched, never entered. */
function expandAllowGlob(base: string, rest: readonly string[]): string[] | "glob-budget" | "incomplete-walk" {
  const matches: string[] = [];
  let left = GLOB_ENTRY_BUDGET;
  let failure: "glob-budget" | "incomplete-walk" | undefined;
  const matcher = (segment: string) => new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^\\\\/]*").replaceAll("?", "[^\\\\/]")}$`, "iu");
  const list = (directory: string): { name: string; dir: boolean; link: boolean }[] | undefined => {
    try {
      const out: { name: string; dir: boolean; link: boolean }[] = [];
      for (const name of localFs.readdir(admitLocalRoute(directory).verdict)) {
        if (--left < 0) { failure = "glob-budget"; return undefined; }
        const entry = localFs.lstat(admitLocalPath(win32.join(directory, name)));
        if (entry === undefined) continue;
        out.push({ name, dir: entry.isDirectory(), link: entry.isSymbolicLink() });
      }
      return out;
    } catch {
      failure ??= "incomplete-walk";
      return undefined;
    }
  };
  const visit = (directory: string, segments: readonly string[]): boolean => {
    const [segment, ...after] = segments;
    if (segment === undefined) { matches.push(directory); return true; }
    if (segment === "**") {
      if (!visit(directory, after)) return false;
      const entries = list(directory);
      return entries?.every(entry => !entry.dir || entry.link || visit(win32.join(directory, entry.name), segments)) === true;
    }
    if (!GLOB_ALLOW.test(segment)) return visit(win32.join(directory, segment), after);
    const entries = list(directory);
    if (entries === undefined) return false;
    const pattern = matcher(segment);
    return entries.every(entry => !pattern.test(entry.name) || (after.length > 0 && (!entry.dir || entry.link)) || visit(win32.join(directory, entry.name), after));
  };
  // A literal remainder that does not exist matches nothing.
  return visit(base, rest) ? matches.filter(match => localFs.lstat(admitLocalPath(match)) !== undefined) : failure ?? "incomplete-walk";
}

function isVolumeRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/u.test(path);
}

interface Walked {
  literal: Literal;
  row: ObligationRow;
  physical: string;
}

function identityOf(facts: { volumeSerial: string | null; fileId: string | null }): ObjectIdentity {
  return { volumeSerial: facts.volumeSerial as string, fileId: facts.fileId as string };
}

function sameIdentity(left: ObjectIdentity, right: ObjectIdentity): boolean {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

/** Whether `inner`'s chain passes through `outer`'s object (the same object included). */
export function obligationWithin(outer: AdmittedObligation, inner: AdmittedObligation): boolean {
  const object = outer.identity ?? (outer.kind === "missing" ? undefined : outer.anchor);
  if (object === undefined) {
    // A missing outer object holds only what lies lexically beneath its projected target.
    const prefix = fold(outer.target);
    const target = fold(inner.target);
    return target === prefix || target.startsWith(`${prefix}\\`);
  }
  return inner.chain.some(link => sameIdentity(link, object))
    || (inner.kind === "missing" && fold(inner.target).startsWith(`${fold(outer.target)}\\`));
}

// Leaves room for the helper's own path and mode beside the quoted rows.
const PIN_CHUNK_UNITS = WINDOWS_COMMAND_LINE_LIMIT - 4_096;

// Pin facts a lookup decision already read, by exact physical spelling. Only successful pins are kept.
const PINNED_IN_DECISION = {};

type Pin = WindowsPathFacts | "helper-unavailable" | undefined;

// A path refusal splits the batch to keep its readable rows; an unavailable helper marks the batch; any other error throws.
function pinAll(paths: readonly string[], memo?: Map<string, WindowsPathFacts>): Pin[] {
  const facts = new Map<string, WindowsPathFacts | "helper-unavailable">();
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let units = 0;
  for (const path of new Set(paths)) {
    const known = memo?.get(path);
    if (known !== undefined) { facts.set(path, known); continue; }
    const cost = path.length * 2 + 3;
    if (chunk.length > 0 && units + cost > PIN_CHUNK_UNITS) { chunks.push(chunk); chunk = []; units = 0; }
    chunk.push(path);
    units += cost;
  }
  if (chunk.length > 0) chunks.push(chunk);
  const pinChunk = (batch: readonly string[]): void => {
    try {
      const pinned = pinWindowsPaths(batch);
      for (const [index, path] of batch.entries()) {
        const row = pinned[index];
        if (row === undefined) continue;
        facts.set(path, row);
        memo?.set(path, row);
      }
    } catch (error) {
      if (isWindowsPathKindHelperUnavailable(error)) {
        for (const path of batch) facts.set(path, "helper-unavailable");
        return;
      }
      if (!isWindowsPathFactsPathFailure(error)) throw error;
      if (batch.length <= 1) return;
      const middle = Math.floor(batch.length / 2);
      pinChunk(batch.slice(0, middle));
      pinChunk(batch.slice(middle));
    }
  };
  chunks.forEach(pinChunk);
  return paths.map(path => facts.get(path));
}

/** A path that cannot be pinned because an existing file lies on it: missing beneath that file, as a walk reports it. */
function beneathFile(path: string, memo?: Map<string, WindowsPathFacts>): Pin {
  for (let parent = win32.dirname(path); parent !== win32.dirname(parent); parent = win32.dirname(parent)) {
    const facts = pinAll([parent], memo)[0];
    if (facts === undefined) continue;
    if (facts === "helper-unavailable") return facts;
    if (facts.exists !== true || facts.directory) return undefined;
    return { ...facts, exists: false, directory: false, reparseTag: 0, attributes: 0, ancestors: [...facts.ancestors, facts] };
  }
  return undefined;
}

/**
 * Admits `request.rows` for one decision. Synchronous: every lookup happens inside one locality decision, and the
 * native helper is started once per batch.
 */
export function admitObligations(request: ObligationRequest): ObligationSet {
  const scope: ObligationScope = Object.freeze({
    purpose: request.purpose,
    principal: request.principal,
    denyRevision: request.revisions?.deny ?? 0,
    grantRevision: request.revisions?.grant ?? 0,
    boundBase: request.boundBase ?? null,
  });
  const posixOnly = posixOnlyDenyPaths();
  const admitted: AdmittedObligation[] = [];
  const unresolved: UnresolvedObligation[] = [];
  const inapplicable: { row: string; reason: "posix-only" }[] = [];
  const unresolve = (row: ObligationRow, reason: UnresolvedReason, glob?: string) => {
    unresolved.push(brand({ polarity: row.polarity, reason, scope, origin: originOf(row, glob) }));
  };
  const unstampable = new Set((request.unstampableRoots ?? []).map(fold));

  withLocalityDecision(() => {
    const prefixes = new Map<string, { canonical: string; missing: false }>();
    const routeFacts: LocalFilesystemFacts = {
      knownPath: path => prefixes.get(path),
      onLocalPath(path, canonical, missing, followedLink) {
        if (!missing && !followedLink) prefixes.set(path, { canonical, missing: false });
      },
    };
    // Allows first: a deny glob may be widened to its base only where that removes no granted access.
    const ordered = [...request.rows].sort((a, b) => (a.polarity.effect === b.polarity.effect ? 0 : a.polarity.effect === "allow" ? -1 : 1));
    const pending: { row: ObligationRow; literal: Literal }[] = [];
    const globDenies: { row: ObligationRow; base: string; glob: string }[] = [];
    for (const row of ordered) {
      const raw = typeof row.spelling === "string" ? row.spelling : row.spelling.path;
      const literal = typeof row.spelling !== "string";
      if (posixOnly.has(raw)) { inapplicable.push({ row: raw, reason: "posix-only" }); continue; }
      const anchored = anchorSpelling(raw, scope.boundBase, literal);
      if ("reason" in anchored) { unresolve(row, anchored.reason); continue; }
      const directory = /[\\/]$/u.test(raw);
      const deny = row.polarity.effect === "deny";
      const pattern = literal ? undefined : (deny ? GLOB_DENY : GLOB_ALLOW);
      const components = anchored.path.split(/[\\/]+/u).filter(Boolean);
      const first = pattern === undefined ? -1 : components.findIndex(component => pattern.test(component));
      if (first === -1) { pending.push({ row, literal: { path: anchored.path, directory, extent: "exact" } }); continue; }
      const base = `${components.slice(0, first).join("\\")}\\`;
      const rest = components.slice(first);
      if (deny) {
        globDenies.push({ row, base, glob: anchored.path });
        continue;
      }
      // `B\**` is B and everything beneath it: one subtree grant, never an enumeration.
      if (rest.length === 1 && rest[0] === "**") { pending.push({ row, literal: { path: base, directory: true, extent: "subtree" } }); continue; }
      const route = walkRoute(base, routeFacts);
      if ("reason" in route) { unresolve(row, route.reason, anchored.path); continue; }
      const matches = expandAllowGlob(route.physical, rest);
      if (typeof matches === "string") { unresolve(row, matches, anchored.path); continue; }
      for (const match of matches) pending.push({ row, literal: { path: match, directory: false, extent: "exact", glob: anchored.path } });
    }

    const admitBatch = (batch: readonly { row: ObligationRow; literal: Literal }[]): AdmittedObligation[] => {
      const walked: Walked[] = [];
      for (const { row, literal } of batch) {
        const route = walkRoute(literal.path, routeFacts, scope.purpose === "preview");
        if ("reason" in route) { unresolve(row, route.reason, literal.glob); continue; }
        // The ACL helper follows links. A deny on the target would leave the link itself replaceable.
        if (route.followedLink && (scope.purpose === "git-pin"
          || (row.polarity.effect === "deny" && !LOOKUP_PURPOSES.has(scope.purpose)))) {
          unresolve(row, "link-spelling", literal.glob);
          continue;
        }
        walked.push({ row, literal, physical: route.physical });
      }
      // Lookups and mxc-launch reuse what this decision already pinned; ACL-stamping purposes (sandbox-config, per-exec, worker-grant) pin afresh.
      const memo = LOOKUP_PURPOSES.has(scope.purpose) || scope.purpose === "mxc-launch" ? decisionMemo<WindowsPathFacts>(PINNED_IN_DECISION) : undefined;
      const pinned = pinAll(walked.map(entry => entry.physical), memo);
      const facts = walked.map((entry, index) => pinned[index] ?? beneathFile(entry.physical, memo));
      const out: AdmittedObligation[] = [];
      walked.forEach((entry, index) => {
        const pin = facts[index];
        const result = pin === "helper-unavailable" ? { reason: pin } : obligationFrom(entry, pin, scope, unstampable);
        if ("reason" in result) unresolve(entry.row, result.reason, entry.literal.glob);
        else out.push(result);
      });
      return out;
    };

    const allows = admitBatch(pending.filter(entry => entry.row.polarity.effect === "allow"));
    admitted.push(...allows);
    const denyLiterals = pending.filter(entry => entry.row.polarity.effect === "deny");
    const coversUnstampableRoot = (base: string): boolean => {
      const prefix = fold(base);
      return [...unstampable].some(root => root === prefix || root.startsWith(`${prefix}\\`));
    };
    for (const { row, base, glob } of globDenies) {
      // NTFS inheritance cannot filter by name: the deny covers the glob's whole static base, or the row is refused.
      if (isVolumeRoot(base) || coversUnstampableRoot(base)) { unresolve(row, "glob-not-subtree", glob); continue; }
      denyLiterals.push({ row, literal: { path: base, directory: true, extent: "subtree", glob } });
    }
    for (const obligation of admitBatch(denyLiterals)) {
      if (obligation.origin.glob !== undefined && (coversUnstampableRoot(obligation.target)
        || allows.some(grant => (obligation.polarity.access === "read" || grant.polarity.access === "write")
          && obligationWithin(obligation, grant)))) {
        unresolved.push(brand({ polarity: obligation.polarity, reason: "glob-not-subtree", scope, origin: obligation.origin }));
        continue;
      }
      admitted.push(obligation);
    }
  });
  for (const entry of unresolved) log.warn(`[sandbox-obligation] ${entry.polarity.effect} ${entry.polarity.access} ${entry.origin.row}: ${entry.reason}`);
  return brand({ admitted, unresolved, inapplicable, scope });
}

function obligationFrom(entry: Walked, facts: WindowsPathFacts | undefined, scope: ObligationScope, unstampable: ReadonlySet<string>): AdmittedObligation | { reason: UnresolvedReason } {
  if (facts === undefined) return { reason: "incomplete-walk" };
  const components = [...facts.ancestors, facts];
  if (components.some(component => component.exists === null)) return { reason: "incomplete-walk" };
  const reparse = admitWindowsReparse(facts, scope.purpose === "git-pin" ? "evidence" : "grant");
  if (reparse === false) return { reason: "unclassifiable-reparse" };
  if (reparse === "resolve") return { reason: "incomplete-walk" };
  const existing = components.filter(component => component.exists === true);
  const anchorFacts = existing.at(-1);
  if (anchorFacts === undefined) return { reason: "incomplete-walk" };
  const exists = facts.exists === true;
  const anchorTarget = stripExtendedPathPrefix(anchorFacts.canonical as string);
  const remainder = exists ? [] : entry.physical.split(/[\\/]+/u).filter(Boolean).slice(existing.length);
  if (!exists && remainder.length === 0) return { reason: "incomplete-walk" };
  const target = exists ? anchorTarget : win32.join(anchorTarget, ...remainder);
  const deny = entry.row.polarity.effect === "deny";
  if (deny && (isVolumeRoot(target) || unstampable.has(fold(target)))) return { reason: exists && isVolumeRoot(target) ? "root-level" : "unstampable-no-evidence" };
  const chain = existing.map(identityOf);
  const parentFacts = exists ? facts.ancestors.at(-1) : undefined;
  const enforcement: EnforcementMode = LOOKUP_PURPOSES.has(scope.purpose) ? "lookup"
    : scope.principal === "mxc" ? "mxc-rule"
    : !deny ? (entry.literal.extent === "subtree" ? "acl-subtree" : "acl-exact")
    : !exists ? "acl-placeholder"
    : entry.literal.extent === "subtree" ? "acl-subtree" : "acl-exact";
  return brand({
    target,
    kind: exists ? (facts.directory ? "dir" : "file") : "missing",
    directory: exists ? facts.directory : entry.literal.directory,
    identity: exists ? identityOf(facts) : null,
    changeTime: facts.changeTime,
    anchor: identityOf(anchorFacts),
    anchorTarget,
    parent: parentFacts?.exists === true ? identityOf(parentFacts) : exists ? null : identityOf(anchorFacts),
    chain,
    polarity: entry.row.polarity,
    extent: entry.literal.extent,
    scope,
    followCapable: true,
    enforcement,
    origin: originOf(entry.row, entry.literal.glob),
  } satisfies AdmittedObligation);
}

/** The members of a set this module issued, for the purpose it was issued for, while its revisions still hold. */
export function consumeObligations(set: ObligationSet, purpose: ObligationPurpose, revisions?: Readonly<{ deny: number; grant: number }>): readonly AdmittedObligation[] {
  if (!issued.has(set)) throw new TypeError("Obligation set was not issued by the producer");
  if (set.scope.purpose !== purpose) throw new TypeError(`Obligation set for ${set.scope.purpose} consumed as ${purpose}`);
  if (revisions !== undefined && (revisions.deny !== set.scope.denyRevision || revisions.grant !== set.scope.grantRevision)) {
    throw new Error("Obligation set is stale: the session's deny or grant revision changed");
  }
  return set.admitted;
}

export function admitWindowsLookupPaths(paths: readonly string[], purpose: "preview" | "shell-cwd" | "pm-cwd-identity" | "mxc-launch"): ReadonlyMap<string, AdmittedObligation> {
  const set = admitObligations({
    purpose, principal: purpose === "mxc-launch" ? "mxc" : "host-lookup",
    rows: [...new Set(paths)].map(path => ({
      spelling: { path, literal: true }, polarity: { effect: "allow", access: "lookup" }, source: "command-operand",
    })),
  });
  return new Map(consumeObligations(set, purpose).filter(entry => entry.followCapable).map(entry => [entry.origin.row, entry]));
}

/** Observe both the original cd spelling and the logical destination under one locality decision. */
export function observeWindowsShellDirectories(
  original: string, destination: string, batch?: ReadonlyMap<string, AdmittedObligation>,
): "directory" | "not-directory" | "unknown" {
  // A lexical normalization can erase components whose searchability the shell still needs.
  if (original.split(/[\\/]/u).some(component => component === "..")) return "unknown";
  return withLocalityDecision(() => {
    const paths = [...new Set([original, destination].map(path => win32.normalize(path)))];
    const observed = batch ?? admitWindowsLookupPaths(paths, "shell-cwd");
    const directories = paths.flatMap(path => {
      const entry = observed.get(path);
      return entry === undefined ? [] : [entry];
    });
    if (directories.some(entry => entry.kind !== "dir")) return "not-directory";
    if (directories.length !== paths.length) return "unknown";
    for (const entry of directories) {
      if (!entry.followCapable) return "unknown";
      try {
        const route = admitLocalRoute(entry.target);
        if (route.physical !== entry.target || route.followedLink) return "unknown";
        localFs.requireSearchAccess(route.verdict);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) return "not-directory";
        return "unknown";
      }
    }
    return "directory";
  });
}

export function isIssuedObligation(value: unknown): value is AdmittedObligation {
  return typeof value === "object" && value !== null && issued.has(value) && "target" in value;
}

/**
 * The gate before anything is launched or granted: an unresolved deny refuses, and so does an unresolved worker
 * request. Any other unresolved allow is simply not granted.
 */
export function requireEnforceable(set: ObligationSet): void {
  if (!issued.has(set)) throw new TypeError("Obligation set was not issued by the producer");
  const refused = set.unresolved.filter(entry => entry.polarity.effect === "deny"
    || (set.scope.purpose === "worker-grant" && entry.origin.source === "worker-request"));
  if (refused.length > 0) throw new ObligationRefusedError(refused.map(entry => Object.freeze({ row: entry.origin.row, reason: entry.reason })));
}

let denyUnenforceableAtBoot: DenyUnenforceableKind | undefined;

/** Boot could not enforce a Windows deny; host shells then take the sandbox-unavailable question for every command. */
export function setWindowsDenyUnenforceableAtBoot(kind: DenyUnenforceableKind | undefined): void {
  denyUnenforceableAtBoot = kind;
}

export function windowsDenyUnenforceableAtBoot(): DenyUnenforceableKind | undefined {
  return denyUnenforceableAtBoot;
}

/** Whether this host proves Windows paths natively; a simulated Windows path layout on another host does not. */
export function windowsObligationsApply(): boolean {
  return process.platform === "win32" && sep === "\\";
}

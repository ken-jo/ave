// Shell grants bind canonical destination, approved network class and origin; spelling/class changes cannot widen them and terminal grants never cover agent shells. Invocation/session/tab grants stay in memory (session grants end with their conversation); project/always persist until revoked. Terminal once means one connection, and tab grants end with the shell.
// Never consult these grants for workers or add them to runtime allowedDomains. Canonicalize project roots and strictly validate persisted shape; corrupt stores raise an error and the ask denies instead of silently dropping data. The v1 file's `workspace` scope is migrated to `project` explicitly on read (owner 2026-10-25, five-choice network card); no other old value is accepted.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalizeHost } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import {
  addRange,
  addressInSet,
  embeddedIPv4,
  isLoopbackAddress,
  isLoopbackName,
  LOOPBACK_RANGES,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import { BlockList, isIP } from "node:net";
import { openFeatureNamespace, writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { isMissingPathError } from "../lib/atomic-file.js";
import { createSerialQueue } from "../lib/with-file-lock.js";
import { projectRuleRoot } from "./rules/project-rule-files.js";
import { canonicalizePathForMatch, foldCanonicalPathSeparators } from "./sensitive-paths.js";
import { maxEgressGrantScope, type EgressIdentityStrength } from "../shared/sandbox-capability-info.js";
import {
  EGRESS_GRANT_SCOPE_LADDERS,
  isEgressGrantScope,
  isEgressGrantNetwork,
  type EgressGrantNetwork,
  type EgressAskOrigin,
  type EgressGrantScope,
  type SessionEgressGrant,
  type PersistentEgressGrant,
  type RevocableEgressGrant,
  type TabEgressGrant,
} from "../shared/egress-grant-scopes.js";

// The scopes an ask from this kind of process may offer on a host whose attribution is this strong, narrowest first. A shared identity (Windows srt-win: one account, one port range) can be presented by another invocation, so a grant there must not outlive the session (for a terminal: the tab) that made it: the cap keeps the in-memory rungs only.
export function egressGrantScopesFor(
  strength: EgressIdentityStrength,
  origin: EgressAskOrigin = "shell",
): readonly EgressGrantScope[] {
  const cap = maxEgressGrantScope(strength);
  if (cap === "always") return EGRESS_GRANT_SCOPE_LADDERS[origin];
  if (cap !== "session") throw new Error(`egress grant: unsupported scope cap ${cap}`);
  return EGRESS_GRANT_SCOPE_LADDERS[origin].filter((scope) => !isPersistentScope(scope));
}

// One destination: a canonical host and a port.
export interface EgressDestination {
  readonly host: string;
  readonly port: number;
}

// A grant also names the class approved; omission means a legacy public grant.
export interface EgressGrantDestination extends EgressDestination {
  readonly network?: EgressGrantNetwork;
}

// The canonical form of a destination host, or undefined for one that is not a host name or an IP literal: ASRT's own `canonicalizeHost` (the spelling its allow and deny lists are compared in: lower case, no trailing dot, IPv6 compressed and unbracketed, an IPv4-mapped address as IPv4), since the callback is handed the host as the client spelled it.
export function canonicalEgressHost(host: string): string | undefined {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return undefined;
  const canonical = canonicalizeHost(host)?.toLowerCase();
  return canonical === undefined || canonical.length === 0 ? undefined : canonical;
}

// Use the most restrictive class across the canonical host and every pinned address: reserved metadata/link-local/unspecified/multicast/broadcast is never askable; local and unresolved upstream destinations cap grants to session/tab. Public may use broader scopes; show why restricted scopes apply.
export type EgressDestinationNetwork = EgressGrantNetwork | "reserved";

const RESERVED_RANGES = [
  "169.254.0.0/16", "fe80::/10", // link-local, incl. most instance metadata
  "0.0.0.0/8", "::/128", // unspecified: connects to this host on common stacks
  "224.0.0.0/4", "ff00::/8", "255.255.255.255/32",
  // Cloud metadata endpoints outside link-local (as ASRT's resolved-address guard lists them).
  "100.100.100.200/32", "168.63.129.16/32", "192.0.0.192/32", "fd00:ec2::/32", "fd20:ce::254/128",
  "fd00:c1::a9fe:a9fe/128", "fd00:42::42/128", "fd00:a9fe:a9fe::1/128", "fd00:100::100:200/128",
];
const LOCAL_RANGES = [
  ...LOOPBACK_RANGES,
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7", "fec0::/10",
];
const LOCAL_NAMES = new Set(["ip6-localhost", "ip6-loopback"]);
const LOCAL_NAME_SUFFIXES = [".local", ".localdomain", ".home.arpa", ".internal", ".lan"];

function isLocalNetworkName(name: string): boolean {
  return LOCAL_NAMES.has(name) || LOCAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function addressNetwork(address: string): EgressDestinationNetwork {
  // Before the embedded-IPv4 rule: `::1`'s IPv4-compatible form is 0.0.0.1.
  if (isLoopbackAddress(address)) return "local";
  // An address that carries an IPv4 address (NAT64, 6to4, IPv4-compatible) is delivered to that address, so it is judged by it as well.
  const forms = [address, embeddedIPv4(address)].filter((a): a is string => a !== undefined);
  if (forms.some((a) => addressInSet(RESERVED, a))) return "reserved";
  if (forms.some((a) => isLoopbackAddress(a) || addressInSet(LOCAL, a))) return "local";
  return "public";
}

function rangeList(ranges: readonly string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    if (!addRange(list, range)) throw new Error(`egress destination ranges: invalid range ${range}`);
  }
  return list;
}
const RESERVED = rangeList(RESERVED_RANGES);
const LOCAL = rangeList(LOCAL_RANGES);

export function egressDestinationNetwork(
  canonicalHost: string,
  resolvedAddresses: readonly string[] = [],
): EgressDestinationNetwork {
  const judged: EgressDestinationNetwork[] = [];
  if (isIP(canonicalHost) !== 0) judged.push(addressNetwork(canonicalHost));
  else if (isLoopbackName(canonicalHost) || isLocalNetworkName(canonicalHost)) judged.push("local");
  for (const address of resolvedAddresses) {
    if (isIP(address) === 0) throw new Error(`egress destination: resolved address ${JSON.stringify(address)} is not an IP address`);
    judged.push(addressNetwork(address));
  }
  if (judged.includes("reserved")) return "reserved";
  return judged.includes("local") ? "local" : "public";
}

// Whether a scope is held on disk (and so outlives the app run).
function isPersistentScope(scope: EgressGrantScope): scope is PersistentEgressGrant["scope"] {
  return scope === "project" || scope === "always";
}

// The scopes a grant for this kind of destination may take: none for a reserved one, only the in-memory ones (once, session, tab) for a local or unverified one, any for a public one.
export function egressScopesForNetwork(
  scopes: readonly EgressGrantScope[],
  network: EgressDestinationNetwork,
): readonly EgressGrantScope[] {
  if (network === "reserved") return [];
  return network === "public" ? scopes : scopes.filter((s) => !isPersistentScope(s));
}

export function isValidEgressPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function grantNetwork(destination: EgressGrantDestination): EgressGrantNetwork {
  const network = destination.network === undefined ? "public" : destination.network;
  if (!isEgressGrantNetwork(network)) throw new Error("egress grant: invalid network class");
  return network;
}

function destinationKey(destination: EgressGrantDestination): string {
  return `${destination.host} ${destination.port} ${grantNetwork(destination)}`;
}

// Where a shell call or terminal tab that asks for a grant runs.
export interface EgressGrantSubject {
  // The invocation token ("Allow once").
  readonly token: string;
  // The conversation ("This session"); undefined outside one, and always for a terminal.
  readonly sessionId: string | undefined;
  // The terminal tab ("This tab"); undefined for a shell tool call.
  readonly tabId: string | undefined;
  // The project root "This project" keys on (the repository root of the call's working directory when one is found); undefined when unknown, and always for a terminal.
  readonly projectRoot: string | undefined;
  // Which kind of process asks: the only origin whose persistent grants it matches or makes.
  readonly origin: EgressAskOrigin;
}

// A project root in the one form grants are stored and compared in.
function canonicalProjectRoot(path: string): string {
  return canonicalizePathForMatch(path);
}

export class EgressGrantFileError extends Error {
  constructor(path: string, problem: string) {
    super(`shell egress grant file ${path} is not valid: ${problem}`);
    this.name = "EgressGrantFileError";
  }
}

interface GrantFile {
  readonly version: 2;
  readonly grants: PersistentEgressGrant[];
}

// A v1 `workspace` grant the v1 → v2 migration could not carry over exactly (see `migrateLegacyGrant`).
export interface DroppedLegacyEgressGrant {
  readonly host: string;
  readonly port: number;
  // The v1 grant's exact directory.
  readonly workspaceRoot: string;
  // The repository root a v2 project grant for that directory would key on (a strict ancestor of it).
  readonly projectRoot: string;
}

interface ParsedGrantFile extends GrantFile {
  readonly droppedLegacy: readonly DroppedLegacyEgressGrant[];
}

// v2 (owner 2026-10-25, five-choice network card): `project`/`projectRoot` replaced v1's `workspace`/`workspaceRoot`.
const FILE_VERSION = 2;
const LEGACY_FILE_VERSION = 1;

function parseGrantFile(path: string, raw: string): ParsedGrantFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EgressGrantFileError(path, "invalid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EgressGrantFileError(path, "not an object");
  }
  const { version, grants, ...extra } = parsed as Record<string, unknown>;
  if (Object.keys(extra).length > 0) throw new EgressGrantFileError(path, `unknown field ${Object.keys(extra)[0]}`);
  if (version !== FILE_VERSION && version !== LEGACY_FILE_VERSION) throw new EgressGrantFileError(path, `unsupported version ${String(version)}`);
  if (!Array.isArray(grants)) throw new EgressGrantFileError(path, "grants is not an array");
  if (version !== LEGACY_FILE_VERSION) {
    return { version: FILE_VERSION, grants: grants.map((entry, index) => parseGrant(path, entry, index)), droppedLegacy: [] };
  }
  const migrated: PersistentEgressGrant[] = [];
  const droppedLegacy: DroppedLegacyEgressGrant[] = [];
  grants.forEach((entry, index) => {
    const grant = parseGrant(path, migrateLegacyGrant(path, entry, index), index);
    const dropped = grant.scope === "project" && grant.projectRoot !== undefined ? inexactLegacyProjectGrant(grant, grant.projectRoot) : undefined;
    if (dropped === undefined) migrated.push(grant);
    else droppedLegacy.push(dropped);
  });
  return { version: FILE_VERSION, grants: migrated, droppedLegacy };
}

// The one v1 → v2 rename: a `workspace` grant becomes a `project` grant on the same directory; `always` is unchanged. Anything else in a v1 file is invalid, as before.
function migrateLegacyGrant(path: string, entry: unknown, index: number): unknown {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const record = entry as Record<string, unknown>;
  if ("projectRoot" in record) throw new EgressGrantFileError(path, `grants[${index}] has v2 field projectRoot in a v1 file`);
  if (record.scope === "project") throw new EgressGrantFileError(path, `grants[${index}] has v2 scope project in a v1 file`);
  if (record.scope !== "workspace") return entry;
  const { workspaceRoot, scope: _scope, ...rest } = record;
  return { ...rest, scope: "project", projectRoot: workspaceRoot };
}

// A v1 grant covered its exact directory; a v2 project grant covers the repository root of the working directory (`projectRuleRoot`), so it is looked up by that root. A migrated grant keeps its exact meaning only when its directory is that root: it then covers what a "This project" choice made there covers. A grant made in a subdirectory would never match again under v2 (lookups key on the root), and re-keying it on the root would widen it to the whole repository, so it is dropped and reported instead (the user is asked again). Returns the drop, or undefined when the grant carries over.
function inexactLegacyProjectGrant(grant: PersistentEgressGrant, workspaceRoot: string): DroppedLegacyEgressGrant | undefined {
  const projectRoot = canonicalProjectRoot(projectRuleRoot(workspaceRoot));
  if (projectRoot === canonicalProjectRoot(workspaceRoot)) return undefined;
  return { host: grant.host, port: grant.port, workspaceRoot, projectRoot };
}

function parseGrant(path: string, entry: unknown, index: number): PersistentEgressGrant {
  const fail = (problem: string): never => {
    throw new EgressGrantFileError(path, `grants[${index}] ${problem}`);
  };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail("is not an object");
  const { scope, origin, projectRoot, host, port, network = "public", grantedAt, ...extra } = entry as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return fail(`has unknown field ${Object.keys(extra)[0]}`);
  if (scope !== "project" && scope !== "always") return fail("has a scope that is neither project nor always");
  if (origin !== "shell" && origin !== "terminal") return fail("has an origin that is neither shell nor terminal");
  if (scope === "project" && origin !== "shell") return fail("is a project grant not made by a shell call");
  // Shape only: the path is not resolved on disk here, so a directory that moved later just stops matching instead of making the file unreadable.
  if (scope === "project" && (typeof projectRoot !== "string" || foldCanonicalPathSeparators(resolve(projectRoot)) !== projectRoot)) {
    return fail("is a project grant without an absolute, normalised projectRoot");
  }
  if (scope === "always" && projectRoot !== undefined) return fail("is an always grant with a projectRoot");
  if (typeof host !== "string" || canonicalEgressHost(host) !== host) return fail("has a host that is not canonical");
  if (!isValidEgressPort(port)) return fail("has an invalid port");
  if (!isEgressGrantNetwork(network)) return fail("has an invalid network class");
  if (typeof grantedAt !== "string" || Number.isNaN(Date.parse(grantedAt))) return fail("has an invalid grantedAt");
  return scope === "project"
    ? { scope, origin, projectRoot: projectRoot as string, host, port, network, grantedAt }
    : { scope, origin, host, port, network, grantedAt };
}

export function egressGrantFilePath(): string {
  return join(openFeatureNamespace("permissions").dir, "shell-egress-hosts.json");
}

// The identity of one grant, for the tokens that used it.
function grantUseKey(grant: RevocableEgressGrant): string {
  const owner = grant.scope === "session" ? grant.sessionId
    : grant.scope === "tab" ? grant.tabId
    : grant.scope === "project" ? `${grant.origin}\n${grant.projectRoot ?? ""}` : grant.origin;
  return `${grant.scope}\n${owner}\n${destinationKey(grant)}`;
}

function parseDestinationKey(key: string): EgressGrantDestination {
  const [host, port, network] = key.split(" ");
  if (host === undefined || !isEgressGrantNetwork(network)) throw new Error("egress grant: invalid destination key");
  return { host, port: Number(port), network };
}

export class EgressGrantStore {
  private readonly once = new Map<string, Set<string>>();
  // Session id to destination key to the time it was granted.
  private readonly session = new Map<string, Map<string, string>>();
  // Terminal tab id to destination key to the time it was granted.
  private readonly tab = new Map<string, Map<string, string>>();
  // Grant identity to the invocation tokens it let through (for closing them on revoke).
  private readonly uses = new Map<string, Set<string>>();
  private persistent: PersistentEgressGrant[] | undefined;
  private readonly writes = createSerialQueue();

  // Destination keys of v1 grants already reported dropped, so a re-read before the file is rewritten does not report them twice.
  private readonly reportedLegacyDrops = new Set<string>();

  constructor(
    private readonly filePath: string = egressGrantFilePath(),
    // Told once per v1 grant the migration drops (`migrateLegacyGrant`), so the caller can audit it.
    private readonly onLegacyGrantDropped: (dropped: DroppedLegacyEgressGrant) => void = () => {},
  ) {}

  // The narrowest eligible grant covering this destination for this subject, or undefined. The caller limits scopes by current identity, origin and network class. Throws EgressGrantFileError when the persistent file is invalid, so the caller can deny with that reason instead of guessing.
  async matchingScope(
    subject: EgressGrantSubject,
    destination: EgressGrantDestination,
    eligibleScopes: readonly EgressGrantScope[],
  ): Promise<EgressGrantScope | undefined> {
    const key = destinationKey(destination);
    if (eligibleScopes.includes("once") && this.once.get(subject.token)?.has(key)) return "once";
    if (eligibleScopes.includes("session") && subject.sessionId !== undefined && this.session.get(subject.sessionId)?.has(key)) return "session";
    if (eligibleScopes.includes("tab") && subject.tabId !== undefined && this.tab.get(subject.tabId)?.has(key)) return "tab";
    // Persistent grants of the subject's own origin only.
    const persistent = (await this.loadPersistent()).filter((grant) =>
      eligibleScopes.includes(grant.scope) && grant.origin === subject.origin && destinationKey(grant) === key
      && egressScopesForNetwork([grant.scope], grantNetwork(destination)).length > 0);
    const projectRoot = subject.projectRoot === undefined ? undefined : canonicalProjectRoot(subject.projectRoot);
    if (projectRoot !== undefined && persistent.some((g) => g.scope === "project" && g.projectRoot === projectRoot)) return "project";
    if (persistent.some((g) => g.scope === "always")) return "always";
    return undefined;
  }

  // Record a grant. `allowedScopes` is what the ask offered; a scope outside it, or one the subject cannot hold (a session grant without a conversation, a tab grant without a tab, a project grant without a project root), is an error, not a narrower grant.
  async grant(
    scope: EgressGrantScope,
    allowedScopes: readonly EgressGrantScope[],
    subject: EgressGrantSubject,
    destination: EgressGrantDestination,
    now: Date = new Date(),
  ): Promise<void> {
    if (!isEgressGrantScope(scope)) throw new Error(`egress grant: unknown scope ${String(scope)}`);
    if (!allowedScopes.includes(scope)) throw new Error(`egress grant: scope ${scope} was not offered`);
    if (canonicalEgressHost(destination.host) !== destination.host) throw new Error("egress grant: host is not canonical");
    if (!isValidEgressPort(destination.port)) throw new Error("egress grant: invalid port");
    const network = grantNetwork(destination);
    if (egressScopesForNetwork([scope], network).length === 0) throw new Error("egress grant: scope cannot cover this network class");
    const key = destinationKey(destination);
    switch (scope) {
      case "once":
        // A terminal's "Allow once" lets one connection through and is never held.
        if (subject.tabId !== undefined) throw new Error("egress grant: a terminal tab's Allow once is not held");
        addTo(this.once, subject.token, key);
        return;
      case "session":
        if (subject.sessionId === undefined) throw new Error("egress grant: no session to grant for");
        addGrant(this.session, subject.sessionId, key, now);
        return;
      case "tab":
        if (subject.tabId === undefined) throw new Error("egress grant: no terminal tab to grant for");
        addGrant(this.tab, subject.tabId, key, now);
        return;
      case "project": {
        if (subject.origin !== "shell") throw new Error("egress grant: only a shell call can hold a project grant");
        if (subject.projectRoot === undefined) throw new Error("egress grant: no project to grant for");
        const projectRoot = canonicalProjectRoot(subject.projectRoot);
        await this.mutatePersistent((grants) => {
          if (grants.some((g) => g.scope === "project" && g.origin === "shell" && g.projectRoot === projectRoot && destinationKey(g) === key)) return grants;
          return [...grants, { scope: "project", origin: "shell", projectRoot, host: destination.host, port: destination.port, network: grantNetwork(destination), grantedAt: now.toISOString() }];
        });
        return;
      }
      case "always": {
        const origin = subject.origin;
        await this.mutatePersistent((grants) => {
          if (grants.some((g) => g.scope === "always" && g.origin === origin && destinationKey(g) === key)) return grants;
          return [...grants, { scope: "always", origin, host: destination.host, port: destination.port, network: grantNetwork(destination), grantedAt: now.toISOString() }];
        });
        return;
      }
    }
  }

  // Record that `subject.token` was let through to `destination` under this scope's grant, so revoking the grant can close what it let through. "Allow once" ends with its call and is not recorded.
  noteUse(scope: EgressGrantScope, subject: EgressGrantSubject, destination: EgressGrantDestination): void {
    let grant: RevocableEgressGrant;
    switch (scope) {
      case "once":
        return;
      case "session":
        if (subject.sessionId === undefined) return;
        grant = { scope, sessionId: subject.sessionId, host: destination.host, port: destination.port, network: grantNetwork(destination) };
        break;
      case "tab":
        if (subject.tabId === undefined) return;
        grant = { scope, tabId: subject.tabId, host: destination.host, port: destination.port, network: grantNetwork(destination) };
        break;
      case "project":
        if (subject.projectRoot === undefined) return;
        grant = { scope, origin: subject.origin, projectRoot: canonicalProjectRoot(subject.projectRoot), host: destination.host, port: destination.port, network: grantNetwork(destination) };
        break;
      case "always":
        grant = { scope, origin: subject.origin, host: destination.host, port: destination.port, network: grantNetwork(destination) };
        break;
    }
    addTo(this.uses, grantUseKey(grant), subject.token);
  }

  // Forget a released invocation's "Allow once" hosts and its grant uses.
  releaseToken(token: string): void {
    this.once.delete(token);
    for (const [key, tokens] of this.uses) {
      tokens.delete(token);
      if (tokens.size === 0) this.uses.delete(key);
    }
  }

  // Forget every "This tab" grant of a terminal tab whose shell ended (its tab closed). Returns the grants dropped.
  releaseTab(tabId: string): readonly TabEgressGrant[] {
    const dropped = this.listTab().filter((grant) => grant.tabId === tabId);
    this.tab.delete(tabId);
    for (const grant of dropped) this.uses.delete(grantUseKey(grant));
    return dropped;
  }

  // Forget every "This session" grant held by the sessions `ended` selects (a deleted conversation and, for a root, its sub-agents). Returns the grants dropped.
  releaseSessions(ended: (sessionId: string) => boolean): readonly SessionEgressGrant[] {
    const dropped = this.listSession().filter((grant) => ended(grant.sessionId));
    for (const sessionId of new Set(dropped.map((grant) => grant.sessionId))) this.session.delete(sessionId);
    for (const grant of dropped) this.uses.delete(grantUseKey(grant));
    return dropped;
  }

  // The "This session" grants held now, for Settings.
  listSession(): readonly SessionEgressGrant[] {
    const out: SessionEgressGrant[] = [];
    for (const [sessionId, grants] of this.session) {
      for (const [key, grantedAt] of grants) out.push({ scope: "session", sessionId, ...parseDestinationKey(key), grantedAt });
    }
    return out;
  }

  // The "This tab" grants held now, for Settings.
  listTab(): readonly TabEgressGrant[] {
    const out: TabEgressGrant[] = [];
    for (const [tabId, grants] of this.tab) {
      for (const [key, grantedAt] of grants) out.push({ scope: "tab", tabId, ...parseDestinationKey(key), grantedAt });
    }
    return out;
  }

  // Revoke one grant of any revocable scope. Resolves whether it existed and the live invocation tokens it had let through, whose open connections to that destination the caller closes.
  async revoke(target: RevocableEgressGrant): Promise<{ readonly removed: boolean; readonly tokens: readonly string[] }> {
    let removed: boolean;
    if (target.scope === "session") {
      removed = removeGrant(this.session, target.sessionId, destinationKey(target));
    } else if (target.scope === "tab") {
      removed = removeGrant(this.tab, target.tabId, destinationKey(target));
    } else {
      removed = await this.revokePersistent(target);
    }
    const key = grantUseKey(target);
    const tokens = [...(this.uses.get(key) ?? [])];
    this.uses.delete(key);
    return { removed, tokens };
  }

  // The project and always grants, for Settings.
  async listPersistent(): Promise<readonly PersistentEgressGrant[]> {
    return [...(await this.loadPersistent())];
  }

  // Remove one persistent grant. Resolves true when it existed.
  private async revokePersistent(target: Pick<PersistentEgressGrant, "scope" | "origin" | "host" | "port" | "network" | "projectRoot">): Promise<boolean> {
    let removed = false;
    await this.mutatePersistent((grants) => {
      const kept = grants.filter((g) => {
        const same = g.scope === target.scope && g.origin === target.origin && destinationKey(g) === destinationKey(target) &&
          (g.scope === "always" || g.projectRoot === target.projectRoot);
        if (same) removed = true;
        return !same;
      });
      return kept;
    });
    return removed;
  }

  private async loadPersistent(): Promise<readonly PersistentEgressGrant[]> {
    if (this.persistent !== undefined) return this.persistent;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) {
        this.persistent = [];
        return this.persistent;
      }
      throw error;
    }
    const parsed = parseGrantFile(this.filePath, raw);
    for (const dropped of parsed.droppedLegacy) {
      const key = `${dropped.workspaceRoot}\n${dropped.host}\n${dropped.port}`;
      if (this.reportedLegacyDrops.has(key)) continue;
      this.reportedLegacyDrops.add(key);
      this.onLegacyGrantDropped(dropped);
    }
    this.persistent = parsed.grants;
    return this.persistent;
  }

  private mutatePersistent(mutate: (grants: readonly PersistentEgressGrant[]) => readonly PersistentEgressGrant[]): Promise<void> {
    return this.writes(async () => {
      // Re-read under the queue so a second window's write is not lost.
      this.persistent = undefined;
      const next = [...mutate(await this.loadPersistent())];
      const file: GrantFile = { version: FILE_VERSION, grants: next };
      if (this.filePath === egressGrantFilePath()) await openFeatureNamespace("permissions").writeJson("shell-egress-hosts.json", file);
      else await writeFileAtomicAtPath(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
      this.persistent = next;
    });
  }
}

function addGrant(map: Map<string, Map<string, string>>, owner: string, key: string, now: Date): void {
  let grants = map.get(owner);
  if (grants === undefined) map.set(owner, (grants = new Map()));
  if (!grants.has(key)) grants.set(key, now.toISOString());
}

function removeGrant(map: Map<string, Map<string, string>>, owner: string, key: string): boolean {
  const grants = map.get(owner);
  const removed = grants?.delete(key) ?? false;
  if (grants !== undefined && grants.size === 0) map.delete(owner);
  return removed;
}

function addTo(map: Map<string, Set<string>>, owner: string, key: string): void {
  let set = map.get(owner);
  if (set === undefined) map.set(owner, (set = new Set()));
  set.add(key);
}

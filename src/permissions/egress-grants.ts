// Shell grants bind canonical destination, approved network class and origin; spelling/class changes cannot widen them and terminal grants never cover agent shells. Invocation/conversation/tab grants stay in memory; workspace/always persist until revoked. Terminal once means one connection, and tab grants end with the shell.
// Never consult these grants for workers or add them to runtime allowedDomains. Canonicalize workspace paths and strictly validate persisted shape; corrupt stores raise an error and the ask denies instead of silently dropping data.
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
import { canonicalizePathForMatch, foldCanonicalPathSeparators } from "./sensitive-paths.js";
import { maxEgressGrantScope, type EgressIdentityStrength } from "../shared/sandbox-capability-info.js";
import {
  EGRESS_GRANT_SCOPE_LADDERS,
  isEgressGrantScope,
  isEgressGrantNetwork,
  type EgressGrantNetwork,
  type EgressAskOrigin,
  type EgressGrantScope,
  type ConversationEgressGrant,
  type PersistentEgressGrant,
  type RevocableEgressGrant,
  type TabEgressGrant,
} from "../shared/egress-grant-scopes.js";

// The scopes an ask from this kind of process may offer on a host whose attribution is this strong, narrowest first. A shared identity (Windows srt-win: one account, one port range) can be presented by another invocation, so a grant there must not outlive the conversation (for a terminal: the tab) that made it: the cap keeps the in-memory rungs only.
export function egressGrantScopesFor(
  strength: EgressIdentityStrength,
  origin: EgressAskOrigin = "shell",
): readonly EgressGrantScope[] {
  const cap = maxEgressGrantScope(strength);
  if (cap === "always") return EGRESS_GRANT_SCOPE_LADDERS[origin];
  if (cap !== "conversation") throw new Error(`egress grant: unsupported scope cap ${cap}`);
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

// Use the most restrictive class across the canonical host and every pinned address: reserved metadata/link-local/unspecified/multicast/broadcast is never askable; local and unresolved upstream destinations cap grants to conversation/tab. Public may use broader scopes; show why restricted scopes apply.
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
  return scope === "workspace" || scope === "always";
}

// The scopes a grant for this kind of destination may take: none for a reserved one, only the in-memory ones (once, conversation, tab) for a local or unverified one, any for a public one.
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
  // The conversation ("This conversation"); undefined outside one, and always for a terminal.
  readonly sessionId: string | undefined;
  // The terminal tab ("This tab"); undefined for a shell tool call.
  readonly tabId: string | undefined;
  // The working directory "This workspace" keys on; undefined when unknown, and always for a terminal.
  readonly workspaceRoot: string | undefined;
  // Which kind of process asks: the only origin whose persistent grants it matches or makes.
  readonly origin: EgressAskOrigin;
}

// A working directory in the one form grants are stored and compared in.
function canonicalWorkspaceRoot(path: string): string {
  return canonicalizePathForMatch(path);
}

export class EgressGrantFileError extends Error {
  constructor(path: string, problem: string) {
    super(`shell egress grant file ${path} is not valid: ${problem}`);
    this.name = "EgressGrantFileError";
  }
}

interface GrantFile {
  readonly version: 1;
  readonly grants: PersistentEgressGrant[];
}

const FILE_VERSION = 1;

function parseGrantFile(path: string, raw: string): GrantFile {
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
  if (version !== FILE_VERSION) throw new EgressGrantFileError(path, `unsupported version ${String(version)}`);
  if (!Array.isArray(grants)) throw new EgressGrantFileError(path, "grants is not an array");
  return { version: FILE_VERSION, grants: grants.map((entry, index) => parseGrant(path, entry, index)) };
}

function parseGrant(path: string, entry: unknown, index: number): PersistentEgressGrant {
  const fail = (problem: string): never => {
    throw new EgressGrantFileError(path, `grants[${index}] ${problem}`);
  };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail("is not an object");
  const { scope, origin, workspaceRoot, host, port, network = "public", grantedAt, ...extra } = entry as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return fail(`has unknown field ${Object.keys(extra)[0]}`);
  if (scope !== "workspace" && scope !== "always") return fail("has a scope that is neither workspace nor always");
  if (origin !== "shell" && origin !== "terminal") return fail("has an origin that is neither shell nor terminal");
  if (scope === "workspace" && origin !== "shell") return fail("is a workspace grant not made by a shell call");
  // Shape only: the path is not resolved on disk here, so a directory that moved later just stops matching instead of making the file unreadable.
  if (scope === "workspace" && (typeof workspaceRoot !== "string" || foldCanonicalPathSeparators(resolve(workspaceRoot)) !== workspaceRoot)) {
    return fail("is a workspace grant without an absolute, normalised workspaceRoot");
  }
  if (scope === "always" && workspaceRoot !== undefined) return fail("is an always grant with a workspaceRoot");
  if (typeof host !== "string" || canonicalEgressHost(host) !== host) return fail("has a host that is not canonical");
  if (!isValidEgressPort(port)) return fail("has an invalid port");
  if (!isEgressGrantNetwork(network)) return fail("has an invalid network class");
  if (typeof grantedAt !== "string" || Number.isNaN(Date.parse(grantedAt))) return fail("has an invalid grantedAt");
  return scope === "workspace"
    ? { scope, origin, workspaceRoot: workspaceRoot as string, host, port, network, grantedAt }
    : { scope, origin, host, port, network, grantedAt };
}

export function egressGrantFilePath(): string {
  return join(openFeatureNamespace("permissions").dir, "shell-egress-hosts.json");
}

// The identity of one grant, for the tokens that used it.
function grantUseKey(grant: RevocableEgressGrant): string {
  const owner = grant.scope === "conversation" ? grant.sessionId
    : grant.scope === "tab" ? grant.tabId
    : grant.scope === "workspace" ? `${grant.origin}\n${grant.workspaceRoot ?? ""}` : grant.origin;
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
  private readonly conversation = new Map<string, Map<string, string>>();
  // Terminal tab id to destination key to the time it was granted.
  private readonly tab = new Map<string, Map<string, string>>();
  // Grant identity to the invocation tokens it let through (for closing them on revoke).
  private readonly uses = new Map<string, Set<string>>();
  private persistent: PersistentEgressGrant[] | undefined;
  private readonly writes = createSerialQueue();

  constructor(private readonly filePath: string = egressGrantFilePath()) {}

  // The narrowest eligible grant covering this destination for this subject, or undefined. The caller limits scopes by current identity, origin and network class. Throws EgressGrantFileError when the persistent file is invalid, so the caller can deny with that reason instead of guessing.
  async matchingScope(
    subject: EgressGrantSubject,
    destination: EgressGrantDestination,
    eligibleScopes: readonly EgressGrantScope[],
  ): Promise<EgressGrantScope | undefined> {
    const key = destinationKey(destination);
    if (eligibleScopes.includes("once") && this.once.get(subject.token)?.has(key)) return "once";
    if (eligibleScopes.includes("conversation") && subject.sessionId !== undefined && this.conversation.get(subject.sessionId)?.has(key)) return "conversation";
    if (eligibleScopes.includes("tab") && subject.tabId !== undefined && this.tab.get(subject.tabId)?.has(key)) return "tab";
    // Persistent grants of the subject's own origin only.
    const persistent = (await this.loadPersistent()).filter((grant) =>
      eligibleScopes.includes(grant.scope) && grant.origin === subject.origin && destinationKey(grant) === key
      && egressScopesForNetwork([grant.scope], grantNetwork(destination)).length > 0);
    const workspaceRoot = subject.workspaceRoot === undefined ? undefined : canonicalWorkspaceRoot(subject.workspaceRoot);
    if (workspaceRoot !== undefined && persistent.some((g) => g.scope === "workspace" && g.workspaceRoot === workspaceRoot)) return "workspace";
    if (persistent.some((g) => g.scope === "always")) return "always";
    return undefined;
  }

  // Record a grant. `allowedScopes` is what the ask offered; a scope outside it, or one the subject cannot hold (a conversation grant without a conversation, a tab grant without a tab, a workspace grant without a workspace), is an error, not a narrower grant.
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
      case "conversation":
        if (subject.sessionId === undefined) throw new Error("egress grant: no conversation to grant for");
        addGrant(this.conversation, subject.sessionId, key, now);
        return;
      case "tab":
        if (subject.tabId === undefined) throw new Error("egress grant: no terminal tab to grant for");
        addGrant(this.tab, subject.tabId, key, now);
        return;
      case "workspace": {
        if (subject.origin !== "shell") throw new Error("egress grant: only a shell call can hold a workspace grant");
        if (subject.workspaceRoot === undefined) throw new Error("egress grant: no workspace to grant for");
        const workspaceRoot = canonicalWorkspaceRoot(subject.workspaceRoot);
        await this.mutatePersistent((grants) => {
          if (grants.some((g) => g.scope === "workspace" && g.origin === "shell" && g.workspaceRoot === workspaceRoot && destinationKey(g) === key)) return grants;
          return [...grants, { scope: "workspace", origin: "shell", workspaceRoot, host: destination.host, port: destination.port, network: grantNetwork(destination), grantedAt: now.toISOString() }];
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
      case "conversation":
        if (subject.sessionId === undefined) return;
        grant = { scope, sessionId: subject.sessionId, host: destination.host, port: destination.port, network: grantNetwork(destination) };
        break;
      case "tab":
        if (subject.tabId === undefined) return;
        grant = { scope, tabId: subject.tabId, host: destination.host, port: destination.port, network: grantNetwork(destination) };
        break;
      case "workspace":
        if (subject.workspaceRoot === undefined) return;
        grant = { scope, origin: subject.origin, workspaceRoot: canonicalWorkspaceRoot(subject.workspaceRoot), host: destination.host, port: destination.port, network: grantNetwork(destination) };
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

  // The "This conversation" grants held now, for Settings.
  listConversation(): readonly ConversationEgressGrant[] {
    const out: ConversationEgressGrant[] = [];
    for (const [sessionId, grants] of this.conversation) {
      for (const [key, grantedAt] of grants) out.push({ scope: "conversation", sessionId, ...parseDestinationKey(key), grantedAt });
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
    if (target.scope === "conversation") {
      removed = removeGrant(this.conversation, target.sessionId, destinationKey(target));
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

  // The workspace and always grants, for Settings.
  async listPersistent(): Promise<readonly PersistentEgressGrant[]> {
    return [...(await this.loadPersistent())];
  }

  // Remove one persistent grant. Resolves true when it existed.
  private async revokePersistent(target: Pick<PersistentEgressGrant, "scope" | "origin" | "host" | "port" | "network" | "workspaceRoot">): Promise<boolean> {
    let removed = false;
    await this.mutatePersistent((grants) => {
      const kept = grants.filter((g) => {
        const same = g.scope === target.scope && g.origin === target.origin && destinationKey(g) === destinationKey(target) &&
          (g.scope === "always" || g.workspaceRoot === target.workspaceRoot);
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
    this.persistent = parseGrantFile(this.filePath, raw).grants;
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

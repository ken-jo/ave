/**
 * Shell egress grants: the hosts a person allowed a sandboxed shell to reach.
 *
 * The scopes are the ones the ask offers (design B, owner 2026-10-16):
 *
 *   | Scope          | Held                                   | Lifetime                         |
 *   |----------------|----------------------------------------|----------------------------------|
 *   | `once`         | per invocation token, in memory        | until that tool call ends        |
 *   | `conversation` | per conversation (session id), memory  | until the app restarts           |
 *   | `workspace`    | per working directory, on disk         | until revoked in Settings        |
 *   | `always`       | every workspace, on disk               | until revoked in Settings        |
 *
 * A grant names one destination, `host:port`, with the host canonicalised
 * the way a client's request is (lower case, no trailing dot, IPv6 without
 * brackets), so the spelling a command used cannot widen or miss a grant.
 *
 * Grants apply to shell tool calls only. They are never written into ASRT's
 * `allowedDomains` and never consulted for a plugin worker (invariant I4).
 *
 * The persistent half lives in `<AVE_HOME>/permissions/shell-egress-hosts.json`.
 * The file is validated strictly: anything that is not exactly the shape this
 * module writes is an error the caller sees (the ask callback then denies),
 * never a silently emptied or partially read store.
 */
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
import { writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { isMissingPathError } from "../lib/atomic-file.js";
import { createSerialQueue } from "../lib/with-file-lock.js";
import { aveHome } from "../shared/ave-home.js";
import { maxEgressGrantScope, type EgressIdentityStrength } from "../shared/sandbox-capability-info.js";
import {
  EGRESS_GRANT_SCOPES,
  isEgressGrantScope,
  type EgressGrantScope,
  type ConversationEgressGrant,
  type PersistentEgressGrant,
  type RevocableEgressGrant,
} from "../shared/egress-grant-scopes.js";

/**
 * The scopes a grant may take on a host whose attribution is this strong. A
 * shared identity (Windows srt-win: one account, one port range) can be
 * presented by another invocation, so a grant there must not outlive the
 * conversation that made it.
 */
export function egressGrantScopesFor(strength: EgressIdentityStrength): readonly EgressGrantScope[] {
  return EGRESS_GRANT_SCOPES.slice(0, EGRESS_GRANT_SCOPES.indexOf(maxEgressGrantScope(strength)) + 1);
}

/** One destination: a canonical host and a port. */
export interface EgressDestination {
  readonly host: string;
  readonly port: number;
}

/**
 * The canonical form of a destination host, or undefined for one that is not
 * a host name or an IP literal: ASRT's own `canonicalizeHost` (the spelling
 * its allow and deny lists are compared in: lower case, no trailing dot,
 * IPv6 compressed and unbracketed, an IPv4-mapped address as IPv4), since the
 * callback is handed the host as the client spelled it.
 */
export function canonicalEgressHost(host: string): string | undefined {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return undefined;
  const canonical = canonicalizeHost(host)?.toLowerCase();
  return canonical === undefined || canonical.length === 0 ? undefined : canonical;
}

/**
 * What kind of network a canonical destination host is on, judged from the
 * host alone (an IP literal or a loopback name; ASRT's resolved-address
 * guard judges the names a direct connection resolves):
 *
 *   - `reserved`: never reachable through the ask, whatever anyone answers —
 *     link-local (where most instance-metadata endpoints live), the cloud
 *     metadata addresses outside it, the unspecified address, multicast and
 *     broadcast.
 *   - `local`: this machine or a private network — loopback and
 *     `localhost`/`*.localhost`, RFC 1918, CGNAT (100.64/10), IPv6 ULA. An
 *     intranet host is a legitimate destination, so it may be asked about,
 *     but a grant for it never outlives the conversation and the card says
 *     what it is.
 *   - `public`: everything else.
 */
export type EgressDestinationNetwork = "public" | "local" | "reserved";

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
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7",
];

function rangeList(ranges: readonly string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    if (!addRange(list, range)) throw new Error(`egress destination ranges: invalid range ${range}`);
  }
  return list;
}
const RESERVED = rangeList(RESERVED_RANGES);
const LOCAL = rangeList(LOCAL_RANGES);

export function egressDestinationNetwork(canonicalHost: string): EgressDestinationNetwork {
  if (isLoopbackName(canonicalHost)) return "local";
  if (isIP(canonicalHost) === 0) return "public";
  // Before the embedded-IPv4 rule: `::1`'s IPv4-compatible form is 0.0.0.1.
  if (isLoopbackAddress(canonicalHost)) return "local";
  // An address that carries an IPv4 address (NAT64, 6to4, IPv4-compatible)
  // is delivered to that address, so it is judged by it as well.
  const addresses = [canonicalHost, embeddedIPv4(canonicalHost)].filter((a): a is string => a !== undefined);
  if (addresses.some((a) => addressInSet(RESERVED, a))) return "reserved";
  if (addresses.some((a) => isLoopbackAddress(a) || addressInSet(LOCAL, a))) return "local";
  return "public";
}

/** The scopes a grant for this kind of destination may take. */
export function egressScopesForNetwork(
  scopes: readonly EgressGrantScope[],
  network: EgressDestinationNetwork,
): readonly EgressGrantScope[] {
  if (network === "reserved") return [];
  return network === "local" ? scopes.filter((s) => s === "once" || s === "conversation") : scopes;
}

export function isValidEgressPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function destinationKey(destination: EgressDestination): string {
  return `${destination.host} ${destination.port}`;
}

/** Where a shell call that asks for a grant runs. */
export interface EgressGrantSubject {
  /** The invocation token ("Allow once"). */
  readonly token: string;
  /** The conversation ("This conversation"); undefined outside one. */
  readonly sessionId: string | undefined;
  /** The conversation's working directory ("This workspace"); undefined when unknown. */
  readonly workspaceRoot: string | undefined;
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
  const { scope, workspaceRoot, host, port, grantedAt, ...extra } = entry as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return fail(`has unknown field ${Object.keys(extra)[0]}`);
  if (scope !== "workspace" && scope !== "always") return fail("has a scope that is neither workspace nor always");
  if (scope === "workspace" && (typeof workspaceRoot !== "string" || resolve(workspaceRoot) !== workspaceRoot)) {
    return fail("is a workspace grant without an absolute, normalised workspaceRoot");
  }
  if (scope === "always" && workspaceRoot !== undefined) return fail("is an always grant with a workspaceRoot");
  if (typeof host !== "string" || canonicalEgressHost(host) !== host) return fail("has a host that is not canonical");
  if (!isValidEgressPort(port)) return fail("has an invalid port");
  if (typeof grantedAt !== "string" || Number.isNaN(Date.parse(grantedAt))) return fail("has an invalid grantedAt");
  return scope === "workspace"
    ? { scope, workspaceRoot: workspaceRoot as string, host, port, grantedAt }
    : { scope, host, port, grantedAt };
}

function defaultEgressGrantFilePath(): string {
  return join(aveHome(), "permissions", "shell-egress-hosts.json");
}


/** The identity of one grant, for the tokens that used it. */
function grantUseKey(grant: RevocableEgressGrant): string {
  const owner = grant.scope === "conversation" ? grant.sessionId : grant.scope === "workspace" ? grant.workspaceRoot ?? "" : "";
  return `${grant.scope}\n${owner}\n${grant.host} ${grant.port}`;
}

export class EgressGrantStore {
  private readonly once = new Map<string, Set<string>>();
  /** Session id to destination key to the time it was granted. */
  private readonly conversation = new Map<string, Map<string, string>>();
  /** Grant identity to the invocation tokens it let through (for closing them on revoke). */
  private readonly uses = new Map<string, Set<string>>();
  private persistent: PersistentEgressGrant[] | undefined;
  private readonly writes = createSerialQueue();

  constructor(private readonly filePath: string = defaultEgressGrantFilePath()) {}

  /**
   * The scope of a grant that covers this destination for this subject, or
   * undefined. Throws EgressGrantFileError when the persistent file is not
   * valid, so the caller can deny with that reason instead of guessing.
   */
  async matchingScope(subject: EgressGrantSubject, destination: EgressDestination): Promise<EgressGrantScope | undefined> {
    const key = destinationKey(destination);
    if (this.once.get(subject.token)?.has(key)) return "once";
    if (subject.sessionId !== undefined && this.conversation.get(subject.sessionId)?.has(key)) return "conversation";
    const persistent = await this.loadPersistent();
    const workspaceRoot = subject.workspaceRoot === undefined ? undefined : resolve(subject.workspaceRoot);
    for (const grant of persistent) {
      if (grant.host !== destination.host || grant.port !== destination.port) continue;
      if (grant.scope === "workspace" && grant.workspaceRoot === workspaceRoot && workspaceRoot !== undefined) return "workspace";
    }
    for (const grant of persistent) {
      if (grant.host === destination.host && grant.port === destination.port && grant.scope === "always") return "always";
    }
    return undefined;
  }

  /**
   * Record a grant. `allowedScopes` is what the ask offered; a scope outside
   * it, or one the subject cannot hold (a conversation grant without a
   * conversation, a workspace grant without a workspace), is an error, not a
   * narrower grant.
   */
  async grant(
    scope: EgressGrantScope,
    allowedScopes: readonly EgressGrantScope[],
    subject: EgressGrantSubject,
    destination: EgressDestination,
    now: Date = new Date(),
  ): Promise<void> {
    if (!isEgressGrantScope(scope)) throw new Error(`egress grant: unknown scope ${String(scope)}`);
    if (!allowedScopes.includes(scope)) throw new Error(`egress grant: scope ${scope} was not offered`);
    if (canonicalEgressHost(destination.host) !== destination.host) throw new Error("egress grant: host is not canonical");
    if (!isValidEgressPort(destination.port)) throw new Error("egress grant: invalid port");
    const key = destinationKey(destination);
    switch (scope) {
      case "once":
        addTo(this.once, subject.token, key);
        return;
      case "conversation": {
        if (subject.sessionId === undefined) throw new Error("egress grant: no conversation to grant for");
        let grants = this.conversation.get(subject.sessionId);
        if (grants === undefined) this.conversation.set(subject.sessionId, (grants = new Map()));
        if (!grants.has(key)) grants.set(key, now.toISOString());
        return;
      }
      case "workspace": {
        if (subject.workspaceRoot === undefined) throw new Error("egress grant: no workspace to grant for");
        const workspaceRoot = resolve(subject.workspaceRoot);
        await this.mutatePersistent((grants) => {
          if (grants.some((g) => g.scope === "workspace" && g.workspaceRoot === workspaceRoot && g.host === destination.host && g.port === destination.port)) return grants;
          return [...grants, { scope: "workspace", workspaceRoot, host: destination.host, port: destination.port, grantedAt: now.toISOString() }];
        });
        return;
      }
      case "always":
        await this.mutatePersistent((grants) => {
          if (grants.some((g) => g.scope === "always" && g.host === destination.host && g.port === destination.port)) return grants;
          return [...grants, { scope: "always", host: destination.host, port: destination.port, grantedAt: now.toISOString() }];
        });
        return;
    }
  }

  /**
   * Record that `subject.token` was let through to `destination` under this
   * scope's grant, so revoking the grant can close what it let through.
   * "Allow once" ends with its call and is not recorded.
   */
  noteUse(scope: EgressGrantScope, subject: EgressGrantSubject, destination: EgressDestination): void {
    let grant: RevocableEgressGrant;
    switch (scope) {
      case "once":
        return;
      case "conversation":
        if (subject.sessionId === undefined) return;
        grant = { scope, sessionId: subject.sessionId, host: destination.host, port: destination.port };
        break;
      case "workspace":
        if (subject.workspaceRoot === undefined) return;
        grant = { scope, workspaceRoot: resolve(subject.workspaceRoot), host: destination.host, port: destination.port };
        break;
      case "always":
        grant = { scope, host: destination.host, port: destination.port };
        break;
    }
    addTo(this.uses, grantUseKey(grant), subject.token);
  }

  /** Forget a released invocation's "Allow once" hosts and its grant uses. */
  releaseToken(token: string): void {
    this.once.delete(token);
    for (const [key, tokens] of this.uses) {
      tokens.delete(token);
      if (tokens.size === 0) this.uses.delete(key);
    }
  }

  /** The "This conversation" grants held now, for Settings. */
  listConversation(): readonly ConversationEgressGrant[] {
    const out: ConversationEgressGrant[] = [];
    for (const [sessionId, grants] of this.conversation) {
      for (const [key, grantedAt] of grants) {
        const space = key.lastIndexOf(" ");
        out.push({ scope: "conversation", sessionId, host: key.slice(0, space), port: Number(key.slice(space + 1)), grantedAt });
      }
    }
    return out;
  }

  /**
   * Revoke one grant of any revocable scope. Resolves whether it existed and
   * the live invocation tokens it had let through, whose open connections to
   * that destination the caller closes.
   */
  async revoke(target: RevocableEgressGrant): Promise<{ readonly removed: boolean; readonly tokens: readonly string[] }> {
    let removed: boolean;
    if (target.scope === "conversation") {
      const grants = this.conversation.get(target.sessionId);
      removed = grants?.delete(destinationKey(target)) ?? false;
      if (grants !== undefined && grants.size === 0) this.conversation.delete(target.sessionId);
    } else {
      removed = await this.revokePersistent(target);
    }
    const key = grantUseKey(target);
    const tokens = [...(this.uses.get(key) ?? [])];
    this.uses.delete(key);
    return { removed, tokens };
  }

  /** The workspace and always grants, for Settings. */
  async listPersistent(): Promise<readonly PersistentEgressGrant[]> {
    return [...(await this.loadPersistent())];
  }

  /** Remove one persistent grant. Resolves true when it existed. */
  private async revokePersistent(target: Pick<PersistentEgressGrant, "scope" | "host" | "port" | "workspaceRoot">): Promise<boolean> {
    let removed = false;
    await this.mutatePersistent((grants) => {
      const kept = grants.filter((g) => {
        const same = g.scope === target.scope && g.host === target.host && g.port === target.port &&
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
      await writeFileAtomicAtPath(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
      this.persistent = next;
    });
  }
}

function addTo(map: Map<string, Set<string>>, owner: string, key: string): void {
  let set = map.get(owner);
  if (set === undefined) map.set(owner, (set = new Set()));
  set.add(key);
}

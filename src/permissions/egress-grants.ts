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
import { writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { isMissingPathError } from "../lib/atomic-file.js";
import { createSerialQueue } from "../lib/with-file-lock.js";
import { aveHome } from "../shared/ave-home.js";
import type { EgressIdentityStrength } from "./egress-identity.js";
import {
  EGRESS_GRANT_SCOPES,
  isEgressGrantScope,
  type EgressGrantScope,
  type PersistentEgressGrant,
} from "../shared/egress-grant-scopes.js";

/**
 * The scopes a grant may take on a host whose attribution is this strong. A
 * shared identity (Windows srt-win: one account, one port range) can be
 * presented by another invocation, so a grant there must not outlive the
 * conversation that made it.
 */
export function egressGrantScopesFor(strength: EgressIdentityStrength): readonly EgressGrantScope[] {
  return strength === "kernel-channel" ? EGRESS_GRANT_SCOPES : ["once", "conversation"];
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

export class EgressGrantStore {
  private readonly once = new Map<string, Set<string>>();
  private readonly conversation = new Map<string, Set<string>>();
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
      case "conversation":
        if (subject.sessionId === undefined) throw new Error("egress grant: no conversation to grant for");
        addTo(this.conversation, subject.sessionId, key);
        return;
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

  /** Forget a released invocation's "Allow once" hosts. */
  releaseToken(token: string): void {
    this.once.delete(token);
  }

  /** The workspace and always grants, for Settings. */
  async listPersistent(): Promise<readonly PersistentEgressGrant[]> {
    return [...(await this.loadPersistent())];
  }

  /** Remove one persistent grant. Resolves true when it existed. */
  async revokePersistent(target: Pick<PersistentEgressGrant, "scope" | "host" | "port" | "workspaceRoot">): Promise<boolean> {
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

/**
 * The egress ask callback: the one gate between a sandboxed process and a
 * host that no configured rule allows (design B, PR 4).
 *
 * ASRT runs with `strictAllowlist: false` and an empty `allowedDomains`, so
 * every connection a sandboxed process opens through the proxy reaches this
 * callback. It decides by who opened the connection:
 *
 *   | Who (by the invocation's identity)       | Decision                                               |
 *   |------------------------------------------|--------------------------------------------------------|
 *   | no identity, an unknown token, or (macOS/Linux) an identity the listener does not vouch for | deny, "unattributed connection" |
 *   | plugin worker, host its extension declares (or the model endpoint) | allow                          |
 *   | plugin worker, any other host            | deny, never asks, never sees a shell grant (I4)        |
 *   | workspace terminal                       | deny with a fixed reason until the tab banner (PR 5)   |
 *   | shell, host a grant covers               | allow                                                  |
 *   | shell, asks turned off                   | deny                                                   |
 *   | shell, nobody can answer (background)    | deny (I5)                                              |
 *   | shell, otherwise                         | ask; allow only on an explicit allow                   |
 *
 * It fails closed: anything that throws is a deny, and only the literal
 * `true` allows (ASRT 0.0.80 reads every other value as a deny, and
 * `{ allow: false, reason }` as a deny with that reason, which ASRT records in
 * its violation store and the deny monitor writes to the audit log).
 *
 * Every decision also writes an `egress-decision` audit row saying how it was
 * reached.
 */
import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import { matchesDomainPatternWithPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import type { SandboxEgressDecisionAuditEntry, EgressDecisionBasis } from "../audit/sandbox-audit.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { errorMessage } from "../shared/error-message.js";
import type { EgressIdentityStrength } from "../shared/sandbox-capability-info.js";
import type { EgressInvocationOwner, ShellEgressOwner } from "./egress-invocations.js";
import {
  canonicalEgressHost,
  egressDestinationNetwork,
  egressScopesForNetwork,
  type EgressDestinationNetwork,
  egressGrantScopesFor,
  isValidEgressPort,
  type EgressDestination,
  type EgressGrantStore,
} from "./egress-grants.js";
import type { EgressGrantScope } from "../shared/egress-grant-scopes.js";
import { auditInvocationFor, noteCallbackDecision } from "./egress-deny-monitor.js";

/** What the person is asked about. */
export interface EgressApprovalRequest {
  readonly sessionId: string | undefined;
  readonly toolName: ShellEgressOwner["toolName"];
  readonly toolUseId: string | undefined;
  readonly destination: EgressDestination;
  /** The scopes the card offers, narrowest first; never empty. */
  readonly scopes: readonly EgressGrantScope[];
  /** `local`: this machine or a private network; the card says so, and offers no persistent scope. */
  readonly network: "public" | "local";
  /** Ends the ask (the call was cancelled or timed out). */
  readonly abortSignal: AbortSignal | undefined;
}

/** What the person answered. A deny carries why (their choice, a timeout, no surface). */
export type EgressApprovalAnswer =
  | { readonly allow: true; readonly scope: EgressGrantScope }
  | { readonly allow: false; readonly reason: string };

export type EgressApprovalRequester = (request: EgressApprovalRequest) => Promise<EgressApprovalAnswer>;

export interface EgressAskDeps {
  /** The identity strength of this kind of process on this host (`egressIdentityStrength`). */
  readonly identityStrength: (kind: "shell" | "extension") => EgressIdentityStrength;
  /** The live owner of a token (`egressInvocationOwner`). */
  readonly ownerOf: (token: string) => EgressInvocationOwner | undefined;
  /** The abort signal the token was opened with (`egressInvocationAbortSignal`). */
  readonly abortSignalOf: (token: string) => AbortSignal | undefined;
  /**
   * The hosts a worker may reach: its extension's declared domains plus the
   * model endpoints the host configured, as ASRT-style patterns (`d`, `*.d`,
   * optionally `:port`). `undefined` pluginId is a worker no extension owns.
   */
  readonly workerAllowedDomains: (pluginId: string | undefined) => readonly string[];
  readonly grants: EgressGrantStore;
  /** `features.shellEgressAsk`. Off: shells get granted hosts only and are never asked. */
  readonly shellAskEnabled: () => boolean;
  /** The approval surface, once the conversation layer has one; undefined before. */
  readonly requester: () => EgressApprovalRequester | undefined;
  /** Writes the decision row (`emitSandboxAudit`). */
  readonly audit: (entry: SandboxEgressDecisionAuditEntry) => void;
  readonly now?: () => Date;
}

/** Fixed refusal reasons, so the model and the audit log read the same words. */
export const EGRESS_DENY_REASONS = {
  unattributed: "unattributed connection",
  malformed: "malformed destination",
  workerOffList: "not on the extension's network allowlist",
  terminal: "network access from the terminal needs the tab's approval banner, which this version does not have yet",
  askOff: "host is not on the allow list (network asks are off)",
  headless: "host needs approval; unavailable in background run",
  noSurface: "host needs approval; no approval surface is available",
  failed: "network approval failed",
  reserved: "link-local, metadata, unspecified, multicast and broadcast addresses are never reachable from the sandbox",
} as const;

interface Decision {
  readonly allow: boolean;
  readonly basis: EgressDecisionBasis;
  readonly scope: EgressGrantScope | null;
  readonly reason: string | null;
}

const deny = (basis: EgressDecisionBasis, reason: string, scope: EgressGrantScope | null = null): Decision =>
  ({ allow: false, basis, scope, reason });
const allow = (basis: EgressDecisionBasis, scope: EgressGrantScope | null): Decision =>
  ({ allow: true, basis, scope, reason: null });

/**
 * Whether `host:port` matches one allowlist entry, by ASRT's own
 * `allowedDomains` matcher (`d` exactly, `*.d` strictly under `d`, `*`
 * anything, an optional `:port` suffix), so a worker reaches exactly what the
 * shared allowlist let it reach before the lists were split per extension.
 */
export function egressAllowlistMatches(entries: readonly string[], destination: EgressDestination): boolean {
  return entries.some((entry) =>
    typeof entry === "string" && matchesDomainPatternWithPort(destination.host, destination.port, entry));
}

export function createEgressAskCallback(deps: EgressAskDeps): SandboxAskCallback {
  const pendingAsks = new Map<string, Promise<Decision>>();
  const now = deps.now ?? (() => new Date());

  const askShell = (
    token: string,
    owner: ShellEgressOwner,
    destination: EgressDestination,
    network: Exclude<EgressDestinationNetwork, "reserved">,
  ): Promise<Decision> => {
    // One card per (invocation, destination): a client that opens several
    // connections to one host while the card is up waits on the same answer.
    const key = `${token}\n${destination.host}\n${destination.port}`;
    const pending = pendingAsks.get(key);
    if (pending !== undefined) return pending;
    const asking = (async (): Promise<Decision> => {
      const requester = deps.requester();
      if (requester === undefined) return deny("prompt", EGRESS_DENY_REASONS.noSurface);
      const scopes = egressScopesForNetwork(egressGrantScopesFor(deps.identityStrength("shell")), network).filter((scope) =>
        scope === "conversation" ? owner.context.sessionId !== undefined
        : scope === "workspace" ? owner.context.workspaceRoot !== undefined
        : true);
      const answer = await requester({
        sessionId: owner.context.sessionId,
        toolName: owner.toolName,
        toolUseId: owner.toolUseId,
        destination,
        scopes,
        network,
        abortSignal: deps.abortSignalOf(token),
      });
      if (!answer.allow) return deny("prompt", answer.reason);
      // A scope the card did not offer is the requester's bug, not a grant.
      const subject = { token, sessionId: owner.context.sessionId, workspaceRoot: owner.context.workspaceRoot };
      await deps.grants.grant(answer.scope, scopes, subject, destination);
      deps.grants.noteUse(answer.scope, subject, destination);
      return allow("prompt", answer.scope);
    })().finally(() => pendingAsks.delete(key));
    pendingAsks.set(key, asking);
    return asking;
  };

  const decide = async (
    host: string,
    port: number | undefined,
    context: Parameters<SandboxAskCallback>[1],
  ): Promise<{ owner: EgressInvocationOwner | undefined; decision: Decision }> => {
    const token = context?.attributionKey;
    if (token === undefined) return { owner: undefined, decision: deny("policy", EGRESS_DENY_REASONS.unattributed) };
    const owner = deps.ownerOf(token);
    if (owner === undefined) return { owner, decision: deny("policy", EGRESS_DENY_REASONS.unattributed) };
    // Where this kind of process has its own listener only the listener
    // vouches for who connected; a key that came from the proxy username
    // alone may have been read off another process, so it names nobody.
    if (deps.identityStrength(owner.kind === "worker" ? "extension" : "shell") === "kernel-channel"
      && context?.identity !== "listener") {
      return { owner: undefined, decision: deny("policy", EGRESS_DENY_REASONS.unattributed) };
    }
    const canonicalHost = canonicalEgressHost(host);
    if (canonicalHost === undefined || !isValidEgressPort(port)) {
      return { owner, decision: deny("policy", EGRESS_DENY_REASONS.malformed) };
    }
    const destination: EgressDestination = { host: canonicalHost, port };
    const network = egressDestinationNetwork(canonicalHost);
    if (network === "reserved") return { owner, decision: deny("policy", EGRESS_DENY_REASONS.reserved) };
    switch (owner.kind) {
      case "worker":
        return {
          owner,
          decision: egressAllowlistMatches(deps.workerAllowedDomains(owner.pluginId), destination)
            ? allow("extension-allowlist", null)
            : deny("policy", EGRESS_DENY_REASONS.workerOffList),
        };
      case "terminal":
        return { owner, decision: deny("policy", EGRESS_DENY_REASONS.terminal) };
      case "shell": {
        const subject = { token, sessionId: owner.context.sessionId, workspaceRoot: owner.context.workspaceRoot };
        const matched = await deps.grants.matchingScope(subject, destination);
        // A persistent grant never covers a local or private destination (none
        // is offered for one; this also holds for a hand-edited file).
        const granted = matched !== undefined && egressScopesForNetwork([matched], network).length > 0 ? matched : undefined;
        if (granted !== undefined) {
          deps.grants.noteUse(granted, subject, destination);
          return { owner, decision: allow("grant", granted) };
        }
        if (!deps.shellAskEnabled()) return { owner, decision: deny("policy", EGRESS_DENY_REASONS.askOff) };
        if (owner.context.approvalSurface !== "interactive") {
          return { owner, decision: deny("policy", EGRESS_DENY_REASONS.headless) };
        }
        return { owner, decision: await askShell(token, owner, destination, network) };
      }
    }
  };

  return async ({ host, port }, context) => {
    let owner: EgressInvocationOwner | undefined;
    let decision: Decision;
    try {
      ({ owner, decision } = await decide(host, port, context));
    } catch (error) {
      owner = context?.attributionKey === undefined ? undefined : deps.ownerOf(context.attributionKey);
      decision = deny("policy", `${EGRESS_DENY_REASONS.failed}: ${errorMessage(error)}`);
    }
    // The proxy logs this refusal; the deny monitor must not write a second decision row for it.
    if (!decision.allow) noteCallbackDecision(context?.attributionKey, host, port);
    try {
      deps.audit({
        timestamp: now().toISOString(),
        entryKind: "egress-decision",
        invocation: auditInvocationFor(owner),
        destination: { host: maskSensitiveData(String(host)).masked, port: port ?? null },
        decision: decision.allow ? "allow" : "deny",
        basis: decision.basis,
        scope: decision.scope,
        reason: decision.reason === null ? null : maskSensitiveData(decision.reason).masked,
      });
    } catch {
      // The audit sink reports its own failures; a row that could not be
      // written must not turn an answer into a different one.
    }
    return decision.allow ? true : { allow: false, reason: decision.reason ?? EGRESS_DENY_REASONS.failed };
  };
}

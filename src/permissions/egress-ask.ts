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
 * It is asked twice per connection (ASRT patch, name-first decisions). The
 * name phase sees the destination as named, before anything is resolved or
 * routed: every refusal the table above can reach without an address ends
 * there, so a destination that will be refused costs no DNS query and no
 * proxy lookup, and an interactive ask happens by name. Only a name-phase
 * allow leads to the resolved phase, which sees the addresses (or that the
 * upstream proxy resolves the name) and re-checks the destination's class:
 * a person's answer given on a card for one class (say, public) becomes a
 * grant only if the destination turned out to be that class; otherwise the
 * card is shown again with what it really is (this machine or a private
 * network, or unverified). Only final decisions are audited.
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
  /** `local`: this machine or a private network; `unverified`: the upstream proxy resolves the name. The card says so for both, and offers no persistent scope. */
  readonly network: "public" | "local" | "unverified";
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
  /** A name-phase allow: the resolved phase decides, and nothing is audited yet. */
  readonly provisional?: true;
}

/** A person's allow given by name, held until the resolved phase confirms the destination's class. */
interface HeldAnswer {
  readonly scope: EgressGrantScope;
  readonly scopes: readonly EgressGrantScope[];
  readonly network: Exclude<EgressDestinationNetwork, "reserved">;
  readonly at: number;
}

/** How long a held answer waits for its resolved phase, and how many are kept. */
const HELD_ANSWER_TTL_MS = 120_000;
const MAX_HELD_ANSWERS = 256;

const deny = (basis: EgressDecisionBasis, reason: string, scope: EgressGrantScope | null = null): Decision =>
  ({ allow: false, basis, scope, reason });
const allow = (basis: EgressDecisionBasis, scope: EgressGrantScope | null): Decision =>
  ({ allow: true, basis, scope, reason: null });
const provisional = (basis: EgressDecisionBasis, scope: EgressGrantScope | null): Decision =>
  ({ allow: true, basis, scope, reason: null, provisional: true });

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
  const now = deps.now ?? (() => new Date());

  const heldAnswers = new Map<string, HeldAnswer>();
  const holdKey = (token: string, destination: EgressDestination): string => `${token}\n${destination.host}\n${destination.port}`;
  const holdAnswer = (key: string, answer: HeldAnswer): void => {
    heldAnswers.delete(key);
    heldAnswers.set(key, answer);
    while (heldAnswers.size > MAX_HELD_ANSWERS) heldAnswers.delete(heldAnswers.keys().next().value!);
  };
  const takeHeldAnswer = (key: string): HeldAnswer | undefined => {
    const held = heldAnswers.get(key);
    heldAnswers.delete(key);
    return held !== undefined && now().getTime() - held.at < HELD_ANSWER_TTL_MS ? held : undefined;
  };

  type ShellAnswer =
    | { readonly allow: true; readonly scope: EgressGrantScope; readonly scopes: readonly EgressGrantScope[] }
    | { readonly allow: false; readonly decision: Decision };

  const pendingAsks = new Map<string, Promise<ShellAnswer>>();
  const askShell = (
    token: string,
    owner: ShellEgressOwner,
    destination: EgressDestination,
    network: Exclude<EgressDestinationNetwork, "reserved">,
  ): Promise<ShellAnswer> => {
    // One card per (invocation, destination, class): a client that opens
    // several connections to one host while the card is up waits on the same
    // answer.
    const key = `${token}\n${destination.host}\n${destination.port}\n${network}`;
    const pending = pendingAsks.get(key);
    if (pending !== undefined) return pending;
    const asking = (async (): Promise<ShellAnswer> => {
      const requester = deps.requester();
      if (requester === undefined) return { allow: false, decision: deny("prompt", EGRESS_DENY_REASONS.noSurface) };
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
      if (!answer.allow) return { allow: false, decision: deny("prompt", answer.reason) };
      return { allow: true, scope: answer.scope, scopes };
    })().finally(() => pendingAsks.delete(key));
    pendingAsks.set(key, asking);
    return asking;
  };

  /** Make the grant a person's answer chose, and allow. */
  const grantAnswer = async (
    token: string,
    owner: ShellEgressOwner,
    destination: EgressDestination,
    scope: EgressGrantScope,
    scopes: readonly EgressGrantScope[],
  ): Promise<Decision> => {
    // A scope the card did not offer is the requester's bug, not a grant.
    const subject = { token, sessionId: owner.context.sessionId, workspaceRoot: owner.context.workspaceRoot };
    await deps.grants.grant(scope, scopes, subject, destination);
    deps.grants.noteUse(scope, subject, destination);
    return allow("prompt", scope);
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
    const phase: unknown = context?.phase;
    let network: EgressDestinationNetwork;
    if (phase === "name") {
      // Nothing is resolved yet: the class the name alone says (an address
      // literal, localhost, a local-network name; any other name is public
      // until the resolved phase says otherwise).
      network = egressDestinationNetwork(canonicalHost);
    } else if (phase === "resolved") {
      // ASRT resolved the destination once and will dial exactly these
      // addresses, so a name is judged by what it resolved to as well.
      // Read as unknown: a JavaScript caller is not bound by the declared type.
      const raw = context as { addresses?: unknown; resolution?: unknown };
      const addresses: unknown = raw.addresses;
      const resolution: unknown = raw.resolution;
      if (!Array.isArray(addresses) || !addresses.every((a): a is string => typeof a === "string")
        || (resolution !== "pinned" && resolution !== "upstream")) {
        return { owner, decision: deny("policy", EGRESS_DENY_REASONS.malformed) };
      }
      // A name the upstream proxy resolves (this host could not, or a
      // plain-HTTP request names it to the upstream) was never checked: it is
      // offered at most This conversation, and no persistent grant covers it,
      // unless its name alone already says more.
      const judged = egressDestinationNetwork(canonicalHost, addresses);
      network = resolution === "upstream" && judged === "public" ? "unverified" : judged;
    } else {
      return { owner, decision: deny("policy", EGRESS_DENY_REASONS.malformed) };
    }
    if (network === "reserved") return { owner, decision: deny("policy", EGRESS_DENY_REASONS.reserved) };
    const resolvedPhase = phase === "resolved";
    const pass = (decision: Decision): Decision =>
      resolvedPhase || !decision.allow ? decision : provisional(decision.basis, decision.scope);
    switch (owner.kind) {
      case "worker":
        return {
          owner,
          decision: egressAllowlistMatches(deps.workerAllowedDomains(owner.pluginId), destination)
            ? pass(allow("extension-allowlist", null))
            : deny("policy", EGRESS_DENY_REASONS.workerOffList),
        };
      case "terminal":
        return { owner, decision: deny("policy", EGRESS_DENY_REASONS.terminal) };
      case "shell": {
        const subject = { token, sessionId: owner.context.sessionId, workspaceRoot: owner.context.workspaceRoot };
        const key = holdKey(token, destination);
        if (resolvedPhase) {
          // An answer given by name becomes a grant only for the class its card showed.
          const held = takeHeldAnswer(key);
          if (held !== undefined && held.network === network) {
            return { owner, decision: await grantAnswer(token, owner, destination, held.scope, held.scopes) };
          }
        }
        const matched = await deps.grants.matchingScope(subject, destination);
        // A persistent grant never covers a local or private destination (none
        // is offered for one; this also holds for a hand-edited file).
        const granted = matched !== undefined && egressScopesForNetwork([matched], network).length > 0 ? matched : undefined;
        if (granted !== undefined) {
          if (resolvedPhase) deps.grants.noteUse(granted, subject, destination);
          return { owner, decision: pass(allow("grant", granted)) };
        }
        if (!deps.shellAskEnabled()) return { owner, decision: deny("policy", EGRESS_DENY_REASONS.askOff) };
        if (owner.context.approvalSurface !== "interactive") {
          return { owner, decision: deny("policy", EGRESS_DENY_REASONS.headless) };
        }
        const answer = await askShell(token, owner, destination, network);
        if (!answer.allow) return { owner, decision: answer.decision };
        if (resolvedPhase) return { owner, decision: await grantAnswer(token, owner, destination, answer.scope, answer.scopes) };
        holdAnswer(key, { scope: answer.scope, scopes: answer.scopes, network, at: now().getTime() });
        return { owner, decision: provisional("prompt", answer.scope) };
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
    // A name-phase allow is not a decision yet: the resolved phase gives it.
    if (decision.provisional === true) return true;
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

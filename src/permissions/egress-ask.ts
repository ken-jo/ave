// Unknown/unvouched identities deny; workers reach only declared/model endpoints, never prompt or inherit shell grants. Shells require a matching grant or explicit foreground approval; disabled asks and unattended calls deny. Terminal asks use their tab and deny when unanswered.
// Decide by name before DNS/routing, then recheck the resolved destination class; changed classes require fresh consent. Match origin in both phases so shell/tab grants cannot cross. Exceptions and every value except literal true deny; audit each final decision with its reason.
import { AveHomeConfigurationRefusedWriteError } from "../shared/ave-home.js";
import type { ToolApprovalWait } from "../tools/executor-ceiling.js";
import type { NetworkPermissionEvaluation } from "./permission-manager.js";
import { NO_APPROVER_MESSAGE } from "./decision-pipeline.js";
import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import { matchesDomainPatternWithPort } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import type { SandboxEgressDecisionAuditEntry, EgressDecisionBasis } from "../audit/sandbox-audit.js";
import { maskSensitiveData, redactHomePathsInText } from "../audit/dlp-filter.js";
import { errorMessage } from "../shared/error-message.js";
import { createLogger } from "../lib/logger.js";
import type { EgressIdentityStrength } from "../shared/sandbox-capability-info.js";
import type { EgressInvocationOwner, ShellEgressContext, ShellEgressOwner, TerminalEgressOwner } from "./egress-invocations.js";
import {
  canonicalEgressHost,
  egressDestinationNetwork,
  egressScopesForNetwork,
  type EgressDestinationNetwork,
  egressGrantScopesFor,
  isValidEgressPort,
  type EgressDestination,
  type EgressGrantDestination,
  type EgressGrantStore,
  type EgressGrantSubject,
} from "./egress-grants.js";
import type { EgressAskOrigin, EgressGrantNetwork, EgressGrantScope } from "../shared/egress-grant-scopes.js";
import { auditInvocationFor, noteCallbackDecision } from "./egress-deny-monitor.js";
import { projectRuleRoot } from "./rules/project-rule-files.js";
import { observeAgentTerminalEgressDecision } from "../tools/agent-terminal-observation.js";

// Shell-tool and confined-terminal connections use their owning approval cards.
export type EgressApprovalRequest = EgressShellApprovalRequest | EgressTerminalApprovalRequest;

// A Bash or PowerShell tool call's ask, on the approval dock.
export interface EgressShellApprovalRequest extends EgressApprovalRequestCommon {
  readonly headless?: boolean;
  readonly ownerUnattended?: boolean;
  readonly toolApprovalWait?: ToolApprovalWait;
  readonly permissionContext?: ShellEgressContext["permissionContext"];
  readonly onNoApprover?: () => void;
  readonly evaluation?: ShellNetworkPermissionEvaluation;
  readonly approvalSurface?: "interactive" | "unavailable";
  readonly origin: "shell";
  readonly sessionId: string | undefined;
  readonly toolName: ShellEgressOwner["toolName"];
  readonly toolUseId: string | undefined;
  readonly workspaceRoot?: string;
}

// A confined terminal's ask, on its owning conversation's approval surface.
export interface EgressTerminalApprovalRequest extends EgressApprovalRequestCommon {
  readonly origin: "terminal";
  readonly tabId: string;
  readonly sessionId?: string;
}

interface EgressApprovalRequestCommon {
  readonly origin: EgressAskOrigin;
  readonly destination: EgressDestination;
  // The scopes the card offers, narrowest first; never empty.
  readonly scopes: readonly EgressGrantScope[];
  // `local`: this machine or a private network; `unverified`: the upstream proxy resolves the name. The card says so for both, and offers no persistent scope.
  readonly network: EgressGrantNetwork;
  // Ends the ask (the call was cancelled, the tab closed, or the banner timed out).
  readonly abortSignal: AbortSignal | undefined;
}

// How long a confined terminal's approval card holds a connection before denial.
const TERMINAL_EGRESS_ASK_TIMEOUT_MS = 120_000;

// What the person answered. A deny carries why (their choice, a timeout, no surface).
export type EgressApprovalAnswer =
  | { readonly allow: true; readonly scope: EgressGrantScope; readonly oneConnection?: true }
  | { readonly allow: false; readonly reason: string };

export type EgressApprovalRequester = (request: EgressApprovalRequest) => Promise<EgressApprovalAnswer>;

interface ShellNetworkPermissionRequest {
  readonly destination: EgressDestination;
  readonly context: ShellEgressContext;
  readonly network: EgressGrantNetwork;
  readonly scopes: readonly EgressGrantScope[];
  readonly rememberedGrant?: EgressGrantScope;
}

interface ShellNetworkPermissionEvaluation extends NetworkPermissionEvaluation {
  readonly policyEpoch: string;
  readonly approvalIdentity: string;
}

export type ShellNetworkPermissionEvaluator = (request: ShellNetworkPermissionRequest) => Promise<ShellNetworkPermissionEvaluation>;

export interface EgressAskDeps {
  // The identity strength of this kind of process on this host (`egressIdentityStrength`).
  readonly identityStrength: (kind: "shell" | "extension", context?: Parameters<SandboxAskCallback>[1]) => EgressIdentityStrength;
  // The live owner of a token (`egressInvocationOwner`).
  readonly ownerOf: (token: string) => EgressInvocationOwner | undefined;
  // The abort signal the token was opened with (`egressInvocationAbortSignal`).
  readonly abortSignalOf: (token: string) => AbortSignal | undefined;
  // The hosts a worker may reach: its extension's declared domains plus the model endpoints the host configured, as ASRT-style patterns (`d`, `*.d`, optionally `:port`). `undefined` pluginId is a worker no extension owns.
  readonly workerAllowedDomains: (pluginId: string | undefined) => readonly string[];
  readonly grants: EgressGrantStore;
  // Every actual shell connection re-enters the common pipeline before any standing host grant can authorize it.
  readonly evaluateShellPermission: ShellNetworkPermissionEvaluator;
  // Human-card availability; agent shells still apply rules, grants and automatic review before a no-approver fallback.
  readonly shellAskEnabled: () => boolean;
  // The approval surface, once the conversation layer has one; undefined before.
  readonly requester: () => EgressApprovalRequester | undefined;
  // Writes the decision row (`emitSandboxAudit`).
  readonly audit: (entry: SandboxEgressDecisionAuditEntry) => void;
  readonly now?: () => Date;
  // How long the terminal card waits for an answer; `TERMINAL_EGRESS_ASK_TIMEOUT_MS` unless a test shortens it.
  readonly terminalAskTimeoutMs?: number;
}

// Fixed refusal reasons, so the model and the audit log read the same words.
export const EGRESS_DENY_REASONS = {
  unattributed: "unattributed connection",
  malformed: "malformed destination",
  workerOffList: "not on the extension's network allowlist",
  offline: "outbound network is disabled for this service",
  terminalTimeout: "network approval timed out: nobody answered the terminal approval card within 120 seconds",
  askOff: "host is not on the allow list (network asks are off)",
  headless: NO_APPROVER_MESSAGE,
  noSurface: "host needs approval; no approval surface is available",
  failed: "network approval failed",
  reserved: "link-local, metadata, unspecified, multicast and broadcast addresses are never reachable from the sandbox",
  denyRule: "denied by host rule",
} as const;

interface Decision {
  readonly allow: boolean;
  readonly basis: EgressDecisionBasis;
  readonly scope: EgressGrantScope | null;
  readonly reason: string | null;
  // A name-phase allow: the resolved phase decides, and nothing is audited yet.
  readonly provisional?: true;
  // Names nobody: no record, observation or audit row carries the key or owner.
  readonly unattributed?: true;
}

// A person's allow given by name, held until the resolved phase confirms the destination's class.
interface HeldAnswer {
  readonly scope: EgressGrantScope;
  readonly scopes: readonly EgressGrantScope[];
  readonly network: Exclude<EgressDestinationNetwork, "reserved">;
  readonly at: number;
  readonly oneConnection?: true;
  readonly policyEpoch?: string;
  readonly approvalIdentity?: string;
}

// The verified invocation: its signal when its key was accepted, its number, and whether it is still that invocation.
interface LiveInvocation {
  readonly signal: AbortSignal | undefined;
  readonly generation: number;
  readonly live: () => boolean;
}

interface Verified {
  key?: string;
  owner?: EgressInvocationOwner;
  invocation?: LiveInvocation;
}

// How long a held answer waits for its resolved phase, and how many are kept.
const HELD_ANSWER_TTL_MS = 120_000;
const MAX_HELD_ANSWERS = 256;

const deny = (basis: EgressDecisionBasis, reason: string, scope: EgressGrantScope | null = null): Decision =>
  ({ allow: false, basis, scope, reason });
const allow = (basis: EgressDecisionBasis, scope: EgressGrantScope | null): Decision =>
  ({ allow: true, basis, scope, reason: null });
const provisional = (basis: EgressDecisionBasis, scope: EgressGrantScope | null): Decision =>
  ({ allow: true, basis, scope, reason: null, provisional: true });
const log = createLogger("egress-ask");

const unattributed = (): Decision =>
  ({ allow: false, basis: "policy", scope: null, reason: EGRESS_DENY_REASONS.unattributed, unattributed: true });

// A person's answer, before it becomes a grant: the scope chosen among those offered.
type AskAnswer =
  | { readonly allow: true; readonly scope: EgressGrantScope; readonly scopes: readonly EgressGrantScope[]; readonly oneConnection?: true; readonly policyEpoch?: string; readonly approvalIdentity?: string }
  | { readonly allow: false; readonly decision: Decision };

// Whether `host:port` matches one allowlist entry, by ASRT's own `allowedDomains` matcher (`d` exactly, `*.d` strictly under `d`, `*` anything, an optional `:port` suffix), so a worker reaches exactly what the shared allowlist let it reach before the lists were split per extension.
export function egressAllowlistMatches(entries: readonly string[], destination: EgressDestination): boolean {
  return entries.some((entry) =>
    typeof entry === "string" && matchesDomainPatternWithPort(destination.host, destination.port, entry));
}

// Who a grant for this owner is held for.
function grantSubject(token: string, owner: ShellEgressOwner | TerminalEgressOwner): EgressGrantSubject {
  return owner.kind === "shell"
    ? { token, sessionId: owner.context.sessionId, tabId: undefined, projectRoot: egressProjectRoot(owner.context.workspaceRoot), origin: "shell" }
    : { token, sessionId: owner.sessionId, tabId: owner.tabId, projectRoot: undefined, origin: "terminal" };
}

// The project a shell call's "This project" grant keys on: the repository root of its working directory, the same root a project `Bash(...)` rule applies to (five-choice cards). A relative working directory is a host contract violation and throws, which the callback turns into an audited deny.
function egressProjectRoot(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : projectRuleRoot(cwd);
}

// A terminal connection whose shared "Allow once" another connection already took: it asks again.
const ASK_AGAIN = Symbol("ask-again");

export function createEgressAskCallback(deps: EgressAskDeps): SandboxAskCallback {
  // The ask in flight per (invocation, destination). `onceTaken` marks a terminal's "Allow once" as spent: it lets exactly one connection through.
  const pendingAsks = new Map<string, { readonly answer: Promise<AskAnswer>; onceTaken: boolean }>();
  const now = deps.now ?? (() => new Date());
  const terminalAskTimeoutMs = deps.terminalAskTimeoutMs ?? TERMINAL_EGRESS_ASK_TIMEOUT_MS;

  // Each verified invocation's number, so a token that comes to name a later invocation never meets an earlier one's pending ask or held answer.
  const generations = new WeakMap<object, number>();
  let generationCount = 0;

  // Answers given by name, per (invocation, destination), one per connection that asked, waiting for that connection's resolved phase.
  const heldAnswers = new Map<string, HeldAnswer[]>();
  let heldCount = 0;
  const holdKey = (token: string, generation: number, destination: EgressDestination, strength: EgressIdentityStrength): string =>
    `${token}\n${generation}\n${destination.host}\n${destination.port}\n${strength}`;
  const holdAnswer = (key: string, answer: HeldAnswer): void => {
    // Bounded: past the cap the oldest held answers are dropped, and their connections are asked again in the resolved phase (never allowed).
    while (heldCount >= MAX_HELD_ANSWERS) {
      const oldest = heldAnswers.keys().next().value;
      if (oldest === undefined) break;
      heldCount -= heldAnswers.get(oldest)!.length;
      heldAnswers.delete(oldest);
    }
    const list = heldAnswers.get(key) ?? [];
    list.push(answer);
    heldAnswers.set(key, list);
    heldCount += 1;
  };
  const takeHeldAnswer = (key: string): HeldAnswer | undefined => {
    const list = heldAnswers.get(key);
    const held = list?.shift();
    if (held !== undefined) heldCount -= 1;
    if (list !== undefined && list.length === 0) heldAnswers.delete(key);
    return held !== undefined && now().getTime() - held.at < HELD_ANSWER_TTL_MS ? held : undefined;
  };

  const ask = async (
    token: string,
    generation: number,
    owner: ShellEgressOwner | TerminalEgressOwner,
    destination: EgressDestination,
    network: Exclude<EgressDestinationNetwork, "reserved">,
    strength: EgressIdentityStrength,
    evaluation?: ShellNetworkPermissionEvaluation,
  ): Promise<AskAnswer | typeof ASK_AGAIN> => {
    // One card (or banner) per (invocation, destination, class): a client that opens several connections to one host while it is up waits on the same answer. A terminal tab's shell is one invocation, so this coalesces per tab.
    const key = `${token}\n${generation}\n${destination.host}\n${destination.port}\n${network}\n${strength}\n${evaluation?.policyEpoch ?? ""}\n${evaluation?.approvalIdentity ?? ""}`;
    let pending = pendingAsks.get(key);
    if (pending === undefined) {
      const entry = { answer: startAsk(token, owner, destination, network, strength, evaluation).finally(() => pendingAsks.delete(key)), onceTaken: false };
      pendingAsks.set(key, entry);
      pending = entry;
    }
    const answer = await pending.answer;
    // A terminal's "Allow once" is one connection, never a standing grant: the first waiter takes it, any other connection that waited on the same banner goes back to asking.
    if (answer.allow && answer.scope === "once" && (owner.kind === "terminal" || answer.oneConnection)) {
      if (pending.onceTaken) return ASK_AGAIN;
      pending.onceTaken = true;
    }
    return answer;
  };

  const startAsk = async (
    token: string,
    owner: ShellEgressOwner | TerminalEgressOwner,
    destination: EgressDestination,
    network: Exclude<EgressDestinationNetwork, "reserved">,
    strength: EgressIdentityStrength,
    evaluation?: ShellNetworkPermissionEvaluation,
  ): Promise<AskAnswer> => {
    const requester = deps.requester();
    if (requester === undefined) {
      const noApprover = owner.kind === "shell" && (owner.context.headless || owner.context.approvalSurface === "unavailable" || !deps.shellAskEnabled());
      if (noApprover && owner.kind === "shell") owner.context.onNoApprover?.();
      return { allow: false, decision: deny("prompt", noApprover ? NO_APPROVER_MESSAGE : EGRESS_DENY_REASONS.noSurface) };
    }
    const subject = grantSubject(token, owner);
    const origin: EgressAskOrigin = owner.kind;
    const scopes = egressScopesForNetwork(egressGrantScopesFor(strength, origin), network).filter((scope) =>
      scope === "session" ? subject.sessionId !== undefined
      : scope === "tab" ? subject.tabId !== undefined
      : scope === "project" ? subject.projectRoot !== undefined
      : true);
    let answer: EgressApprovalAnswer;
    if (owner.kind === "shell") {
      answer = await requester({
        origin: "shell",
        workspaceRoot: owner.context.workspaceRoot,
        sessionId: owner.context.sessionId,
        toolName: owner.toolName,
        toolUseId: owner.toolUseId,
        headless: owner.context.headless === true,
        ownerUnattended: owner.context.ownerUnattended === true,
        ...(owner.context.toolApprovalWait ? { toolApprovalWait: owner.context.toolApprovalWait } : {}),
        ...(owner.context.permissionContext ? { permissionContext: owner.context.permissionContext } : {}),
        ...(owner.context.onNoApprover ? { onNoApprover: owner.context.onNoApprover } : {}),
        ...(evaluation ? { evaluation } : {}),
        approvalSurface: deps.shellAskEnabled() ? owner.context.approvalSurface : "unavailable",
        destination,
        scopes,
        network,
        abortSignal: deps.abortSignalOf(token),
      });
    } else {
      // The card holds the connection for a bounded time; shell teardown ends the pending ask immediately.
      const expiry = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        expiry.abort(new Error(EGRESS_DENY_REASONS.terminalTimeout));
      }, terminalAskTimeoutMs);
      const tabSignal = deps.abortSignalOf(token);
      try {
        answer = await requester({
          origin: "terminal",
          tabId: owner.tabId,
          ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
          destination,
          scopes,
          network,
          abortSignal: tabSignal === undefined ? expiry.signal : AbortSignal.any([tabSignal, expiry.signal]),
        });
      } finally {
        clearTimeout(timer);
      }
      if (timedOut && !answer.allow) answer = { allow: false, reason: EGRESS_DENY_REASONS.terminalTimeout };
    }
    if (!answer.allow) return { allow: false, decision: deny("prompt", answer.reason) };
    // A scope the card did not offer is the requester's bug, not a grant.
    if (!scopes.includes(answer.scope)) throw new Error(`egress grant: scope ${answer.scope} was not offered`);
    if (evaluation?.permission.forceModal && answer.scope !== "once") throw new Error("Forced network approval cannot create a standing grant");
    return { allow: true, scope: answer.scope, scopes,
      ...(answer.oneConnection || evaluation?.permission.forceModal ? { oneConnection: true as const } : {}),
      ...(evaluation ? { policyEpoch: evaluation.policyEpoch, approvalIdentity: evaluation.approvalIdentity } : {}) };
  };

  // Make the grant a person's answer chose, and allow.
  const grantAnswer = async (
    token: string,
    owner: ShellEgressOwner | TerminalEgressOwner,
    destination: EgressGrantDestination,
    scope: EgressGrantScope,
    scopes: readonly EgressGrantScope[],
    invocation: LiveInvocation,
    oneConnection?: true,
  ): Promise<Decision> => {
    // A terminal's "Allow once" is spent on the connection that asked; it is never held.
    if (scope === "once" && (owner.kind === "terminal" || oneConnection)) return allow("prompt", "once");
    const subject = grantSubject(token, owner);
    try {
      // The store commits nothing once the invocation's signal aborts before the write.
      await deps.grants.grant(scope, scopes, subject, destination, undefined, invocation.signal);
    } catch (error) {
      if (!invocation.live()) return unattributed();
      // A project or always grant cannot be kept while boot refuses the home folder; this connection is allowed once.
      if (!(error instanceof AveHomeConfigurationRefusedWriteError)) throw error;
      return allow("prompt", "once");
    }
    if (!invocation.live()) return unattributed();
    deps.grants.noteUse(scope, subject, destination);
    return allow("prompt", scope);
  };

  // `verified` receives the key, owner and liveness once the key's identity is accepted; nothing else is attributed to anyone.
  const decide = async (
    host: string,
    port: number | undefined,
    context: Parameters<SandboxAskCallback>[1],
    verified: Verified,
  ): Promise<Decision> => {
    const token = context?.attributionKey;
    if (token === undefined) return unattributed();
    const owner = deps.ownerOf(token);
    if (owner === undefined) return unattributed();
    // Where this kind of process has its own listener only the listener vouches for who connected; a key that came from the proxy username alone may have been read off another process, so it names nobody.
    const strength = deps.identityStrength(owner.kind === "worker" ? "extension" : "shell", owner.kind === "terminal" ? undefined : context);
    if ((strength === "kernel-channel" || (owner.kind === "shell" && owner.requiresListener === true))
      && context?.identity !== "listener") {
      return unattributed();
    }
    // An ended invocation keeps no authority: the token must still name this owner and the signal it had here, unaborted.
    const signal = deps.abortSignalOf(token);
    const identity: object = signal ?? owner;
    let generation = generations.get(identity);
    if (generation === undefined) {
      generation = ++generationCount;
      generations.set(identity, generation);
    }
    const invocation: LiveInvocation = {
      signal,
      generation,
      live: () => deps.ownerOf(token) === owner && deps.abortSignalOf(token) === signal && signal?.aborted !== true,
    };
    verified.key = token;
    verified.owner = owner;
    verified.invocation = invocation;
    if (owner.kind === "worker" && owner.network === "offline") return deny("policy", EGRESS_DENY_REASONS.offline);
    const canonicalHost = canonicalEgressHost(host);
    if (canonicalHost === undefined || !isValidEgressPort(port)) return deny("policy", EGRESS_DENY_REASONS.malformed);
    const destination: EgressDestination = { host: canonicalHost, port };
    const phase: unknown = context?.phase;
    let network: EgressDestinationNetwork;
    if (phase === "name") {
      // Nothing is resolved yet: the class the name alone says (an address literal, localhost, a local-network name; any other name is public until the resolved phase says otherwise).
      network = egressDestinationNetwork(canonicalHost);
    } else if (phase === "resolved") {
      // ASRT resolved the destination once and will dial exactly these addresses, so a name is judged by what it resolved to as well. Read as unknown: a JavaScript caller is not bound by the declared type.
      const raw = context as { addresses?: unknown; resolution?: unknown };
      const addresses: unknown = raw.addresses;
      const resolution: unknown = raw.resolution;
      if (!Array.isArray(addresses) || !addresses.every((a): a is string => typeof a === "string")
        || (resolution !== "pinned" && resolution !== "upstream")) {
        return deny("policy", EGRESS_DENY_REASONS.malformed);
      }
      // A name the upstream proxy resolves (this host could not, or a plain-HTTP request names it to the upstream) was never checked: it is offered at most This session, and no persistent grant covers it, unless its name alone already says more.
      const judged = egressDestinationNetwork(canonicalHost, addresses);
      network = resolution === "upstream" && judged === "public" ? "unverified" : judged;
    } else {
      return deny("policy", EGRESS_DENY_REASONS.malformed);
    }
    if (network === "reserved") return deny("policy", EGRESS_DENY_REASONS.reserved);
    const resolvedPhase = phase === "resolved";
    const pass = (decision: Decision): Decision =>
      resolvedPhase || !decision.allow ? decision : provisional(decision.basis, decision.scope);
    switch (owner.kind) {
      case "worker":
        return egressAllowlistMatches(deps.workerAllowedDomains(owner.pluginId), destination)
          ? pass(allow("extension-allowlist", null))
          : deny("policy", EGRESS_DENY_REASONS.workerOffList);
      case "terminal":
      case "shell": {
        // Matched by origin: a shell grant never covers a terminal, nor the reverse.
        const subject = grantSubject(token, owner);
        const grantDestination = { ...destination, network };
        const eligibleScopes = egressScopesForNetwork(egressGrantScopesFor(strength, owner.kind), network);
        const key = holdKey(token, invocation.generation, destination, strength);
        const granted = await deps.grants.matchingScope(subject, grantDestination, eligibleScopes);
        const evaluation = owner.kind === "shell" ? await deps.evaluateShellPermission({ destination,
          context: deps.shellAskEnabled() ? owner.context : { ...owner.context, approvalSurface: "unavailable" },
          network, scopes: eligibleScopes, ...(granted === undefined ? {} : { rememberedGrant: granted }) }) : undefined;
        // From here to the no-approver notice, the prompt, the held-answer take, the grant call or the use note nothing awaits, so an invocation that ended during the lookups above gets none of them.
        if (!invocation.live()) return unattributed();
        if (evaluation?.permission.decision === "deny") {
          if (evaluation.permission.reasonCode === "no-approver" && owner.kind === "shell") owner.context.onNoApprover?.();
          const ruleDenied = evaluation.rule?.decision === "deny";
          return deny(ruleDenied ? "rule" : "policy", ruleDenied ? `${EGRESS_DENY_REASONS.denyRule} ${evaluation.rule!.pattern}` : evaluation.permission.reason);
        }
        if (resolvedPhase) {
          // An answer given by name becomes a grant only for the class it was given for.
          const held = takeHeldAnswer(key);
          if (held !== undefined && held.network === network && (owner.kind === "terminal"
            || held.policyEpoch === evaluation?.policyEpoch && held.approvalIdentity === evaluation?.approvalIdentity)) {
            return await grantAnswer(token, owner, grantDestination, held.scope, held.scopes, invocation, held.oneConnection);
          }
        }
        if (owner.kind === "shell" && evaluation?.permission.decision === "allow") {
          if (granted !== undefined && evaluation.permission.reasonCode === "remembered-approval") {
            if (resolvedPhase) deps.grants.noteUse(granted, subject, grantDestination);
            return pass(allow("grant", granted));
          }
          return pass(allow(evaluation.rule?.decision === "allow" ? "rule" : "policy", null));
        }
        for (;;) {
          // Physical terminal grants remain outside agent policy. Shell grants have already passed the common pipeline.
          if (owner.kind === "terminal" && granted !== undefined) {
            if (resolvedPhase) deps.grants.noteUse(granted, subject, grantDestination);
            return pass(allow("grant", granted));
          }
          if (owner.kind === "terminal" && !deps.shellAskEnabled()) return deny("policy", EGRESS_DENY_REASONS.askOff);
          // Shell availability is resolved by the common pipeline: automatic review runs before a human fallback denies.
          const answer = await ask(token, invocation.generation, owner, destination, network, strength, evaluation);
          if (answer === ASK_AGAIN) return decide(host, port, context, verified);
          // An answer that arrives after the invocation ended grants nothing, and its refusal is not the invocation's.
          if (!invocation.live()) return unattributed();
          if (!answer.allow) return answer.decision;
          if (resolvedPhase) return await grantAnswer(token, owner, grantDestination, answer.scope, answer.scopes, invocation, answer.oneConnection);
          holdAnswer(key, { scope: answer.scope, scopes: answer.scopes, network, at: now().getTime(),
            ...(answer.oneConnection ? { oneConnection: true as const } : {}),
            ...(answer.policyEpoch ? { policyEpoch: answer.policyEpoch, approvalIdentity: answer.approvalIdentity } : {}) });
          return provisional("prompt", answer.scope);
        }
      }
    }
  };

  return async ({ host, port }, context) => {
    const verified: Verified = {};
    let decision: Decision;
    try {
      decision = await decide(host, port, context, verified);
    } catch (error) {
      if (verified.invocation?.live() === false) {
        // The refusal names nobody once the call ended; its failure is still kept for diagnosis.
        try {
          log.warn({ reason: redactHomePathsInText(maskSensitiveData(errorMessage(error)).masked) }, "egress decision failed after its invocation ended");
        } catch {
          // A failing log sink leaves the refusal and its audit row unchanged.
        }
        decision = unattributed();
      } else {
        decision = deny("policy", `${EGRESS_DENY_REASONS.failed}: ${errorMessage(error)}`);
      }
    }
    // Every allow, provisional, remembered and policy ones included, is given only to an invocation that is still live.
    if (decision.allow && verified.invocation?.live() !== true) decision = unattributed();
    const attributed: Verified = decision.unattributed === true ? {} : verified;
    const { key, owner } = attributed;
    // A name-phase allow is not a decision yet: the resolved phase gives it.
    if (decision.provisional === true) return true;
    // The proxy logs this refusal; the deny monitor must not write a second decision row for it.
    if (!decision.allow) noteCallbackDecision(key, host, port);
    observeAgentTerminalEgressDecision(key, {
      host: String(host), port: isValidEgressPort(port) ? port : null, decision: decision.allow ? "allow" : "deny",
      basis: decision.basis, scope: decision.scope, reason: decision.reason,
    });
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
      // The audit sink reports its own failures; a row that could not be written must not turn an answer into a different one.
    }
    if (decision.allow) return true;
    const reason = decision.reason ?? EGRESS_DENY_REASONS.failed;
    // A key that was not accepted must not attribute the proxy's record of this refusal either.
    return key === undefined && context?.attributionKey !== undefined ? { allow: false, reason, unattributed: true } : { allow: false, reason };
  };
}

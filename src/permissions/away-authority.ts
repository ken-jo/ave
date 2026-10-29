// Only a trusted local desk gesture arms bounded, in-memory, conversation/directory-scoped read/write authority; inbound platform messages are forgeable and cannot create or widen grants. Request nonce/HMAC never authenticates a remote choice, and local inputs/paths must not leave the machine.
// Answer allow-once inside the gate after all hard checks, never via rules or remote remembered allows; audit every call. Retire on disarm, expiry, budget exhaustion, any share lifecycle change or restart; recheck call authority and retire grants on re-pair so fresh pairing cannot inherit old consent.
import type { ToolCategory } from "../tools/types.js";
import type {
  RemoteControllerAuthority,
  RemoteControllerOrigin,
} from "../shared/chat-origin.js";
import {
  isRemoteControllerAuthorityCurrent,
  remoteControllerOriginOf,
} from "../shared/chat-origin.js";
import type { ApprovalChoice, ApprovalKind } from "./approval-gate.js";
import {
  isPathAllowed,
  sanitizeAllowedDirectories,
} from "./allowed-directories.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "./sensitive-paths.js";
import type { ToolSource } from "../shared/permission-review-status.js";

// Arm only canonical read/write categories: network enables exfiltration, shell effects are unbounded, and meta can spawn execution or remove the grant's own constraints.
type AwayAuthorityCategory = Extract<ToolCategory, "read" | "write">;

// TOTAL record over the armable categories, so widening AwayAuthorityCategory fails to compile until the new member is declared here too. This is the runtime membership test; there is no second list of these literals anywhere.
const ARMABLE_CATEGORIES: Record<AwayAuthorityCategory, true> = {
  read: true,
  write: true,
};

function isArmableCategory(value: unknown): value is AwayAuthorityCategory {
  return typeof value === "string"
    && Object.hasOwn(ARMABLE_CATEGORIES, value);
}

// Longest a single desk gesture may leave the answerer armed. A grant is a statement about how long the owner expects to be away, not a mode; there is no unbounded option because "until I turn it off" is exactly the grant nobody remembers to turn off.
const MAX_TTL_MS = 4 * 60 * 60 * 1000;

// Most calls one arming may answer before it retires itself.
const MAX_BUDGET = 50;

// What the desk asks for. Every field is validated before it becomes a grant.
export interface AwayAuthorityArmInput {
  // The conversation the desk armed for; asks from any other are refused.
  readonly conversationId: string;
  readonly categories: readonly string[];
  // Raw directory scope; sanitized to the Layer 1 canonical form.
  readonly directories: readonly string[];
  readonly ttlMs: number;
  readonly budget: number;
}

// A validated, frozen grant. Only parseAwayAuthorityGrant mints one.
export interface AwayAuthorityGrant {
  readonly conversationId: string;
  readonly categories: readonly AwayAuthorityCategory[];
  // Canonicalized + case-folded, ready for isPathAllowed.
  readonly directories: readonly string[];
  readonly expiresAt: number;
  readonly budget: number;
}

// The request fields the answerer reads. Assembled by the gate from the approval request and from host-only state; never from a message, a renderer payload, or provider output. `source` is the request's own field, kept optional on purpose so this module can apply a STRICT `=== "builtin"` test. `ApprovalGate.getRequestSnapshot` defaults a missing `source` to the high-trust `"builtin"` for approval-cache identity, which is conservative there and wrong here: an absent field would pass as builtin.
export interface AwayAuthorityCandidate {
  // Host-set audit marker for the controller behind the asking turn.
  readonly remoteControllerOrigin: RemoteControllerOrigin | undefined;
  // The live authority object; the only non-forgeable evidence of the turn.
  readonly remoteControllerAuthority: RemoteControllerAuthority | undefined;
  readonly sessionId: string | undefined;
  readonly source: ToolSource | undefined;
  readonly kind: ApprovalKind | undefined;
  readonly category: "tool" | "agent-action";
  readonly toolCategory: ToolCategory | undefined;
  readonly allowedChoices: readonly ApprovalChoice[] | undefined;
  // The gate's DERIVED capability, not the caller's requested value.
  readonly durableApprovalRecordAllowed: boolean;
  // Whether a host-shell one-shot permit binding rides with this request.
  readonly hostShellExecutionPermitBound: boolean;
  // Whether this request types into the user's own host terminal: a desktop-only decision.
  readonly hostTerminalBound: boolean;
  // EVERY path this call would touch, not just the one the modal displays. Plural because binding the first path alone is not a bound: `move_file` declares `["sourcePath", "destinationPath"]`, so an in-scope source would carry an out-of-scope destination past a singular check. An empty list is a call that names no path at all, which is refused rather than waved through — see AwayAuthority.targetScopeRefusal.
  readonly targetFilePaths: readonly string[];
}

// Why a call was not away-answered. A closed union: the value reaches an audit row, and audit rows are space-delimited `key=value` pairs, so nothing that could carry caller text may be written there.
type AwayAuthorityRefusal =
  | "not-armed"
  | "expired"
  | "not-platform-bridge"
  | "authority-not-current"
  | "conversation-mismatch"
  | "not-builtin-source"
  | "not-tool-request"
  | "category-not-armed"
  | "not-one-shot-contract"
  | "durable-record-allowed"
  | "host-shell-permit-bound"
  | "host-terminal-bound"
  | "target-unresolved"
  | "target-out-of-scope";

export type AwayAuthorityEvaluation =
  | {
      readonly answer: true;
      // Budget left AFTER this answer. `0` means the grant has just retired itself, which is the only moment exhaustion can be reported: once retired there is no grant left to explain why it stopped answering.
      readonly remaining: number;
    }
  | {
      readonly answer: false;
      readonly refusal: AwayAuthorityRefusal;
      // Whether this refusal is a fact about an armed grant rather than about an ordinary desk approval that was never the answerer's business. The gate audits only reportable refusals. Without this, either every desk approval in the app would write an "away declined" row, or an exhausted grant would silently let a remote turn block until timeout with nothing in the log explaining why. The distinction is decided here because this is where the reason is known.
      readonly reportable: boolean;
    };

// The refusal half of AwayAuthorityEvaluation, named so the internal "why not, or null" helpers can return exactly it without re-declaring the shape.
type AwayAuthorityRefusalOutcome = Extract<
  AwayAuthorityEvaluation,
  { answer: false }
>;

function refuse(
  refusal: AwayAuthorityRefusal,
  reportable: boolean,
): AwayAuthorityRefusalOutcome {
  return { answer: false, refusal, reportable };
}

// Validate a desk arming request into a grant, or return `null`. Every bound is enforced here so no other code has to re-check one. A grant that survives this function is safe for AwayAuthority to hold: its categories are armable, its directories are Layer 1 canonical and free of sensitive paths (via sanitizeAllowedDirectories), and its lifetime and budget are finite. A `write` grant with an empty directory scope is refused rather than normalized to "anywhere": isPathAllowed already denies on an empty scope, so such a grant could only ever refuse, and an armed-looking grant that can never answer is a worse outcome than a failed arming the desk can see and correct.
export function parseAwayAuthorityGrant(
  input: AwayAuthorityArmInput,
  now: number,
): AwayAuthorityGrant | null {
  if (!input || typeof input !== "object") return null;
  if (typeof input.conversationId !== "string" || input.conversationId.length === 0) {
    return null;
  }
  if (!Array.isArray(input.categories) || input.categories.length === 0) return null;
  if (!input.categories.every(isArmableCategory)) return null;
  const categories = [...new Set(input.categories)];
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_TTL_MS) {
    return null;
  }
  if (
    !Number.isInteger(input.budget)
    || input.budget <= 0
    || input.budget > MAX_BUDGET
  ) {
    return null;
  }
  if (!Array.isArray(input.directories)) return null;
  const directories = sanitizeAllowedDirectories(input.directories);
  // A rejected entry means the desk asked to arm something the Layer 1 sanitizer refuses (a sensitive path, a filesystem root). Arm nothing rather than arm the surviving subset: a partially honoured scope is a scope the owner did not agree to.
  if (directories.length !== input.directories.length) return null;
  if (categories.includes("write") && directories.length === 0) return null;
  return Object.freeze({
    conversationId: input.conversationId,
    categories: Object.freeze(categories),
    directories: Object.freeze(directories),
    expiresAt: now + input.ttlMs,
    budget: input.budget,
  });
}

// Read-only view of an armed grant, for surfaces that display its state.
export interface AwayAuthoritySnapshot {
  readonly conversationId: string;
  readonly categories: readonly AwayAuthorityCategory[];
  readonly directories: readonly string[];
  readonly expiresAt: number;
  readonly remaining: number;
}

// Holds at most one grant and decides every away answer. In-memory by design: a grant is a statement about the next few minutes, and a process restart is a change in circumstances the owner did not authorize through. Nothing here touches the filesystem.
export class AwayAuthority {
  private grant: AwayAuthorityGrant | null = null;
  private remaining = 0;

  // Replace any current grant with a validated one.
  arm(grant: AwayAuthorityGrant): void {
    this.grant = grant;
    this.remaining = grant.budget;
  }

  // Retire everything, whatever the reason: desk disarm, expiry, budget exhaustion, and — the case the per-call authority re-check cannot cover — the share lifecycle chokepoint, because a revoke/re-share/pause/ disconnect/re-pair mints a NEW authority that is perfectly current and that the earlier desk gesture never saw.
  retireAll(): boolean {
    const had = this.grant !== null;
    this.grant = null;
    this.remaining = 0;
    return had;
  }

  snapshot(): AwayAuthoritySnapshot | null {
    const grant = this.grant;
    if (grant === null) return null;
    return Object.freeze({
      conversationId: grant.conversationId,
      categories: grant.categories,
      directories: grant.directories,
      expiresAt: grant.expiresAt,
      remaining: this.remaining,
    });
  }

  // Decide a call and, when the answer is yes, spend one unit of budget. The single mutating entry point: there is no way to get an affirmative answer without the budget moving, so a caller cannot evaluate repeatedly and act on a stale yes.
  consume(candidate: AwayAuthorityCandidate, now: number): AwayAuthorityEvaluation {
    const refusal = this.refusalFor(candidate, now);
    if (refusal !== null) return refusal;
    const remaining = this.remaining - 1;
    this.remaining = remaining;
    // Spent means gone, in the same step that spent it. Leaving a zero-budget grant armed would mean a state that looks armed and can never answer, and it is the reason there is no "budget exhausted" refusal: after this line there is no grant for such a refusal to be about.
    if (remaining <= 0) this.retireAll();
    return { answer: true, remaining };
  }

  // Why this call may not be away-answered, or `null` when it may.
  private refusalFor(
    candidate: AwayAuthorityCandidate,
    now: number,
  ): AwayAuthorityRefusalOutcome | null {
    const grant = this.grant;
    // Not armed, or not a paired-platform turn: this is an ordinary approval that was never the answerer's business, so its refusal is not reportable.
    if (grant === null) return refuse("not-armed", false);

    // Origin comes from the authority object, which the conversation command port mints and which is the only non-forgeable evidence a remote controller is behind the turn. The host-set marker on the request must agree, because that marker is what the audit row will state: the answerer refuses to act on evidence that disagrees with the row it is about to write. Tailnet turns are excluded here by not being `platform-bridge` — a native controller session is a live operator at a keyboard, a different situation from an away owner, and it keeps its own local one-shot rule.
    const authorityOrigin = remoteControllerOriginOf(
      candidate.remoteControllerAuthority,
    );
    if (
      authorityOrigin !== "platform-bridge"
      || candidate.remoteControllerOrigin !== authorityOrigin
    ) {
      return refuse("not-platform-bridge", false);
    }

    // Everything below is reportable: an armed grant received a paired-platform ask, so why it did or did not answer is part of this grant's record.

    if (now >= grant.expiresAt) {
      this.retireAll();
      return refuse("expired", true);
    }

    // Re-checked HERE, not at request time. A share revoked while the turn was in flight must not be answered by a grant that was valid when the turn started.
    if (!isRemoteControllerAuthorityCurrent(candidate.remoteControllerAuthority)) {
      return refuse("authority-not-current", true);
    }

    if (
      candidate.sessionId === undefined
      || candidate.sessionId !== grant.conversationId
    ) {
      return refuse("conversation-mismatch", true);
    }

    // STRICT field test. Plugin and MCP tools are excluded by it: a third-party tool's declared category is not an authority boundary, so a plugin "read" is not evidence the call only reads. See the type comment for why `getRequestSnapshot` must not be used to answer this question.
    if (candidate.source !== "builtin") return refuse("not-builtin-source", true);

    // `undefined` or `"tool"` only. This is what excludes the remaining non-tool approval surfaces: - `out-of-allowed-dir` — a directory-scope grant. Widening the scope the grant itself is bounded by is the one thing it may never do. - `rationale` — a card whose entire purpose is that a human reads an explanation before deciding. Nobody is reading. - `agent-action` — a plugin-origin host request, not a host tool call; `category` catches the same class from the other side. MCP elicitations are renderer-only structured-content prompts that the desk fills in; they never reach an away answer, and `source` refuses them regardless.
    if (candidate.kind !== undefined && candidate.kind !== "tool") {
      return refuse("not-tool-request", true);
    }
    if (candidate.category !== "tool") return refuse("not-tool-request", true);

    if (
      candidate.toolCategory === undefined
      || !isArmableCategory(candidate.toolCategory)
      || !grant.categories.includes(candidate.toolCategory)
    ) {
      return refuse("category-not-armed", true);
    }

    // Exactly the two-member one-shot contract. This is the request-shape half of "can never mint a durable record": the gate's `resolve` path rejects any choice outside `allowedChoices`, and an away answer is issued as `allow-once` and returns before a pending entry is ever created.
    const choices = candidate.allowedChoices;
    if (
      choices === undefined
      || choices.length !== 2
      || !choices.includes("allow-once")
      || !choices.includes("deny-once")
    ) {
      return refuse("not-one-shot-contract", true);
    }
    // The state half of the same rule, read from the gate's DERIVED value. The one-shot contract above already forces this false today, so this line is an invariant assertion rather than an independently reachable branch — it is what makes a future change to that derivation fail closed here instead of quietly handing the answerer a durable-record capability.
    if (candidate.durableApprovalRecordAllowed) {
      return refuse("durable-record-allowed", true);
    }

    // A host-shell one-shot permit binding must never be minted by an away answer. The category check above already excludes it today, because the gate only retains a binding whose request is `toolCategory === "shell"` and shell is not armable. This check is what keeps that true if either of those two facts ever changes.
    if (candidate.hostShellExecutionPermitBound) {
      return refuse("host-shell-permit-bound", true);
    }
    // A host terminal command is decided by the person at this desktop, never by an away grant.
    if (candidate.hostTerminalBound) {
      return refuse("host-terminal-bound", true);
    }

    return this.targetScopeRefusal(grant, candidate);
  }

  // Every read or write must name at least one resolvable path and all paths must stay inside armed directories. Pathless reads can carry public egress, so they must wait for the desk rather than combine with an armed secret read.
  private targetScopeRefusal(
    grant: AwayAuthorityGrant,
    candidate: AwayAuthorityCandidate,
  ): AwayAuthorityRefusalOutcome | null {
    const raw = candidate.targetFilePaths;
    if (raw.length === 0) return refuse("target-unresolved", true);
    for (const path of raw) {
      if (typeof path !== "string" || path.length === 0) {
        return refuse("target-unresolved", true);
      }
      let folded: string;
      try {
        folded = caseFoldForMatch(canonicalizePathForMatch(path));
      } catch {
        return refuse("target-unresolved", true);
      }
      if (!isPathAllowed(folded, { directories: grant.directories })) {
        return refuse("target-out-of-scope", true);
      }
    }
    return null;
  }
}

/** Shared event payloads for `PERMISSIONS.*` IPC channels. Single source of truth for the wire shapes that cross the main↔renderer boundary on the permissions domain. Keeping these types in one module prevents drift
 * between the emitter (`permission-manager.ts`), the preload bridge (`preload.ts`), and any future renderer typings (`ui/renderer/types.ts`). Issue: #802 (code-reviewer LOW finding; inline duplicates across 3+ sites). */
import type { ShellRuleVersion } from "./shell-rule-version.js";
import type { RiskLevel } from "./permission-review-status.js";


/** Approval-scope literal. `session`: the root conversation, in memory. `persistent`: this project folder (the request's working directory),
 * on disk. `global`: every project, on disk (owner decision 2026-10-25, "Always allow everywhere" for exact tool approvals).
 * Approval-scope literal. Hoisted from inline `"session" | "persistent"` unions so renderer types
 * (`ui/renderer/types.ts`) can share the same SOT as the IPC payload. Cross-cutting follow-up of #802. */
export type UserApprovalScope = "session" | "persistent" | "global";

export type UserOwnedSurface = "browser" | "host-terminal";
export type UserOwnedSurfaceChoice = "allow" | "auto" | "ask";

export function isUserOwnedSurface(value: unknown): value is UserOwnedSurface {
  return value === "browser" || value === "host-terminal";
}

export function isUserOwnedSurfaceChoice(value: unknown): value is UserOwnedSurfaceChoice {
  return value === "allow" || value === "auto" || value === "ask";
}

export interface ScopedPermissionRuleError {
  filePath: string;
  errorCode: "rules-file-unavailable";
}

/** Why a stored rule is listed but never matched (see `storedRuleInvalidReason`). */
export type StoredRuleInvalidReason = "wildcard-not-allowlisted" | "retired-host-terminal";

/** Rule-store row with its host-owned persistence scope. */
export interface ScopedPermissionRule extends ShellRuleVersion {
  pattern: string;
  action: "allow" | "deny" | "ask";
  source?: string;
  scope: "user" | "project";
  projectCwd?: string;
  /** Stored identity of the project rules file a project row was read from. */
  storedFile?: string;
  /** Listed with this reason and removable, never matched. */
  invalidReason?: StoredRuleInvalidReason;
}

/** The shell dialects with a rule language: `Bash(...)` rules match bash, `PowerShell(...)` rules match PowerShell. */
export type ShellRuleDialect = "bash" | "powershell";

/** Where an approval card saves a rule (owner 2026-10-25, unified approval card): this conversation (in memory, ends with it), this project's rule file, or the user-global rules. */
export type ShellRuleSaveScope = "session" | "project" | "always";

export function isShellRuleSaveScope(value: unknown): value is ShellRuleSaveScope {
  return value === "session" || value === "project" || value === "always";
}

/** What a card sends to save a rule (`userApprovalRecord` `rule`): the action and scope of the choice and, only when the person edited it, the edited rule text. The host validates an edited rule against the card's own rule grammar and requires it to decide this very request; without one it stores the rule it derived itself. */
export interface ApprovalRuleSave {
  readonly action: "allow" | "deny";
  readonly scope: ShellRuleSaveScope;
  readonly pattern?: string;
}

/** A shell card's rule context (bash and PowerShell, Plan B and explicit host included). Each save stores `exactRule` (allow) or `denyRule` (Always deny) unless the person edits it; the host derives both from the live command and never takes them from the renderer. */
export interface ShellRuleApproval {
  /** Which rule language the card saves in. */
  dialect: ShellRuleDialect;
  /** The exact `Bash(<command>)` / `PowerShell(<command>)` rule the allow saves store, or null when this command cannot be saved as one (compound, irreversible, a floor, or it would disclose a secret). */
  exactRule: string | null;
  /** The exact rule "Always deny" stores unless edited: this command's literal argv, also for a floor or irreversible command (a deny only narrows). Null when the input is not one literal simple command; the person can still write one with Edit rule. */
  denyRule: string | null;
  /** "Always deny" is offered (every shell card except a remote-controller request). */
  denyAllowed: boolean;
  /** Execution directory the host matches and saves against. */
  projectCwd: string;
  /** Directory a project rule applies to (the repository root when one is found); display only. */
  projectRoot: string;
  /** The scripts the command hands to PowerShell as `-EncodedCommand`, decoded, for the card to show; absent when there are none. A command with
   * one never has an exact allow rule (its code is hidden in the command line). */
  decodedCommands?: readonly string[];
  /** "Allow for session" is offered: a saveable rule and a conversation to hold it. */
  sessionAllowed: boolean;
  /** "Always allow in this project" and "Always allow everywhere" are offered. */
  persistentAllowed: boolean;
}

/** Exact-tuple decision stored for a user-reviewed tool invocation. Legacy entries pre-date this field and therefore normalize to `"allow"`.
 * A stored deny is created only from Settings and is matched against the same tool + canonical input + source/trust tuple as an exact allow. */
export type UserApprovalDecision = "allow" | "deny";

/** The target a remembered decision covers when a tool opts into target-wide memory (`Tool.approvalMemoryScope`). Host-derived from the final input, and the only source the approval card uses to say what "remember" will cover. - `origin`: every web_fetch to `scheme://host:port`
 * (public network only). - `mcp-tool`: this server and tool, regardless of arguments; admission rules and mandatory approvals still apply. - `path`: this resolved path, any content. - `paths`: this exact resolved path set, any content. - `transfer`: this tool from source to destination, with its overwrite flag. - `command`: this exact shell command (by digest) in this working directory and sandbox plan; timeout and justification may vary. */
export type ApprovalMemoryScope =
  | { readonly kind: "mcp-tool"; readonly serverId: string; readonly toolName: string }
  | { readonly kind: "origin"; readonly origin: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  | {
      readonly kind: "transfer";
      readonly sourcePath: string;
      readonly destinationPath: string;
      readonly overwrite: boolean;
    }
  // A digest, not the command text: this scope reaches the renderer, where command text is only ever shown DLP-masked.
  | { readonly kind: "command"; readonly commandSha256: string; readonly cwd: string | null }
  // Browser actions on one page origin (`scheme://host:port`) in a tab the agent opened or a tab the user
  // opened. The opener is part of the scope: an approval for agent tabs never answers for the user's own tabs.
  | {
      readonly kind: "browser-origin";
      readonly origin: string;
      readonly tabOpener: BrowserTabOpener;
      /** The concrete target of this invocation, independent of origin memory. */
      readonly tabId?: string;
      readonly documentId?: number;
      readonly controlGeneration?: number;
    }
  // Closing tabs the agent opened. A user-opened tab is never covered.
  | { readonly kind: "browser-agent-tabs"; readonly tabId?: string; readonly documentId?: number; readonly controlGeneration?: number }
  // One exact command typed into one of the user's terminals, in the directory its shell reported. `tabId` is the concrete target of this invocation (resolved before the card is shown, so switching terminals while it is open cannot retarget it); a remembered decision
  // covers the command in that directory, for this app session only. `cwdForMatch` is that directory as the allowed-directory check compares it (realpath, case-folded where the file system folds case), for the card's "outside the allowed folders" note; it is derived from `cwd`.
  | {
      readonly kind: "terminal-command";
      readonly commandSha256: string;
      readonly tabId: string;
      readonly lane: "agent";
      readonly terminalSessionId: string;
      readonly sandboxGeneration: string;
      readonly cwd: string;
      readonly cwdForMatch: string;
    }
  // One exact command typed into the user's own host terminal by that tab's pane chat. Session surface choices do not widen this
  // target binding: every field is sealed before approval and rechecked immediately before the first byte is typed.
  | {
      readonly kind: "terminal-command";
      readonly lane: "manual";
      readonly commandSha256: string;
      readonly tabId: string;
      readonly terminalSessionId: string;
      /** The pane chat conversation that asked: only it may consume this approval and read the command's output. */
      readonly sessionId: string;
      /** The user-typed turn of that conversation that asked; the approval, the typing and the output belong to it alone. */
      readonly turnId: string;
      readonly shell: "zsh" | "bash";
      /** The directory the shell's markers reported, and the same directory as the operating system resolves it. */
      readonly cwd: string;
      readonly physicalCwd: string;
      /** Device and inode of `physicalCwd`, decimal; a replaced directory at the same path is a different target. */
      readonly cwdDevice: string;
      readonly cwdInode: string;
      /** The terminal's control generation when the card was built: a take-over or hand-back since then voids the approval. */
      readonly controlGeneration: number;
      readonly cwdForMatch: string;
    };

/** Who opened a browser tab: the agent (`browser_tab_new`) or the user. */
export type BrowserTabOpener = "agent" | "user";

/** Whether a remembered decision for `scope` may only live for this app session. Browser scopes are session-only: a page on an approved origin can steer the model into any action there, so no browser approval outlives the process (no
 * "always allow" for browser actions in v1). A terminal command is session-only too: it names one terminal's directory, and terminals do not outlive the app session. The approval card and the record handler both read this one predicate. */
export function isSessionOnlyApprovalMemoryScope(scope: ApprovalMemoryScope): boolean {
  return scope.kind === "browser-origin" || scope.kind === "browser-agent-tabs" || scope.kind === "terminal-command";
}

/** What a remembered user decision is keyed on, besides tool name, source, trust origin and working directory. - `args`: the exact canonical input (the default for every tool; an `approvalCacheKey` only narrows it). - `key`: the tool
 * opted in with a scope; `key` is the host-derived identity of that scope (including any sealed shell plan), and repeat calls with other arguments inside it may reuse the decision; after a fresh review unless the scope explicitly grants all arguments of one external tool (see approval-memory-skip.ts). */
export type ApprovalMemory =
  | { readonly kind: "args" }
  | { readonly kind: "key"; readonly key: string; readonly scope: ApprovalMemoryScope };

/** Approval-verdict literal. Same rationale as `UserApprovalScope`. NOTE: this is the verdict captured at approval time. Older on-disk entries (written before the field existed) may carry `null` in storage;
 * the broadcaster in `permission-manager.ts` coerces nullable stored values up to this non-null surface before emit so downstream consumers (the chat-toast subscriber) can rely on a concrete verdict literal. */
export type UserApprovalVerdict = RiskLevel;


/** Resolve the host-sealed risk level used by exact permission decisions. Approval surfaces use this same function when they hand a live request to Settings. Keeping the fallback here prevents renderer wording or a missing reviewer verdict from drifting away from the host snapshot.
 * Order: reviewer verdict, then the host-computed rule-classifier verdict (attached to unreviewed shell asks, so `ls` is LOW and `npm test` MEDIUM rather than a blanket HIGH), then the category fallback (`shell=high`; fail closed when no verdict was computed; `read=low`, else medium). */
export function resolveUserApprovalVerdict(input: {
  reviewerVerdict?: { level?: unknown };
  ruleVerdict?: { level?: unknown };
  toolCategory?: string;
}): UserApprovalVerdict {
  const reviewed = input.reviewerVerdict?.level;
  if (reviewed === "low" || reviewed === "medium" || reviewed === "high") {
    return reviewed;
  }
  const ruled = input.ruleVerdict?.level;
  if (ruled === "low" || ruled === "medium" || ruled === "high") {
    return ruled;
  }
  if (input.toolCategory === "shell") return "high";
  if (input.toolCategory === "read") return "low";
  return "medium";
}

/** Emitted on the `PERMISSIONS.userApprovalHit` channel when a memory hit auto-approves a tool call. The renderer surfaces this to the user as a non-blocking disclosure so the audit-trail intent of NL justification is preserved for subsequent auto-approves. Wire-shape boundary: this is a TYPE-level
 * contract only. Payloads crossing the IPC boundary are NOT structurally validated by importing this type. Main-side broadcasters and renderer-side listeners must each guard their direction if a wire-shape mismatch is security- relevant. (Cross-cutting review of PRs #822-#827; security-reviewer MINOR.) */
export interface UserApprovalHitPayload {
  toolName: string;
  scope: UserApprovalScope;
  verdictAtApproval: UserApprovalVerdict;
}

export type PermissionReviewSuggestionReason = "allow-always" | "repeat-allow";

/** Emitted when the foreground default-mode approval pattern suggests the user would benefit from switching to LLM-backed permission
 * review. This is a non-blocking hint; the renderer must require an explicit user gesture before mutating the permission/reviewer settings. */
export interface PermissionReviewSuggestionPayload {
  reason: PermissionReviewSuggestionReason;
  allowCount: number;
  allowAlwaysCount: number;
  threshold: number;
  windowMs: number;
}

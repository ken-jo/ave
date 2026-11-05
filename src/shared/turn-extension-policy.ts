/** AsyncLocalStorage preserves the originating controller boundary across executor, compaction, and lifecycle callbacks. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RemoteControllerAuthority } from "./chat-origin.js";
import type { ApprovalSurface } from "./authorization-required.js";
import type { PermissionCheckContext } from "../permissions/permission-manager.js";

export interface TurnExtensionPolicy {
  readonly allowExternalHooks: boolean;
  /** Host-owned unattended turn state, preserved across lifecycle callbacks. */
  readonly headless?: boolean;
  readonly ownerUnattended?: boolean;
  readonly approvalSurface?: ApprovalSurface;
  readonly remoteControllerAuthority?: RemoteControllerAuthority;
  readonly floor?: PermissionCheckContext["floor"];
  readonly overlayTriggerOrigin?: string | null;
  readonly abortSignal?: AbortSignal;
  /**
   * A scheduled run that wakes an existing chat (대화에 연결). Set only by the host's routine wake path, never from model or tool
   * input. Like every routine fire it does not inherit the conversation's session-bound authority (permission tree: delegated
   * work), so the session-scope lookups see no allow: remembered session approvals, session allow rules, session egress grants
   * and the shared browser/terminal choice (which falls back to Ask). Deny and ask rules are kept.
   */
  readonly withholdSessionAuthority?: boolean;
}

const DEFAULT_TURN_EXTENSION_POLICY: TurnExtensionPolicy = Object.freeze({
  allowExternalHooks: true,
});

export const turnExtensionPolicyContext = new AsyncLocalStorage<TurnExtensionPolicy>();

/** Derive policy only from a host-minted authority, never an input-origin string. */
export function resolveTurnExtensionPolicy(
  authority: RemoteControllerAuthority | undefined,
  headless = false,
  context: Omit<TurnExtensionPolicy, "allowExternalHooks" | "headless" | "remoteControllerAuthority"> = {},
): TurnExtensionPolicy {
  return Object.freeze({
    ...DEFAULT_TURN_EXTENSION_POLICY,
    ...context,
    headless,
    remoteControllerAuthority: authority,
    allowExternalHooks: true,
    // A turn started inside a scheduled wake (the woken turn itself, or a child it runs) keeps the host-set withhold.
    ...(turnExtensionPolicyContext.getStore()?.withholdSessionAuthority === true ? { withholdSessionAuthority: true } : {}),
  });
}

// The sessions a scheduled wake turn is running in right now, counted per wake. A lookup that names one of them withholds its session
// allows even when it runs outside the turn's async context (a callback, a timer, another module's queue). Host-only: the routine
// wiring adds a session when a wake starts and removes it in `finally`. Lookups also name their conversation root, so a background child
// the chat started earlier loses its session allows while the wake runs too. That is intended: conservative, and only for the wake.
const withheldSessions = new Map<string, number>();

// Child sessions a woken turn spawned or resumed. A child carries the withhold for the rest of the process's life, so a turn it runs
// after the wake has ended (a background child, a later resume) still reads no session allow.
const lifetimeWithheldSessions = new Set<string>();

/** Withhold `sessionId`'s session authority for the rest of this process: a child session started by a scheduled wake turn. */
export function withholdSessionAuthorityForLifetime(sessionId: string): void {
  lifetimeWithheldSessions.add(sessionId);
}

/** Withhold `sessionId`'s session authority until the returned release runs. Releasing twice is a no-op. */
export function withholdSessionAuthorityFor(sessionId: string): () => void {
  withheldSessions.set(sessionId, (withheldSessions.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (withheldSessions.get(sessionId) ?? 1) - 1;
    if (remaining > 0) withheldSessions.set(sessionId, remaining);
    else withheldSessions.delete(sessionId);
  };
}

/**
 * True when session-scope allows must not be read: inside a scheduled wake turn's async context (see
 * TurnExtensionPolicy.withholdSessionAuthority), or for a lookup naming a session a wake is running in.
 */
export function sessionAuthorityWithheld(...sessionIds: ReadonlyArray<string | undefined>): boolean {
  if (turnExtensionPolicyContext.getStore()?.withholdSessionAuthority === true) return true;
  return sessionIds.some((id) => id !== undefined && (withheldSessions.has(id) || lifetimeWithheldSessions.has(id)));
}

/** Outside controlled remote turns, hooks remain allowed. */
export function areExternalTurnHooksAllowed(): boolean {
  return turnExtensionPolicyContext.getStore()?.allowExternalHooks ?? true;
}

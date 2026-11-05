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
  });
}

/** True inside a scheduled wake turn: session-scope allows must not be read (see TurnExtensionPolicy.withholdSessionAuthority). */
export function sessionAuthorityWithheld(): boolean {
  return turnExtensionPolicyContext.getStore()?.withholdSessionAuthority === true;
}

/** Outside controlled remote turns, hooks remain allowed. */
export function areExternalTurnHooksAllowed(): boolean {
  return turnExtensionPolicyContext.getStore()?.allowExternalHooks ?? true;
}

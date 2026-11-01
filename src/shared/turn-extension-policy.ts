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

/** Outside controlled remote turns, hooks remain allowed. */
export function areExternalTurnHooksAllowed(): boolean {
  return turnExtensionPolicyContext.getStore()?.allowExternalHooks ?? true;
}

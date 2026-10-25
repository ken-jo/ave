/** AsyncLocalStorage preserves the originating controller boundary across executor, compaction, and lifecycle callbacks. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RemoteControllerAuthority } from "./chat-origin.js";

export interface TurnExtensionPolicy {
  readonly allowExternalHooks: boolean;
  /** Host-owned unattended turn state, preserved across lifecycle callbacks. */
  readonly headless?: boolean;
}

const DEFAULT_TURN_EXTENSION_POLICY: TurnExtensionPolicy = Object.freeze({
  allowExternalHooks: true,
});

const REMOTE_CONTROLLER_EXTENSION_POLICY: TurnExtensionPolicy = Object.freeze({
  // Remote turns cannot implicitly execute owner scripts or extension hooks; exact local tool approval remains separate.
  allowExternalHooks: false,
});

export const turnExtensionPolicyContext = new AsyncLocalStorage<TurnExtensionPolicy>();

/** Derive policy only from a host-minted authority, never an input-origin string. */
export function resolveTurnExtensionPolicy(
  authority: RemoteControllerAuthority | undefined,
  headless = false,
): TurnExtensionPolicy {
  return authority !== undefined
    ? REMOTE_CONTROLLER_EXTENSION_POLICY
    : headless ? { ...DEFAULT_TURN_EXTENSION_POLICY, headless: true } : DEFAULT_TURN_EXTENSION_POLICY;
}

/** Outside controlled remote turns, hooks remain allowed. */
export function areExternalTurnHooksAllowed(): boolean {
  return turnExtensionPolicyContext.getStore()?.allowExternalHooks ?? true;
}

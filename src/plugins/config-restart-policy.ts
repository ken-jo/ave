// Restart only when cleartext config changes and the caller can safely survive the restart.
// Only the runtime context is a snapshot; live secret and config readers do not become stale.

export interface PluginConfigWriteRestartInput {
  /** Whether the cleartext record feeding PluginRuntimeContext.config changed; keychain-only writes do not count. */
  mutatedCleartextConfig: boolean;
  /** Restart is unsafe if it destroys the caller or reenters a pending lifecycle mutation. */
  restartUnsafe: boolean;
}

export function shouldRestartAfterPluginConfigWrite(
  input: PluginConfigWriteRestartInput,
): boolean {
  return input.mutatedCleartextConfig && !input.restartUnsafe;
}

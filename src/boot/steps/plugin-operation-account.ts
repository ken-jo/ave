import { createHash } from "node:crypto";

interface PluginOperationAccountResolver {
  getPluginOperationAccountIdentity(
    pluginId: string,
    generationId: string,
  ): {
    readonly identityHash: string;
    readonly principalHash: string;
  } | undefined;
}

export interface ResolvedPluginOperationAccount {
  /** Revocable principal for one authenticated or anonymous generation session. */
  readonly accountHash: string;
  /** Stable, non-secret account identity used only for cross-generation serialization. */
  readonly accountScopeHash: string;
}

/** Stable account scope serializes operations across login generations; only the revocable principal grants authority. */
export function resolvePluginOperationAccount(
  resolver: PluginOperationAccountResolver,
  manifest: { readonly auth?: unknown } | undefined,
  pluginId: string,
  generationId: string,
): ResolvedPluginOperationAccount | undefined {
  const authenticated = resolver.getPluginOperationAccountIdentity(
    pluginId,
    generationId,
  );
  if (authenticated) {
    return {
      accountHash: authenticated.principalHash,
      accountScopeHash: authenticated.identityHash,
    };
  }
  if (manifest?.auth) return undefined;
  const accountScopeHash = createHash("sha256")
    .update("plugin-operation-anonymous-scope/v1\0")
    .update(pluginId)
    .digest("hex");
  const accountHash = createHash("sha256")
    .update("plugin-operation-anonymous/v1\0")
    .update(pluginId)
    .update("\0")
    .update(generationId)
    .digest("hex");
  return { accountHash, accountScopeHash };
}

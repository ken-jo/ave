/** Verify legacy receipts under the live registry’s contained plugin root; official grants use current snapshot pins. */
import { dirname } from "node:path";
import { OFFICIAL_MARKETPLACE } from "../../../marketplace/sources/official.js";
import { pinnedArtifactReader } from "../../../marketplace/sources/sync.js";
import { verifyInstallReceipt } from "../../../plugins/plugin-install-receipt.js";
import type { PluginPaths } from "../../../plugins/plugin-paths.js";
import { readPluginRegistry } from "../../../plugins/registry.js";
import { resolveTrustedRegistryManifestPath } from "../../../plugins/registry-manifest-trust.js";

export interface GrantEvidenceReader {
  officialPins(plugin: string, version: string): Promise<readonly string[]>;
  /** `artifactSha256` of `pluginId`'s verified install receipt; null when it has none or it does not verify. */
  receiptArtifactSha256(pluginId: string): Promise<string | null>;
  receiptReviewedAppVersion?(pluginId: string): Promise<string | null>;
}

export function grantEvidenceReader(input: {
  paths: Pick<PluginPaths, "cacheRoot" | "pluginsRoot" | "registryPath">;
  marketplacesRoot: string;
}): GrantEvidenceReader {
  return {
    officialPins: pinnedArtifactReader(input.marketplacesRoot, OFFICIAL_MARKETPLACE.id),
    receiptArtifactSha256: async (pluginId) => {
      const entry = (await readPluginRegistry(input.paths.registryPath)).plugins.find((item) => item.id === pluginId);
      if (!entry) return null;
      const manifestPath = resolveTrustedRegistryManifestPath(entry.manifestPath, input.paths.pluginsRoot);
      if (manifestPath === null) return null;
      const receipt = await verifyInstallReceipt(input.paths.cacheRoot, pluginId, dirname(manifestPath));
      return receipt.ok ? receipt.receipt.artifactSha256 : null;
    },
    receiptReviewedAppVersion: async (pluginId) => {
      const entry = (await readPluginRegistry(input.paths.registryPath)).plugins.find((item) => item.id === pluginId);
      if (!entry) return null;
      const manifestPath = resolveTrustedRegistryManifestPath(entry.manifestPath, input.paths.pluginsRoot);
      if (manifestPath === null) return null;
      const receipt = await verifyInstallReceipt(input.paths.cacheRoot, pluginId, dirname(manifestPath));
      return receipt.ok ? receipt.receipt.reviewedAppVersion ?? null : null;
    },
  };
}

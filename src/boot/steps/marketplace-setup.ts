/** Wire marketplace transactions and live configuration refreshes for settings changes. */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PluginMarketplaceService } from "../../plugins/marketplace.js";
import { activeHostApiVendor, createRefreshActiveLlmWildcard } from "./refresh-active-llm-wildcard.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import type { WorkerEgressAllowlists } from "../../permissions/egress-runtime.js";
import { errorMessage } from "../../shared/error-message.js";
import { aveHome } from "../../shared/ave-home.js";

const log = createLogger("ave");

/** Remove unused signed documents, catalogs, and package/download caches from the retired server marketplace. */
export function retiredMarketplaceCachePaths(input: {
  userDataPath: string;
  home: string;
  pluginCacheRoot: string;
}): string[] {
  const packageCacheRoots = [
    input.pluginCacheRoot,
    join(input.home, "mcp", ".cache"),
    join(input.home, "agents", ".cache"),
    join(input.home, "skills", ".cache"),
  ];
  return [
    ...["marketplace-admission", "marketplace-whitelist", "marketplace-revocation"].map((dir) => join(input.userDataPath, dir)),
    join(input.pluginCacheRoot, "marketplace-catalog"),
    ...packageCacheRoots.flatMap((root) => [join(root, ".tarballs"), join(root, "verified-downloads")]),
  ];
}

/** Removal is best effort; retry failures on the next boot. */
export async function removeRetiredMarketplaceCaches(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      log.warn({ path, err: errorMessage(error) }, "retired marketplace cache could not be removed");
    }
  }));
}

export async function setupMarketplace(ctx: BootContext): Promise<void> {
  const {
    settingsService,
    pluginPaths,
    deploymentGuard,
    pluginRuntime,
  } = ctx;

  const pluginMarketplace = new PluginMarketplaceService(pluginPaths, deploymentGuard);
  void removeRetiredMarketplaceCaches(retiredMarketplaceCachePaths({
    userDataPath: ctx.host.userDataPath,
    home: aveHome(),
    pluginCacheRoot: pluginPaths.cacheRoot,
  }));

  // Wildcard config exposes vendor identity only; secrets must pass the manifest-gated getSecret path.
  // Seed at boot and debounce loaded-plugin restarts when the vendor changes.
  const {
    refresh: refreshActiveLlmWildcard,
    dispose: disposeRefreshActiveLlmWildcard,
  } = createRefreshActiveLlmWildcard({
    getActiveVendor: () => activeHostApiVendor(settingsService.get("llm")),
    setWildcardConfigOverride: (config) => pluginRuntime.setWildcardConfigOverride(config),
    clearWildcardConfigOverride: (keys) => pluginRuntime.clearWildcardConfigOverride(keys),
    listPluginIds: () => pluginRuntime.listPluginIds(),
    restartPlugin: async (pid) => {
      await pluginRuntime.restartPlugin(pid);
    },
    cancelPendingRestarts: () => pluginRuntime.cancelAllPendingRestarts(),
  });
  refreshActiveLlmWildcard();

  // Worker egress uses its own extension domains plus resolved model endpoints; never share these with other workers or shells.
  // Keep the runtime-wide domain allow-list empty.
  const buildWorkerEgressAllowlists = async (): Promise<WorkerEgressAllowlists> => {
    const { computeDynamicEndpointHosts } = await import("../../permissions/asrt-sandbox.js");
    return {
      byExtension: new Map(
        pluginRuntime
          .listPluginIds()
          .map((id) => [id, pluginRuntime.getPluginManifest(id)?.networkAccess?.allowedDomains ?? []] as const),
      ),
      modelEndpointHosts: computeDynamicEndpointHosts(settingsService.getAll()),
    };
  };

  // Refresh worker domains after load and before workers start, then on endpoint changes; do nothing without an active runtime.
  const refreshSandboxNetworkConfig = (): Promise<void> =>
    (async () => {
      const [{ isAsrtSandboxActive }, { setWorkerEgressAllowlists }] = await Promise.all([
        import("../../permissions/asrt-sandbox.js"),
        import("../../permissions/egress-runtime.js"),
      ]);
      if (!isAsrtSandboxActive()) return;
      const allowlists = await buildWorkerEgressAllowlists();
      setWorkerEgressAllowlists(allowlists);
      log.info(
        "boot: worker egress allowlists refreshed (%d extensions, %d model endpoints)",
        allowlists.byExtension.size,
        allowlists.modelEndpointHosts.length,
      );
    })().catch((err) => {
      // On refresh failure, warn and retain prior lists; deny-by-default still blocks new destinations.
      log.warn(
        "boot: worker egress allowlist refresh failed: %s",
        errorMessage(err),
      );
    });

  ctx.pluginMarketplace = pluginMarketplace;
  ctx.refreshActiveLlmWildcard = refreshActiveLlmWildcard;
  ctx.disposeRefreshActiveLlmWildcard = disposeRefreshActiveLlmWildcard;
  ctx.buildWorkerEgressAllowlists = buildWorkerEgressAllowlists;
  ctx.refreshSandboxNetworkConfig = refreshSandboxNetworkConfig;
}

/**
 * Boot step — the plugin store and its live-refresh closures (extracted from
 * boot.ts C18).
 *
 * Constructs the PluginMarketplaceService — the plugin install/uninstall
 * transactions the git marketplace drives (design §16.2) — and wires the
 * live-refresh closures the settings IPC handlers invoke: the active-LLM
 * wildcard config push and the sandbox network-policy refresh.
 */
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

/**
 * What the retired server marketplace left on disk (design §16.2): the signed
 * admission, whitelist and revocation documents under `userData`, the catalog
 * cache, and the tarball cache and verified downloads of each package tree it
 * installed into. Nothing reads them any more.
 */
export function retiredMarketplaceCachePaths(input: {
  userDataPath: string;
  /** `~/.ave`. */
  home: string;
  /** `~/.ave/plugins/.cache`. */
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

/** Best effort: a path that cannot be removed now is tried again next boot. */
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

  // #893 — Push the active LLM vendor id into the plugin runtime's wildcard
  // configOverrides slot. Plugins read this via
  // `hostApi.config.get("hostApiVendor")` so a plugin that needs an LLM call
  // doesn't have to ship its own vendor-detection logic. Called once at
  // boot (after plugin runtime is available) and again after every
  // llm-settings IPC change.
  //
  // The wildcard slot deliberately carries no `hostApiKey`. The actual
  // secret must always flow through `hostApi.getSecret("llm.apiKey.<vendor>")`,
  // which routes through the three-tier allowlist gate (only plugins that
  // declare the matching `hostSecrets.read[]` entry receive the key).
  // Injecting the apiKey into a wildcard config slot would bypass that gate:
  // every plugin would receive the key via `config.get("hostApiKey")`
  // regardless of its manifest.
  //
  // The factory lives in `boot/steps/refresh-active-llm-wildcard.ts` so the
  // debounce + vendor-change-restart contract is independently unit-testable:
  // the first call seeds, and subsequent vendor changes trigger a debounced
  // restart sweep of every loaded plugin.
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

  // ── Worker egress allowlists + refresh ───────────────────────────────────
  // What each plugin worker may reach through the sandbox proxy: its own
  // extension's manifest `networkAccess.allowedDomains` plus the host-resolved
  // model endpoints (user-configured vendor baseUrls a worker actually reaches,
  // e.g. local-indexer's Azure OpenAI resource). The egress ask callback reads
  // this per connection, so one extension's domains never reach another
  // extension's worker or a shell (invariant I4); ASRT's own allowedDomains
  // stays empty.
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

  // Recomputes the worker allowlists: at boot, after plugins load (before any
  // worker starts), and from the settings / chat IPC handlers when a model
  // endpoint changes, so a reconfigured endpoint applies without a restart.
  // GATED: a no-op when ASRT is not active (gate off, deps missing, Windows not
  // ready), since no sandboxed process exists to reach anything.
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
      // Degrade loudly rather than throw: a failed refresh keeps the previous
      // allowlists (deny-by-default stands for anything new), and the
      // boot-path awaiter must not brick startup over it.
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

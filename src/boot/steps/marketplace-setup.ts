/**
 * Boot step — the plugin store and its live-refresh closures (extracted from
 * boot.ts C18).
 *
 * Constructs the PluginMarketplaceService over the disabled fetcher — packages
 * arrive through the git marketplace (design §16.2) — and wires the
 * live-refresh closures the settings IPC handlers invoke: the active-LLM
 * wildcard config push and the ASRT sandbox network allow-list rebuild.
 */
import { DisabledMarketplaceFetcher, PluginMarketplaceService } from "../../plugins/marketplace.js";
import type { MarketplaceFetcher } from "../../plugins/marketplace.js";
import { activeHostApiVendor, createRefreshActiveLlmWildcard } from "./refresh-active-llm-wildcard.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("ave");

export async function setupMarketplace(ctx: BootContext): Promise<void> {
  const {
    settingsService,
    pluginPaths,
    deploymentGuard,
    bootAuditLogger,
    pluginRuntime,
  } = ctx;

  // The server catalog is gone; nothing installs through this fetcher (design §16.2).
  const marketplaceFetcher: MarketplaceFetcher = new DisabledMarketplaceFetcher();
  const pluginMarketplace = new PluginMarketplaceService(
    pluginPaths,
    marketplaceFetcher,
    deploymentGuard,
    bootAuditLogger,
    // No server catalog or tarball to cache: `offlineCacheEnabled` now keeps
    // git marketplace artifacts (marketplace/resolve/artifact-cache.ts).
    () => false,
  );

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

  // ── ASRT shared network-config union builder + live refresh ──────────────
  // The shared strict-union allow-list ASRT enforces = the UNION of every
  // loaded plugin's manifest `networkAccess.allowedDomains` PLUS the host-
  // resolved DYNAMIC endpoint hostnames (user-configured vendor baseUrls a
  // sandboxed worker actually reaches — e.g. local-indexer's Azure OpenAI
  // resource). Both the boot init block (below) and the live-refresh closure
  // (here) build the union the SAME way so they never drift.
  const buildSandboxUnionDomains = async (): Promise<string[]> => {
    const { computeUnionAllowedDomains, normalizeUnionForAsrt, computeDynamicEndpointHosts } =
      await import("../../permissions/asrt-sandbox.js");
    const manifestAllowLists = pluginRuntime
      .listPluginIds()
      .map((id) => pluginRuntime.getPluginManifest(id)?.networkAccess?.allowedDomains ?? []);
    const dynamicEndpointHosts = computeDynamicEndpointHosts(settingsService.getAll());
    return normalizeUnionForAsrt(
      computeUnionAllowedDomains([...manifestAllowLists, dynamicEndpointHosts], []),
    );
  };

  // Closure invoked by the settings IPC handler when a vendor/embedding
  // endpoint changes. Recomputes the dynamic-endpoint union and LIVE-SWAPS the
  // shared ASRT network config so a reconfigured endpoint is enforced/allowed
  // without an app restart. The network config is a SAFE, GLOBAL live swap
  // (filterNetworkRequest reads the shared config; updateConfig replaces it).
  // GATED: no-op when ASRT is not active (gate OFF, or deps-missing/Windows-
  // not-ready paths where the sandbox was never initialized) — there is no live
  // config to update, and we must not initialize one outside the boot gate.
  const refreshSandboxNetworkConfig = (): Promise<void> =>
    (async () => {
      const {
        isAsrtSandboxActive,
        updateAsrtSandboxConfig,
      } = await import(
        "../../permissions/asrt-sandbox.js"
      );
      if (!isAsrtSandboxActive()) return;
      const allowedDomains = await buildSandboxUnionDomains();
      // Same trusted shape boot init uses: enforced allow-list + strict, no
      // weakening flags. Plugin-worker filesystem grants are not kept in the
      // shared config; Windows worker spawn remains fail-closed until ASRT can
      // scope allow grants per worker/plugin.
      await updateAsrtSandboxConfig({
        allowedDomains,
        strictAllowlist: true,
        userDataDir: ctx.host.userDataPath,
      });
      log.info(
        "boot: ASRT network config live-refreshed (%d union domains)",
        allowedDomains.length,
      );
    })().catch((err) => {
      // Degrade loudly rather than throw: a failed refresh only keeps the
      // enforced allow-list NARROWER than declared (deny-by-default stands),
      // and the boot-path awaiter must not brick startup over it.
      log.warn(
        "boot: ASRT network config live-refresh failed: %s",
        errorMessage(err),
      );
    });

  ctx.marketplaceFetcher = marketplaceFetcher;
  ctx.pluginMarketplace = pluginMarketplace;
  ctx.refreshActiveLlmWildcard = refreshActiveLlmWildcard;
  ctx.disposeRefreshActiveLlmWildcard = disposeRefreshActiveLlmWildcard;
  ctx.buildSandboxUnionDomains = buildSandboxUnionDomains;
  ctx.refreshSandboxNetworkConfig = refreshSandboxNetworkConfig;
}

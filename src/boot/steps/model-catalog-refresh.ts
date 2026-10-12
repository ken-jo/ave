/**
 * Boot step — the model catalog refresh (design `model-capability-catalog.md` §7).
 *
 * Runs once after boot and then re-checks every hour; each check sends a
 * request only when the cached copy is older than a day
 * (`MODEL_CATALOG_REFRESH_INTERVAL_MS`), so a launch inside that day sends
 * nothing. Whether it may run is decided at each check — the
 * `AVE_MODEL_CATALOG` pin, the managed policy file, then the user's switch —
 * so turning the switch off stops the next check without a restart.
 *
 * What it fetches only replaces the cache; the catalog in force changes at the
 * next launch (`installBootModelCatalog`). Interactive launches only: a
 * headless one-shot run makes no discretionary connection, and resolves
 * against whatever the cache or the pin already holds.
 */
import type { SettingsService } from "../../data/settings-store.js";
import { createLogger } from "../../lib/logger.js";
import { registerShutdownHook } from "../../main/app-shutdown.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { activeModelCatalog } from "../../shared/model-catalog/active.js";
import { modelCatalogCacheDir } from "../../core/model-catalog/cache.js";
import { decideModelCatalogRefresh, readModelCatalogRefreshPolicy } from "../../core/model-catalog/refresh-policy.js";
import { refreshModelCatalogCache } from "../../core/model-catalog/refresh.js";

const log = createLogger("model-catalog");

/** How often a running app looks at the cache's age; the request itself is daily at most. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

export function wireModelCatalogRefresh(input: {
  settingsService: Pick<SettingsService, "get">;
  /** The host's single-hop transport, which `fetchPublicHttpResponse` checks hop by hop. */
  fetchImpl: typeof fetch;
  /** The managed policy file; the platform's path unless a test supplies one. */
  policyPath?: string;
}): Promise<void> {
  const policyPath = input.policyPath ?? getAdminPolicyPath();
  const controller = new AbortController();
  let running = false;
  const check = async (): Promise<void> => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      const decision = decideModelCatalogRefresh({
        setting: input.settingsService.get("llm").modelCatalogRefresh,
        policy: await readModelCatalogRefreshPolicy(policyPath),
      });
      if (!decision.enabled) {
        log.debug({ decidedBy: decision.decidedBy }, "model catalog refresh off");
        return;
      }
      const result = await refreshModelCatalogCache({
        fetchImpl: input.fetchImpl,
        dir: modelCatalogCacheDir(),
        reference: activeModelCatalog(),
        signal: controller.signal,
      });
      if (result.status === "failed") {
        log.warn({ reason: result.reason }, "model catalog refresh failed; keeping the catalog in force");
      } else if (result.status === "updated") {
        log.info({ sha256: result.sha256, dropped: result.diagnostics.length }, "model catalog refreshed; takes effect at the next launch");
      } else {
        log.debug({ status: result.status, sha256: "sha256" in result ? result.sha256 : undefined }, "model catalog check complete");
      }
    } catch (error) {
      log.warn({ err: error }, "model catalog refresh check failed");
    } finally {
      running = false;
    }
  };
  const first = check();
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  timer.unref?.();
  registerShutdownHook("model-catalog-refresh", () => {
    clearInterval(timer);
    controller.abort();
  });
  // The first check, for a caller that wants to know when it settled; boot does not wait.
  return first;
}

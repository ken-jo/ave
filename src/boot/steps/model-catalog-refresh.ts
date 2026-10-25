/** Interactive refresh updates only the next-launch cache; check consent and pins on every pass. */
import type { SettingsService } from "../../data/settings-store.js";
import { createLogger } from "../../lib/logger.js";
import { registerShutdownHook } from "../../main/app-shutdown.js";
import { getAdminPolicyPath } from "../../permissions/policy-store.js";
import { activeModelCatalog } from "../../shared/model-catalog/active.js";
import { modelCatalogCacheDir } from "../../core/model-catalog/cache.js";
import { decideModelCatalogRefresh, readModelCatalogRefreshPolicy } from "../../core/model-catalog/refresh-policy.js";
import { refreshModelCatalogCache } from "../../core/model-catalog/refresh.js";

const log = createLogger("model-catalog");

/** Check hourly; fetch at most daily. */
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
  // Expose the first check for callers that need to await it; boot does not block.
  return first;
}

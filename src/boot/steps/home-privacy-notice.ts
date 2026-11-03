import { t } from "../../i18n/index.js";
import { basename } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { acknowledgeHomeBoundaryRepair, AVE_HOME_RUNTIME_DIRECTORY, type AveHomePrivacy } from "../../shared/ave-home.js";
import type { AveHomeTrustVerdict } from "../../shared/ave-home-trust.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

export function notifyHomeConfigurationPreserved(
  diagnostics: readonly string[],
  ctx: Pick<BootContext, "host" | "notificationService">,
): void {
  if (!ctx.host.desktop) return;
  for (const diagnostic of diagnostics) {
    const prefix = "Legacy configuration preserved at ";
    if (!diagnostic.startsWith(prefix)) continue;
    const path = diagnostic.slice(prefix.length);
    ctx.notificationService.deliver({
      kind: "system",
      title: t("homePrivacy.configurationPreservedTitle"),
      body: t("homePrivacy.configurationPreserved", { file: basename(path), path }),
      bypassFocusGate: true,
    });
  }
}

export function notifyHomeBoundaryRepairs(
  privacy: AveHomePrivacy,
  ctx: Pick<BootContext, "host" | "notificationService">,
): void {
  if (privacy.enforcement === "posix-mode") return;
  for (const path of privacy.repairs ?? []) {
    // The home root itself: a one-time repair of the inherited DACL. Its path names the user's profile, so the log names the role
    // instead, and nothing is acknowledged — a repaired root passes RootSafe on the next boot and is not reported again.
    if (path === privacy.home) {
      const body = t("homePrivacy.rootRepaired");
      log.warn("boot: AVE_HOME root repaired: %s", body);
      if (ctx.host.desktop) {
        ctx.notificationService.deliver({ kind: "system", title: t("homePrivacy.boundaryRepairedTitle"), body, bypassFocusGate: true });
      }
      continue;
    }
    // The runtime boundary is recreated empty rather than copied, so its notice says it will be rebuilt; it holds no credentials.
    const body = basename(path) === AVE_HOME_RUNTIME_DIRECTORY ? t("homePrivacy.runtimeReset") : t("homePrivacy.boundaryRepaired");
    log.warn("boot: %s: %s", path, body);
    if (ctx.host.desktop) {
      const delivery = ctx.notificationService.deliver({
        kind: "system",
        title: t("homePrivacy.boundaryRepairedTitle"),
        body,
        // Boot can precede the renderer's toast subscription.
        bypassFocusGate: true,
      });
      if (delivery?.accepted) {
        try { acknowledgeHomeBoundaryRepair(privacy.home, path); }
        catch (error) { log.warn("boot: repair notice remains pending: %s", String(error)); }
      }
    }
  }
}

/** One notice when the boot found Ave folder content it cannot vouch for: nothing pending loads until the user reviews it. */
export function notifyHomeTrustPending(
  verdict: AveHomeTrustVerdict,
  ctx: Pick<BootContext, "host" | "notificationService">,
): void {
  if (!verdict.pending) return;
  const body = verdict.unavailable === "recovery" ? t("homePrivacy.configurationRecovery")
    : verdict.unavailable === "permissions" ? t("homePrivacy.contentRefused")
      : t("homePrivacy.contentPending");
  log.warn("boot: Ave folder content is not trusted until it is reviewed: %s", body);
  if (!ctx.host.desktop) return;
  ctx.notificationService.deliver({ kind: "system", title: t("homePrivacy.contentPendingTitle"), body, bypassFocusGate: true });
}

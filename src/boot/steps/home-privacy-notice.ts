import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { acknowledgeHomeBoundaryRepair, type AveHomePrivacy } from "../../shared/ave-home.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

export function notifyHomeBoundaryRepairs(
  privacy: AveHomePrivacy,
  ctx: Pick<BootContext, "host" | "notificationService">,
): void {
  if (privacy.enforcement === "posix-mode") return;
  for (const path of privacy.repairs ?? []) {
    const body = t("homePrivacy.boundaryRepaired");
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

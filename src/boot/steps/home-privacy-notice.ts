import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import type { AveHomePrivacy } from "../../shared/ave-home.js";
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
      ctx.notificationService.fire({
        kind: "system",
        title: t("homePrivacy.boundaryRepairedTitle"),
        body,
        // Boot can precede the renderer's toast subscription.
        bypassFocusGate: true,
      });
    }
  }
}

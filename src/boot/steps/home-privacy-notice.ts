import { t } from "../../i18n/index.js";
import { basename } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { acknowledgeHomeBoundaryRepair, type AveHomePrivacy } from "../../shared/ave-home.js";
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

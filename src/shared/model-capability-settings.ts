import type { TranslateFn } from "../i18n/translate.js";

/** The same recovery destination on the composer and retained-image error. */
export function imageInputRecoveryMessage(translate: TranslateFn): string {
  const settingsPath = [
    translate("settingsContent.sidebarHeading"),
    translate("llmTab.pageTitle"),
    translate("llmTab.imageInput"),
  ].join(" → ");
  return translate("llmTab.imageInputRecovery", { settingsPath });
}

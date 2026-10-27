import { dialog } from "electron";
import { t } from "../i18n/index.js";
import { AveHomeConfigurationUntrustedError } from "../shared/ave-home.js";

export function showConfigurationBootError(error: unknown): void {
  if (!(error instanceof AveHomeConfigurationUntrustedError)) return;
  dialog.showErrorBox(t("homePrivacy.configurationUntrustedTitle"), t("homePrivacy.configurationUntrusted", {
    path: error.path,
    reason: error.reason,
  }));
}

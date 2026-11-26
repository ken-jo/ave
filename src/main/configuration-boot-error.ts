import { showNativeError } from "../permissions/approval-presentation.js";
import { t } from "../i18n/index.js";
import { AveHomeConfigurationUntrustedError } from "../shared/ave-home.js";

export async function showConfigurationBootError(error: unknown): Promise<void> {
  if (!(error instanceof AveHomeConfigurationUntrustedError)) return;
  await showNativeError(t("homePrivacy.configurationUntrustedTitle"), t("homePrivacy.configurationUntrusted", {
    path: error.path,
    reason: error.reason,
  }));
}

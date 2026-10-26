import { dialog } from "electron";
import { settingsFilePath } from "../data/settings-store.js";
import { normalizeLocale, tryLoadLocaleMessages } from "../i18n/index.js";
import { translate } from "../i18n/translate.js";
import { LlmProviderSettingsError } from "../shared/custom-provider.js";

export async function showProviderSettingsStartupError(
  error: unknown,
  userDataPath: string,
  systemLocale: string,
): Promise<boolean> {
  if (!(error instanceof LlmProviderSettingsError)) return false;
  const locale = normalizeLocale(systemLocale);
  await tryLoadLocaleMessages(locale);
  dialog.showErrorBox(
    translate(locale, "providerSettingsError.title"),
    translate(locale, "providerSettingsError.detail", { path: settingsFilePath(userDataPath), field: error.field }),
  );
  return true;
}

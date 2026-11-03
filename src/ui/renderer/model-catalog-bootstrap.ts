/** Install main's model catalog before mount so the first settings snapshot resolves against the engine's catalog; when a
 * pre-mount step fails, say so in the window instead of leaving it blank. */
import { installModelCatalog } from "../../shared/model-catalog/active.js";
import { DEFAULT_LOCALE, normalizeLocale, tryLoadLocaleMessages } from "../../i18n/index.js";
import { setLocale, t } from "../../i18n/runtime.js";
import { errorMessage } from "../../shared/error-message.js";
import { resolveIpcErrorKey } from "./format-ipc-error.js";
import type { AveApi } from "./types.js";

export async function installRendererModelCatalog(api: Pick<AveApi, "getModelCatalog">): Promise<void> {
  const result = await api.getModelCatalog();
  if (!result.ok) throw new Error(result.error);
  installModelCatalog(result.catalog);
}

/** The settings snapshot the first render takes its language from could not be read before mount. */
export class BootSettingsUnavailableError extends Error {
  constructor(cause: unknown) {
    super("settings unavailable before mount", { cause });
    this.name = "BootSettingsUnavailableError";
  }
}

/**
 * What the window shows when a pre-mount step failed — the model catalog (the
 * app would resolve models against nothing) or the settings snapshot the first
 * render's language comes from: the app is not mounted, so the root says why
 * and offers a reload instead of staying blank. Plain DOM — React has not
 * mounted, and this must not depend on anything that failed to.
 */
export async function renderBootFailure(
  root: HTMLElement,
  error: unknown,
  api?: Pick<AveApi, "getSettings">,
): Promise<void> {
  const settingsStep = error instanceof BootSettingsUnavailableError;
  const messageKey = settingsStep ? "app.bootSettingsUnavailable" : "app.modelCatalogUnavailable";
  console.error(settingsStep
    ? "[renderer] settings unavailable before mount; the app cannot start"
    : "[renderer] model catalog unavailable; the app cannot resolve models", error);
  let errorKey: string | undefined = settingsStep ? undefined : "formatIpcError.catalogUnavailable";
  try {
    errorKey = resolveIpcErrorKey(errorMessage(settingsStep ? error.cause : error)) ?? errorKey;
  } catch {
    // An unreadable diagnostic leaves the generic localized explanation.
  }
  document.documentElement.lang = setLocale(DEFAULT_LOCALE);
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.dataset.testid = settingsStep ? "boot-settings-unavailable" : "model-catalog-unavailable";
  panel.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100vh;padding:32px;text-align:center;font:14px system-ui,sans-serif";
  const message = document.createElement("p");
  // A diagnostic line only when one resolved: a settings failure without a known code shows the message and the reload alone.
  const detail = errorKey === undefined ? null : document.createElement("p");
  if (detail) detail.style.cssText = "opacity:0.7;font-size:12px";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.addEventListener("click", () => window.location.reload());
  const paint = () => {
    message.textContent = t(messageKey);
    if (detail && errorKey !== undefined) detail.textContent = t(errorKey);
    reload.textContent = t("errorBoundary.reloadButton");
  };
  paint();
  panel.append(...(detail ? [message, detail, reload] : [message, reload]));
  root.replaceChildren(panel);

  // The settings-backed locale provider has not mounted on this failure path. Show the fallback immediately, then apply the
  // saved language when readable.
  if (api === undefined) return;
  try {
    const settings = await api.getSettings();
    const locale = normalizeLocale(settings.appearance?.language);
    if (await tryLoadLocaleMessages(locale)) {
      document.documentElement.lang = setLocale(locale);
      paint();
    }
  } catch {
    // An unavailable settings channel must leave the reload control usable.
    document.documentElement.lang = setLocale(DEFAULT_LOCALE);
    paint();
  }
}

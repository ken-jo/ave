/** Install main's model catalog before mount so the first settings snapshot resolves against the engine's catalog. */
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

/**
 * What the window shows when the catalog could not be installed: the app is
 * not mounted (it would resolve models against nothing), so the root says why
 * and offers a reload instead of staying blank. Plain DOM — React has not
 * mounted, and this must not depend on anything that failed to.
 */
export async function renderModelCatalogUnavailable(
  root: HTMLElement,
  error: unknown,
  api?: Pick<AveApi, "getSettings">,
): Promise<void> {
  console.error("[renderer] model catalog unavailable; the app cannot resolve models", error);
  let errorKey = "formatIpcError.catalogUnavailable";
  try {
    errorKey = resolveIpcErrorKey(errorMessage(error)) ?? errorKey;
  } catch {
    // An unreadable diagnostic leaves the generic localized explanation.
  }
  document.documentElement.lang = setLocale(DEFAULT_LOCALE);
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.dataset.testid = "model-catalog-unavailable";
  panel.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100vh;padding:32px;text-align:center;font:14px system-ui,sans-serif";
  const message = document.createElement("p");
  message.textContent = t("app.modelCatalogUnavailable");
  const detail = document.createElement("p");
  detail.style.cssText = "opacity:0.7;font-size:12px";
  detail.textContent = t(errorKey);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = t("errorBoundary.reloadButton");
  reload.addEventListener("click", () => window.location.reload());
  panel.append(message, detail, reload);
  root.replaceChildren(panel);

  // The settings-backed locale provider has not mounted on this failure path. Show the fallback immediately, then apply the
  // saved language when readable.
  if (api === undefined) return;
  try {
    const settings = await api.getSettings();
    const locale = normalizeLocale(settings.appearance?.language);
    if (await tryLoadLocaleMessages(locale)) {
      document.documentElement.lang = setLocale(locale);
      message.textContent = t("app.modelCatalogUnavailable");
      detail.textContent = t(errorKey);
      reload.textContent = t("errorBoundary.reloadButton");
    }
  } catch {
    // An unavailable settings channel must leave the reload control usable.
    document.documentElement.lang = setLocale(DEFAULT_LOCALE);
    message.textContent = t("app.modelCatalogUnavailable");
    detail.textContent = t(errorKey);
    reload.textContent = t("errorBoundary.reloadButton");
  }
}

/**
 * Install the model catalog in the renderer before anything resolves a model.
 *
 * The renderer resolves context windows synchronously from each settings
 * snapshot (`use-settings.ts`), against the catalog `src/shared/model-catalog/active.ts`
 * holds. Main resolves against the copy it installed at boot; asking main for
 * that copy and installing it before the app mounts means the first snapshot
 * the renderer applies is already resolved against the same catalog as the
 * engine — never against a missing one, and never against a different one.
 */
import { installModelCatalog } from "../../shared/model-catalog/active.js";
import { t } from "../../i18n/runtime.js";
import { errorMessage } from "../../shared/error-message.js";
import type { AveApi } from "./types.js";

export async function installRendererModelCatalog(api: Pick<AveApi, "getModelCatalog">): Promise<void> {
  const result = await api.getModelCatalog();
  if (!result.ok) throw new Error(`the host refused the model catalog: ${result.error}`);
  installModelCatalog(result.catalog);
}

/**
 * What the window shows when the catalog could not be installed: the app is
 * not mounted (it would resolve models against nothing), so the root says why
 * and offers a reload instead of staying blank. Plain DOM — React has not
 * mounted, and this must not depend on anything that failed to.
 */
export function renderModelCatalogUnavailable(root: HTMLElement, error: unknown): void {
  console.error("[renderer] model catalog unavailable; the app cannot resolve models", error);
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.dataset.testid = "model-catalog-unavailable";
  panel.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100vh;padding:32px;text-align:center;font:14px system-ui,sans-serif";
  const message = document.createElement("p");
  message.textContent = t("app.modelCatalogUnavailable");
  const detail = document.createElement("p");
  detail.style.cssText = "opacity:0.7;font-size:12px";
  detail.textContent = errorMessage(error);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = t("errorBoundary.reloadButton");
  reload.addEventListener("click", () => window.location.reload());
  panel.append(message, detail, reload);
  root.replaceChildren(panel);
}

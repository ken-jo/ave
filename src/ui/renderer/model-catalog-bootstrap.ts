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
import type { AveApi } from "./types.js";

export async function installRendererModelCatalog(api: Pick<AveApi, "getModelCatalog">): Promise<void> {
  const result = await api.getModelCatalog();
  if (!result.ok) throw new Error(`the host refused the model catalog: ${result.error}`);
  installModelCatalog(result.catalog);
}

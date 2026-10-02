/**
 * A window's preload and the sandbox it runs in, from the one table
 * (`src/shared/preload-bundles.ts`). Every `new BrowserWindow` with a preload
 * spreads `preloadPreferences(id)` instead of naming either value, so the
 * build gate that checks a sandboxed preload's requires checks the windows
 * that actually run it (`test/scripts/preload-sites.test.ts` holds the sites
 * to this).
 */
import { PRELOAD_BUNDLES, type PreloadBundleId } from "../shared/preload-bundles.js";
import { runtimeAssetPath } from "./main-paths.js";

/** The built preload's absolute path in `dist/src`. */
export function preloadBundlePath(id: PreloadBundleId): string {
  return runtimeAssetPath(PRELOAD_BUNDLES[id].file);
}

/** `webPreferences.preload` and `.sandbox` for a window running preload `id`. */
export function preloadPreferences(id: PreloadBundleId): { preload: string; sandbox: boolean } {
  return { preload: preloadBundlePath(id), sandbox: PRELOAD_BUNDLES[id].sandbox };
}

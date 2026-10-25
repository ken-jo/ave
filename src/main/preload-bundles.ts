// Every preload window uses the shared preload/sandbox table so build checks cover its actual runtime preferences.
import { PRELOAD_BUNDLES, type PreloadBundleId } from "../shared/preload-bundles.js";
import { runtimeAssetPath } from "./main-paths.js";

export function preloadBundlePath(id: PreloadBundleId): string {
  return runtimeAssetPath(PRELOAD_BUNDLES[id].file);
}

export function preloadPreferences(id: PreloadBundleId): { preload: string; sandbox: boolean } {
  return { preload: preloadBundlePath(id), sandbox: PRELOAD_BUNDLES[id].sandbox };
}

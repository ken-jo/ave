/** Window creation, build configuration, and preload checks share this manifest so sandbox mode and preload restrictions cannot drift. Sandboxed preloads may require only the runtime bridge, not files, and cannot assume Buffer or immediate timers. */
import bundles from "./preload-bundles.json" with { type: "json" };

export type PreloadBundleId = keyof typeof bundles;

export interface PreloadBundle {
  entry: string;
  file: string;
  build: "webpack" | "copy";
  sandbox: boolean;
  runsIn: string;
}

export const PRELOAD_BUNDLES: Readonly<Record<PreloadBundleId, PreloadBundle>> = bundles as Record<PreloadBundleId, PreloadBundle>;

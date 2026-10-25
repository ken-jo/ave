/**
 * Every preload the app ships and the sandbox mode of the frames that run it:
 * the one source the window code, the webpack config and the build gate
 * (`scripts/check-sandboxed-preloads.mjs`) all read, so a window's `sandbox`
 * cannot change without the gate holding its preload to the matching rules.
 *
 * Kept as JSON beside this module because the webpack config and the gate
 * are plain Node scripts. A sandboxed frame's preload can require only
 * `electron` (and its `electron/renderer` / `electron/common` subpaths), no
 * files, and since Electron 45 runs without `Buffer`, `setImmediate` and
 * `clearImmediate` (https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts).
 *
 * `build`: `webpack` bundles `entry` to `dist/src/<file>` (one config per id,
 * named by the id); `copy` ships `entry` as it is (`scripts/lib/build-assets.mjs`).
 */
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

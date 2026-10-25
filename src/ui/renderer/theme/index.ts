/**
 * Theme system v2 barrel.
 *
 * Components import from here to avoid deep paths:
 *   `import { useTheme } from "../theme/index.js"`
 */
export { ThemeProvider, useTheme, useOptionalTheme } from "./ThemeProvider.js";
export { bundleToPluginTokens } from "./plugin-token-map.js";
export {
  BUNDLES,
  DEFAULT_BUNDLE_ID,
  findBundle,
  visibleBundles,
} from "./bundles/index.js";
export type { ThemeBundle } from "./bundles/index.js";

/**
 * Inputs every test or the build depends on without importing them. A change
 * here can move any result, so it keeps the full checks.
 *
 * - dependency and compiler inputs: package.json, bun.lock, bunfig.toml,
 *   tsconfig*.json
 * - test runner inputs: vitest.config.ts, everything under config/ (the
 *   Vitest config and global setup, the Playwright config, and the gate
 *   baselines), and the per-project setup files the Vitest config names
 * - the test-only module the Vitest config injects by file identity
 * - build inputs: webpack, PostCSS and shadcn configs, and scripts/ (the
 *   build script chain, the Vitest runner, and this hook)
 * - .github/: CI workflows and their scripts
 */
export const FULL_CHECK_GLOBAL_INPUT_FILES = Object.freeze([
  "bun.lock",
  "bunfig.toml",
  "components.json",
  "package.json",
  "postcss.config.cjs",
  "src/__tests__/support/ave-home-isolation-guard.ts",
  "src/__tests__/vitest-ave-home.ts",
  "src/__tests__/vitest-model-catalog.ts",
  "src/__tests__/vitest-renderer-web-streams.ts",
  "src/__tests__/vitest-vm-exit-hooks.ts",
  "src/i18n/testing/vitest-ambient-intl.ts",
  "src/shared/ave-home-test-guard.ts",
  "tsconfig.json",
  "tsconfig.tests.json",
  "vitest.config.ts",
  "webpack.config.cjs",
]);

const FULL_CHECK_GLOBAL_INPUT_PREFIXES = Object.freeze([
  ".github/",
  "config/",
  "scripts/",
]);

/**
 * Locale catalogs contain static message data; select tests by changed key
 * namespace instead of the shared translation import graph. The registry and
 * unknown files stay global inputs. Structural edits require full checks.
 */
export const MESSAGE_CATALOG_DIRECTORY = "src/i18n/messages/";
const messageCatalogPath = /^src\/i18n\/messages\/[a-z]{2}(?:-[A-Z]{2})?\.ts$/;

export function isMessageCatalogPath(relativePath) {
  return messageCatalogPath.test(relativePath);
}

export function isFullCheckGlobalInput(relativePath) {
  return (
    FULL_CHECK_GLOBAL_INPUT_FILES.includes(relativePath) ||
    /(?:^|\/)tsconfig[^/]*\.json$/.test(relativePath) ||
    /\.d\.(?:ts|mts|cts)$/.test(relativePath) ||
    /(?:^|\/)[^/]*(?:preload|worker-entry|worker-main|child-main)\.(?:ts|tsx|js|mjs|cjs)$/.test(relativePath) ||
    FULL_CHECK_GLOBAL_INPUT_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
    (relativePath.startsWith(MESSAGE_CATALOG_DIRECTORY) && !isMessageCatalogPath(relativePath))
  );
}

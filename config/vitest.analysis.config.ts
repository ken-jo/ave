import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "vite";
import { defineConfig } from "vitest/config";
import { electronNodeNormalizerArgument } from "../scripts/run-vitest-under-electron.mjs";
import { documentGuardImportArgument } from "../scripts/lib/document-consumer-node-options.mjs";
import { assertAllowedDocumentRead } from "../scripts/lib/document-consumer-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPath = (p: string) => path.resolve(ROOT, p);

const testFileGlob = "**/*.{test,spec}.{ts,tsx}";
const baseExclude = [
  "node_modules/**",
  "dist/**",
  "plugins/**",
  ".claude/**",
  // UI specs require their own runner; collecting them here causes import errors.
  "test/e2e/**",
  // The screenshot harness has its own runner configuration.
  "test/screenshots/**",
];
const rendererTestGlobs = [
  `test/renderer/${testFileGlob}`,
  `src/ui/__tests__/${testFileGlob}`,
  `src/ui/renderer/__tests__/${testFileGlob}`,
  `src/ui/renderer/**/__tests__/${testFileGlob}`,
];
const permissionTimingTests = [
  "src/permissions/__tests__/permission-decision-cost.test.ts",
  "src/permissions/__tests__/permission-adversarial-performance.test.ts",
];

// Match the isolation seam by file identity so aliases and links also load the test guard.
// This configuration never runs in production builds.
const AVE_HOME_GUARD_SEAM_PATH = rootPath("src/shared/ave-home-test-guard.ts");
const AVE_HOME_GUARD_SEAM = statSync(AVE_HOME_GUARD_SEAM_PATH, { bigint: true });
const AVE_HOME_GUARD_SEAM_REAL = realpathSync.native(AVE_HOME_GUARD_SEAM_PATH);
const AVE_HOME_GUARD = normalizePath(rootPath("src/__tests__/support/ave-home-isolation-guard.ts"));

function isAveHomeGuardSeam(id: string): boolean {
  const file = id.split("?")[0];
  if (!path.isAbsolute(file)) return false;
  try {
    // Filesystems without inode numbers use the real path as identity.
    if (AVE_HOME_GUARD_SEAM.ino === 0n) return realpathSync.native(file) === AVE_HOME_GUARD_SEAM_REAL;
    const stat = statSync(file, { bigint: true });
    return stat.ino === AVE_HOME_GUARD_SEAM.ino && stat.dev === AVE_HOME_GUARD_SEAM.dev;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

const DEFAULT_MAX_WORKERS = 4;

function vitestMaxWorkers(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_WORKERS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`AVE_VITEST_MAX_WORKERS must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

export default defineConfig({
  root: ROOT,
  plugins: [{
    name: "document-input-guard",
    enforce: "pre",
    load(id) {
      assertAllowedDocumentRead(id.split("?")[0]);
    },
  }, {
    name: "ave-home-isolation-guard",
    enforce: "pre",
    load(id) {
      // Preserve the guard module identity and resolve its imports from its own directory.
      if (isAveHomeGuardSeam(id)) return `export * from ${JSON.stringify(AVE_HOME_GUARD)};\n`;
      return null;
    },
  }],
  test: {
    // Dependency directories can be shared by worktrees with different lockfiles.
    // Keep cache invalidation local so one checkout cannot remove another's modules.
    fsModuleCachePath: rootPath(".cache/vitest/modules"),
    globalSetup: [rootPath("config/vitest.globalSetup.ts")],
    // Boot fixtures retain calls from beforeAll; each suite owns mock cleanup.
    clearMocks: false,
    testTimeout: 45000,
    hookTimeout: 45000,
    // Limit workers to leave CPU headroom for subprocess-heavy tests.
    // AVE_VITEST_MAX_WORKERS must be a positive integer and can reflect a host CPU quota.
    maxWorkers: vitestMaxWorkers(process.env.AVE_VITEST_MAX_WORKERS),
    // VM pools retain contexts until recycling; only this root setting limits their heap.
    // Leave memory headroom for native allocations outside the heap.
    vmMemoryLimit: "2048MB",
    // Disable native WebStorage so the DOM test environment owns localStorage.
    // Gate the flag on the active runtime: older versions reject it before test collection.
    execArgv: (() => {
      const major = parseInt(process.versions.node.split(".")[0], 10);
      return [
        electronNodeNormalizerArgument(),
        documentGuardImportArgument(),
        ...(major >= 25 ? ["--no-experimental-webstorage"] : []),
      ];
    })(),
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/vitest",
      reporter: ["text-summary", "json-summary", "html"],
      reportOnFailure: true,
      skipFull: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "**/__tests__/**",
        "**/__probes__/**",
        "**/*.{test,spec}.{ts,tsx}",
        "**/*.d.ts",
      ],
      excludeAfterRemap: true,
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // Pin the locale for tests asserting Korean strings; default-locale tests set their own.
          setupFiles: [rootPath("src/i18n/testing/vitest-ambient-intl.ts"), rootPath("src/__tests__/vitest-ave-home.ts"), rootPath("src/__tests__/vitest-model-catalog.ts")],
          include: [
            `src/**/__tests__/${testFileGlob}`,
            `test/${testFileGlob}`,
          ],
          exclude: [
            ...baseExclude,
            ...rendererTestGlobs,
            ...permissionTimingTests,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          // Reuse workers while giving each renderer file fresh globals and a module graph.
          // Backend tests require forks for native modules, confinement and mock identity.
          pool: "vmForks",
          // Pin Korean to preserve renderer string assertions and exercise the catalog.
          setupFiles: [rootPath("src/i18n/testing/vitest-ambient-intl.ts"), rootPath("src/__tests__/vitest-ave-home.ts"), rootPath("src/__tests__/vitest-model-catalog.ts"), rootPath("src/__tests__/vitest-vm-exit-hooks.ts"), rootPath("src/__tests__/vitest-renderer-web-streams.ts")],
          include: rendererTestGlobs,
          exclude: baseExclude,
        },
      },
      {
        extends: true,
        test: {
          name: "permission-timing",
          environment: "node",
          setupFiles: [rootPath("src/i18n/testing/vitest-ambient-intl.ts"), rootPath("src/__tests__/vitest-ave-home.ts"), rootPath("src/__tests__/vitest-model-catalog.ts")],
          include: permissionTimingTests,
          exclude: baseExclude,
          // Complete other projects before measuring a single file at a time.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
    // Resolve concrete entries to keep one module instance across import spellings.
    alias: {
      "react/jsx-dev-runtime": rootPath("node_modules/react/jsx-dev-runtime.js"),
      "react/jsx-runtime": rootPath("node_modules/react/jsx-runtime.js"),
      "react-dom/client": rootPath("node_modules/react-dom/client.js"),
      "react-dom": rootPath("node_modules/react-dom/index.js"),
      react: rootPath("node_modules/react/index.js"),
      "ajv-formats": rootPath("node_modules/ajv-formats/dist/index.js"),
      // Before `ajv`, which would otherwise match this as its prefix.
      "ajv/dist/2020.js": rootPath("node_modules/ajv/dist/2020.js"),
      ajv: rootPath("node_modules/ajv/dist/ajv.js"),
      pino: rootPath("node_modules/pino/pino.js"),
    },
  },
});

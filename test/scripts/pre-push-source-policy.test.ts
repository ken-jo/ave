// Scoped source checks follow import coverage; inputs the graph cannot resolve require full checks.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  AVE_APP_LOCK_SUITE_TRIGGERS,
  boundRelatedTests,
  FULL_CHECK_GLOBAL_INPUT_FILES,
  isFullCheckGlobalInput,
  isMessageCatalogPath,
  isTestHelperModule,
  isTestOnlyDiff,
  isTestSupportFile,
  AVE_APP_LOCK_SUITES,
  readMessageCatalogEntries,
  readMessageCatalogEntriesByPath,
  RELATED_TEST_BOUND,
  selectFastSourceChecks,
  selectMessageCatalogChecks,
  selectTriggeredLockSuites,
} from "../../scripts/hooks/pre-push-source-policy.mjs";
import { messages } from "../../src/i18n/messages/index.js";
import { parseSourceTexts } from "../../scripts/lib/ts7-ast.mjs";
import { modifiedEntry as modified } from "../../src/__tests__/support/git-diff-entry.js";

const root = resolve(import.meta.dirname, "../..");

function added(path: string) {
  return { status: "A", oldMode: "000000", newMode: "100644", path };
}
function deleted(path: string) {
  return { status: "D", oldMode: "100644", newMode: "000000", path };
}

describe("pre-push source parsing", () => {
  it("preserves mixed-case input names when reading virtual source bytes", () => {
    const path = "src/MixedCase/Panel.ts";
    const text = 'export const title = "panel.title";';
    const sources = parseSourceTexts(new Map([[path, text]]));
    expect([...sources.keys()]).toEqual([path]);
    expect(sources.get(path)?.text).toBe(text);
  });

  it("refuses inputs that collide on a case-insensitive host", () => {
    const sources = parseSourceTexts(new Map([
      ["src/Panel.ts", 'export const title = "panel.title";'],
      ["src/panel.ts", 'export const title = "other.title";'],
    ]));
    expect(sources.size).toBe(process.platform === "win32" ? 0 : 2);
  });
});

describe("test-only diff policy", () => {
  it.each([
    "src/core/__tests__/route-engine.test.ts", "test/scripts/run-ci-suite.test.ts",
    "test/fixtures/example/data.json", "src/core/__tests__/fixtures/data.json",
  ])("accepts collected tests and fixture assets: %s", (path) => {
    expect(isTestOnlyDiff([modified(path)])).toBe(true);
    expect(isTestOnlyDiff([added(path)])).toBe(true);
    expect(isTestOnlyDiff([deleted(path)])).toBe(true);
  });

  it.each([
    ...FULL_CHECK_GLOBAL_INPUT_FILES, "config/ci-must-run-tests.json", "config/vitest.globalSetup.ts",
    "scripts/run-ci-suite.mjs", ".github/workflows/ci.yml", "src/core/route-engine.ts",
    "test/e2e/example.test.ts", "test/screenshots/example.test.ts", "test/ordinary-helper.ts",
    "src/__tests__/support/git-diff-entry.ts", "src/core/__tests__/fixtures/helper.ts",
    "src/core/__mocks__/client.ts", "scripts/hooks/pre-push-source-policy.mjs",
    "src/main/fixtures/defaults.json", "src/core/fixtures/data.json",
  ])("refuses global inputs, test helpers and non-test inputs: %s", (path) => {
    expect(isTestOnlyDiff([modified(path)])).toBe(false);
    expect(isTestOnlyDiff([modified("src/core/__tests__/route-engine.test.ts"), modified(path)])).toBe(false);
  });

  it("names every importable non-collected test-tree file a test helper module", () => {
    for (const path of [
      "src/__tests__/support/git-diff-entry.ts", "src/core/__tests__/helpers.ts", "src/core/__tests__/fixtures/helper.ts",
      "src/core/__mocks__/client.ts", "test/ordinary-helper.ts", "test/scripts/fixtures/stub.mjs",
      "src/__tests__/vitest-ave-home.ts",
    ]) expect(isTestHelperModule(path), path).toBe(true);
    for (const path of [
      "src/core/__tests__/route-engine.test.ts", "test/fixtures/example/data.json", "src/core/route-engine.ts",
      "scripts/run-ci-suite.mjs", "src/../test/ordinary-helper.ts", "src/main/fixtures/defaults.ts",
    ]) expect(isTestHelperModule(path), path).toBe(false);
    expect(isTestSupportFile("src/main/fixtures/defaults.json")).toBe(false);
    expect(isTestSupportFile("src/core/__tests__/fixtures/data.json")).toBe(true);
    expect(isTestSupportFile("test/fixtures/example/data.json")).toBe(true);
  });

  it("refuses mixed diffs, unsafe paths, mode changes and unresolved changes", () => {
    expect(isTestOnlyDiff([modified("test/example.test.ts"), modified("src/core/route-engine.ts")])).toBe(false);
    expect(isTestOnlyDiff([{ ...modified("test/example.test.ts"), newMode: "100755" }])).toBe(false);
    expect(isTestOnlyDiff([modified("src/../test/example.test.ts")])).toBe(false);
    expect(isTestOnlyDiff([])).toBe(false);
    expect(isTestSupportFile("src/__tests__/support/ave-home-isolation-guard.ts")).toBe(false);
  });

  it("accepts executable fixtures while refusing symlinks and permission changes", () => {
    const fixture = { ...modified("test/fixtures/runner.sh"), oldMode: "100755", newMode: "100755" };
    expect(isTestOnlyDiff([fixture])).toBe(true);
    expect(isTestOnlyDiff([{ ...fixture, newMode: "100644" }])).toBe(false);
    expect(isTestOnlyDiff([{ ...fixture, oldMode: "120000", newMode: "120000" }])).toBe(false);
  });
});

describe("pre-push fast source tier", () => {
  it("takes a source-only change on the fast tier with its related tests", () => {
    const result = selectFastSourceChecks([
      modified("src/ui/renderer/hooks/status-bar/vendor-label.ts"),
    ]);
    expect(result).toMatchObject({
      eligible: true,
      relatedFiles: ["src/ui/renderer/hooks/status-bar/vendor-label.ts"],
      testFiles: [],
    });
    expect(result.reason).toBe("1 source module(s) and 0 test file(s) changed");
  });

  it("splits a mixed change into related modules, direct tests and unconsumed documents", () => {
    const doc = added("docs/notes/example.md");
    const result = selectFastSourceChecks([
      modified("src/engine/turn/provider.ts"),
      added("src/ui/renderer/components/Example.tsx"),
      modified("src/engine/turn/__tests__/provider-subscription.test.ts"),
      modified("test/renderer/approval-reentry.test.tsx"),
      deleted("src/engine/__tests__/retired-case.test.ts"),
      doc,
    ]);
    expect(result.eligible).toBe(true);
    expect(result.relatedFiles).toEqual([
      "src/engine/turn/provider.ts",
      "src/ui/renderer/components/Example.tsx",
    ]);
    expect(result.testFiles).toEqual([
      "src/engine/turn/__tests__/provider-subscription.test.ts",
      "test/renderer/approval-reentry.test.tsx",
    ]);
    expect(result.documentationEntries).toEqual([doc]);
  });

  it.each([
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "tsconfig.tests.json",
    "vitest.config.ts",
    "webpack.config.cjs",
    "postcss.config.cjs",
    "config/vitest.analysis.config.ts",
    "config/vitest.globalSetup.ts",
    "config/test-typecheck-baseline.json",
    "src/__tests__/vitest-ave-home.ts",
    "src/i18n/testing/vitest-ambient-intl.ts",
    "src/__tests__/support/ave-home-isolation-guard.ts",
    "scripts/hooks/run-local-checks.mjs",
    "scripts/hooks/pre-push-source-policy.mjs",
    "scripts/run-vitest-under-electron.mjs",
    "scripts/build-main-esbuild.mjs",
    ".github/workflows/ci.yml",
  ])("keeps the full checks when %s changes", (path) => {
    const result = selectFastSourceChecks([modified("src/engine/turn/provider.ts"), modified(path)]);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(`${path} is a global test or build input`);
  });

  it("keeps the full checks for changes the import graph cannot trace", () => {
    expect(selectFastSourceChecks([deleted("src/engine/turn/provider.ts")])).toMatchObject({
      eligible: false,
      reason: "deleting src/engine/turn/provider.ts requires full checks",
    });
    expect(selectFastSourceChecks([modified("AGENTS.md")])).toMatchObject({
      eligible: false,
      reason: "AGENTS.md is documentation that tests or the build read, with no recorded reader set",
    });
    expect(selectFastSourceChecks([modified("src/ui/styles/app.css")]).eligible).toBe(false);
    expect(selectFastSourceChecks([modified("src/i18n/messages/ko.json")]).eligible).toBe(false);
    expect(
      selectFastSourceChecks([{ ...modified("src/engine/turn/provider.ts"), newMode: "100755" }]),
    ).toMatchObject({ eligible: false, reason: "src/engine/turn/provider.ts file mode 100755 requires full checks" });
    expect(selectFastSourceChecks([{ ...modified("src/a b.ts") }]).eligible).toBe(false);
    expect(selectFastSourceChecks([modified("src/../package.json")]).eligible).toBe(false);
    expect(selectFastSourceChecks([]).eligible).toBe(false);
    expect(selectFastSourceChecks([added("docs/notes/example.md")])).toMatchObject({
      eligible: false,
      reason: "no source or test module changed",
    });
  });

  it("treats every setup file the Vitest config names as a global input", () => {
    const config = readFileSync(resolve(root, "config/vitest.analysis.config.ts"), "utf8");
    const setupLines = config
      .split("\n")
      .filter((line) => /\b(?:setupFiles|globalSetup)\b|const AVE_HOME_GUARD(?:_SEAM_PATH)? =/.test(line));
    const named = setupLines.flatMap((line) => [...line.matchAll(/rootPath\("([^"]+)"\)/g)].map((m) => m[1]));
    expect(named.length).toBeGreaterThanOrEqual(3);
    for (const path of new Set(named)) {
      expect(isFullCheckGlobalInput(path), `${path} is injected by the Vitest config`).toBe(true);
    }
  });

  it.each([
    "tsconfig.build.json",
    "src/shared/ave-home-test-guard.ts",
    "src/shared/ambient.d.ts",
    "src/shared/ambient.d.mts",
    "src/i18n/messages/index.ts",
    "src/i18n/messages/catalog-helpers.ts",
    "src/i18n/messages/generated/nested/fragment.ts",
    "src/preload.ts",
    "src/floating-dock-preload.ts",
    "src/plugins/isolation/plugin-child-main.ts",
    "src/engine/worker-entry.ts",
  ])("requires full checks for an input outside runtime import coverage: %s", (path) => {
    expect(selectFastSourceChecks([modified(path)]).eligible).toBe(false);
  });

  it("requires full checks when an executable module becomes a regular file", () => {
    expect(selectFastSourceChecks([
      { ...modified("src/engine/turn/provider.ts"), oldMode: "100755" },
    ]).eligible).toBe(false);
  });

  it("requires full checks for a move represented by deletion and addition", () => {
    expect(selectFastSourceChecks([
      deleted("src/engine/turn/provider.ts"),
      added("src/engine/turn/moved-provider.ts"),
    ]).eligible).toBe(false);
  });

  it("names lock suites and global input files that exist", () => {
    for (const path of [...AVE_APP_LOCK_SUITES, ...FULL_CHECK_GLOBAL_INPUT_FILES]) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
  });

  it("keeps the host protocol guidance aligned with the fixed lock selections", () => {
    const doc = readFileSync(resolve(root, "docs/design/plugin-hostapi-protocol.md"), "utf8");
    const start = doc.indexOf("`bootstrap-integration`, `use-send-message-resource`, `alert-predecessor` unchanged");
    expect(start).toBeGreaterThanOrEqual(0);
    const guidance = doc.slice(start, doc.indexOf("##### A2.", start));
    expect(guidance).not.toContain("and run in the pre-push hook's lock suites");
    expect(guidance).toContain("`scripts/hooks/pre-push-source-policy.mjs`");
  });

  it("wires the fast tier, its opt-out and its log line into the hook", () => {
    const hook = readFileSync(resolve(root, "scripts/hooks/run-local-checks.mjs"), "utf8");
    expect(hook).toContain('process.env.AVE_PREPUSH_FULL === "1"');
    expect(hook).toContain("console.log(describeScopedTier({");
    expect(readFileSync(resolve(root, "scripts/hooks/pre-push-tier.mjs"), "utf8")).toContain("[checks] tier=${tier} pre-push");
    expect(hook).toContain("[checks] tier=full ${stage}");
    expect(hook).not.toContain('"--passWithNoTests"');
    expect(hook).toContain('"--reporter=json"');
    expect(hook.indexOf("getFastSourceRelatedSelection(repoRoot,")).toBeGreaterThanOrEqual(0);
    expect(hook.indexOf("getFastSourceRelatedSelection(repoRoot,")).toBeLessThan(hook.indexOf("console.log(describeScopedTier({"));
    expect(hook).toContain('runVitestChunks(bun, dir, directArgs, (chunk) => ["run", "test:vitest", "--", "run", ...chunk]);');
    const shellHook = readFileSync(resolve(root, "scripts/hooks/pre-push"), "utf8");
    expect(shellHook).toContain('if [ "${AVE_HOOKS_SKIP:-}" = "1" ] || [ "${SKIP_AVE_HOOKS:-}" = "1" ]; then');
  });

  it("runs the recorded readers of a test-read document instead of the whole suite", () => {
    const result = selectFastSourceChecks([modified("web/DEPLOY.md")]);
    expect(result).toMatchObject({
      eligible: true,
      testFiles: ["test/scripts/repository-identity.test.ts"],
      relatedFiles: [],
    });
    expect(result.documentationEntries.map(({ path }) => path)).toEqual(["web/DEPLOY.md"]);
    expect(result.reason).toContain("readers of 1 test-read document(s)");
    // Consumed documents without recorded readers require full checks.
    expect(selectFastSourceChecks([modified("web/NOT-RECORDED.md")])).toMatchObject({
      eligible: false,
      reason: "web/NOT-RECORDED.md is documentation that tests or the build read, with no recorded reader set",
    });
    expect(selectFastSourceChecks([deleted("web/DEPLOY.md")]).eligible).toBe(false);
  });

  it("pins the lock-suite trigger table", () => {
    // Each trigger must name a scanned path, a read file or a pinned module.
    expect(AVE_APP_LOCK_SUITE_TRIGGERS).toEqual({
      "src/__tests__/packaging-discipline-source.test.ts": [
        "AGENTS.md",
        "CLAUDE.md",
        "docs/references/production-release-checklist.md",
        "resources/",
        "src/lib/log-file-sink.ts",
        "src/main/ave-protocol-registration.ts",
      ],
      "src/__tests__/preload-shape.test.ts": ["src/contract/", "src/preload", "src/shared/ipc-channels.ts", "src/ui/renderer/types.ts"],
      "src/__tests__/preload.test.ts": ["src/contract/", "src/preload", "src/shared/ipc-channels.ts", "src/ui/renderer/types.ts"],
      "src/data/__tests__/settings-store.test.ts": [
        "src/data/secret-document-store.ts",
        "src/data/settings-",
        "src/shared/settings",
      ],
      "src/ipc/__tests__/channel-inventory.test.ts": ["src/contract/", "src/ipc/", "src/shared/ipc-channels.ts"],
      "src/ipc/__tests__/domain-exports.test.ts": ["src/ipc/domains/", "src/shared/ipc-channels.ts"],
      "src/ipc/__tests__/host-renderer-only-channels.test.ts": ["src/contract/", "src/ipc/", "src/shared/ipc-channels.ts"],
      "src/ui/renderer/__tests__/format-ipc-error-coverage.test.ts": [
        "src/alerts/",
        "src/ipc/domains/",
        "src/shared/alerts-types.ts",
        "src/ui/renderer/format-ipc-error.ts",
      ],
      "src/ui/renderer/__tests__/settings-section-anchors.test.ts": ["src/shared/settings-tabs.ts", "src/ui/renderer/"],
      "test/scripts": ["package.json", "scripts/"],
    });
    expect(AVE_APP_LOCK_SUITES).toEqual(Object.keys(AVE_APP_LOCK_SUITE_TRIGGERS));
    for (const trigger of Object.values(AVE_APP_LOCK_SUITE_TRIGGERS).flat()) {
      const directory = trigger.slice(0, trigger.lastIndexOf("/") + 1);
      const matched = existsSync(resolve(root, trigger)) ||
        readdirSync(resolve(root, directory || ".")).some((name) => `${directory}${name}`.startsWith(trigger));
      expect(matched, trigger).toBe(true);
    }
  });

  it("selects only the lock suites whose triggers changed", () => {
    expect(selectTriggeredLockSuites(["src/permissions/judge/judge-engine.ts", "src/audit/audit-schema.ts"])).toEqual([]);
    expect(selectTriggeredLockSuites(["src/ui/renderer/format-ipc-error.ts"])).toEqual([
      { suite: "src/ui/renderer/__tests__/format-ipc-error-coverage.test.ts", path: "src/ui/renderer/format-ipc-error.ts" },
      { suite: "src/ui/renderer/__tests__/settings-section-anchors.test.ts", path: "src/ui/renderer/format-ipc-error.ts" },
    ]);
    expect(selectTriggeredLockSuites(["src/preload/plugin-bridge.ts"]).map(({ suite }) => suite)).toEqual([
      "src/__tests__/preload-shape.test.ts",
      "src/__tests__/preload.test.ts",
    ]);
    expect(selectTriggeredLockSuites(["scripts/hooks/run-local-checks.mjs"]).map(({ suite }) => suite)).toEqual(["test/scripts"]);
  });

  it("bounds a shared module's related-test fan-out to its direct importers", () => {
    const fanOut = Array.from({ length: RELATED_TEST_BOUND + 10 }, (_, index) => `src/feature${index}/__tests__/feature.test.ts`);
    const texts = new Map<string, string>([
      [fanOut[0]!, 'import { schema } from "../../audit/audit-schema.js";\n'],
      [fanOut[1]!, 'vi.mock("../../audit/audit-schema", () => ({}));\n'],
      [fanOut[2]!, 'import { other } from "../../audit/audit-schema-helpers.js";\n'],
    ]);
    const coverage = [
      { source: "src/audit/audit-schema.ts", tests: fanOut },
      { source: "src/permissions/judge/judge-engine.ts", tests: ["src/permissions/judge/__tests__/judge-engine.test.ts"] },
    ];
    const read = (path: string) => texts.get(path) ?? "";
    expect(boundRelatedTests(coverage, read)).toEqual({
      tests: [fanOut[0], fanOut[1], "src/permissions/judge/__tests__/judge-engine.test.ts"].sort(),
      narrowed: [{ source: "src/audit/audit-schema.ts", related: RELATED_TEST_BOUND + 10, direct: 2, lockSuites: 0 }],
    });
    expect(boundRelatedTests([{ source: "src/a.ts", tests: fanOut.slice(0, 30) }], read)).toEqual({
      tests: [...fanOut.slice(0, 30)].sort(), narrowed: [],
    });
    // A fan-out module with no direct importer must not disappear from selection.
    expect(boundRelatedTests([{ source: "src/lonely.ts", tests: fanOut }], read).reason)
      .toBe(`src/lonely.ts reaches ${RELATED_TEST_BOUND + 10} related test files and none imports it directly; full checks required`);
  });

  it("prints the triggered lock suites and the bounded related set", () => {
    const hook = readFileSync(resolve(root, "scripts/hooks/run-local-checks.mjs"), "utf8");
    expect(hook).toContain("[checks] lock suite ${suite}: triggered by ${path}");
    expect(hook).toContain("[checks] related tests bounded: ${source} reaches ${related} test file(s)");
    expect(hook).toContain("lockSuites: selectTriggeredLockSuites([...changedFiles])");
  });

  it("keeps the IPC lock suites when src/shared/ipc-channels.ts changes alone", () => {
    // Preserve transitive lock suites when narrowing a large related-test set to direct importers.
    expect(selectTriggeredLockSuites(["src/shared/ipc-channels.ts"]).map(({ suite }) => suite)).toEqual([
      "src/__tests__/preload-shape.test.ts",
      "src/__tests__/preload.test.ts",
      "src/ipc/__tests__/channel-inventory.test.ts",
      "src/ipc/__tests__/domain-exports.test.ts",
      "src/ipc/__tests__/host-renderer-only-channels.test.ts",
    ]);
    const viaBarrel = [
      "src/__tests__/preload.test.ts",
      "src/ipc/__tests__/channel-inventory.test.ts",
      "src/ipc/__tests__/domain-exports.test.ts",
    ];
    const importers = Array.from({ length: 21 }, (_, index) => `src/importer${index}/__tests__/importer.test.ts`);
    const transitive = Array.from({ length: 255 - 21 - viaBarrel.length }, (_, index) => `src/other${index}/__tests__/other.test.ts`);
    const texts = new Map(importers.map((path) => [path, 'import { CHANNELS } from "../../shared/ipc-channels.js";\n']));
    const result = boundRelatedTests(
      [{ source: "src/shared/ipc-channels.ts", tests: [...importers, ...viaBarrel, ...transitive] }],
      (path) => texts.get(path) ?? 'import { CHANNELS } from "../../contract/app-contract.js";\n',
    );
    expect(result.reason).toBeUndefined();
    expect(result.tests).toEqual([...importers, ...viaBarrel].sort());
    expect(result.narrowed).toEqual([
      { source: "src/shared/ipc-channels.ts", related: 255, direct: 21, lockSuites: 3 },
    ]);
  });

  it("triggers every lock suite that reaches the contract barrel on the barrel's own imports", () => {
    const barrel = "src/contract/app-contract.ts";
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|vi\.mock\(\s*)["'](\.[^"']+)["']/g;
    const resolveModule = (from: string, spec: string) => {
      const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.(?:js|mjs)$/, "");
      return [".ts", ".tsx", ".mts", "/index.ts"].map((ext) => base + ext).find((path) => existsSync(resolve(root, path))) ?? null;
    };
    // Strip comments before scanning imports; JSDoc links are not dependencies.
    const importCache = new Map<string, string[]>();
    const imports = (file: string) => {
      const cached = importCache.get(file);
      if (cached) return cached;
      const dependencies = [...readFileSync(resolve(root, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").matchAll(specifier)]
        .map((match) => resolveModule(file, match[1]!))
        .filter((path): path is string => path !== null && path.startsWith("src/"));
      importCache.set(file, dependencies);
      return dependencies;
    };
    const reaches = (start: string, target: string) => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        for (const next of imports(stack.pop()!)) {
          if (next === target) return true;
          if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
      }
      return false;
    };
    const barrelImports = imports(barrel);
    expect(barrelImports).toContain("src/shared/ipc-channels.ts");
    const reachingSuites = AVE_APP_LOCK_SUITES.filter((suite) => suite.endsWith(".ts") && reaches(suite, barrel));
    expect(reachingSuites.length).toBeGreaterThanOrEqual(5);
    for (const suite of reachingSuites) {
      for (const path of barrelImports) {
        expect(AVE_APP_LOCK_SUITE_TRIGGERS[suite]!.some((trigger) => path.startsWith(trigger)), `${suite} on ${path}`).toBe(true);
      }
    }
  });
});

// Select catalog consumers by changed key namespace instead of the shared translation import graph.
describe("pre-push message catalog selection", () => {
  const MESSAGES = "src/i18n/messages";
  const tracked = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src", "test"], { encoding: "utf8" })
    .split("\0").filter((path) => path !== "" && existsSync(resolve(root, path)));
  const texts = new Map<string, string>();
  const readTracked = (path: string) => {
    if (!texts.has(path)) texts.set(path, readFileSync(resolve(root, path), "utf8"));
    return texts.get(path)!;
  };
  const catalogFiles = () => [
    "en.ts",
    "ko.ts",
    ...readdirSync(resolve(root, MESSAGES, "generated")).filter((name) => name !== "index.ts").map((name) => `generated/${name}`),
  ].map((name) => `${MESSAGES}/${name}`);

  it("takes catalog data on the fast tier and leaves the loader and unknown files global", () => {
    for (const path of [
      `${MESSAGES}/en.ts`, `${MESSAGES}/ko.ts`, `${MESSAGES}/generated/shellExecution.ts`,
      `${MESSAGES}/generated/index.ts`, `${MESSAGES}/generated-locales/ko.ts`,
    ]) {
      expect(isMessageCatalogPath(path), path).toBe(true);
      expect(isFullCheckGlobalInput(path), path).toBe(false);
    }
    expect(isFullCheckGlobalInput(`${MESSAGES}/index.ts`)).toBe(true);
    const changes = [
      modified(`${MESSAGES}/generated/shellExecution.ts`),
      added(`${MESSAGES}/generated/newSurface.ts`),
      modified(`${MESSAGES}/generated/index.ts`),
      modified(`${MESSAGES}/generated-locales/ko.ts`),
      modified(`${MESSAGES}/ko.ts`),
    ];
    const result = selectFastSourceChecks(changes);
    expect(result).toMatchObject({ eligible: true, testFiles: [], relatedFiles: [] });
    expect(result.messageCatalogEntries).toEqual(changes);
    expect(result.reason).toBe("0 source module(s) and 0 test file(s) changed, with 5 message catalog file(s)");
    // Removed fragments require keys from the old tree.
    expect(selectFastSourceChecks([deleted(`${MESSAGES}/generated/shellExecution.ts`)]).eligible).toBe(false);
    expect(selectFastSourceChecks([{ ...modified(`${MESSAGES}/en.ts`), newMode: "100755" }]).eligible).toBe(false);
  });

  it("reads every key of the real catalog, and nothing the runtime does not load", () => {
    // Reuse one compiler session across the catalog to bound native child spawns.
    const texts = new Map(catalogFiles().map((path) => [path, readFileSync(resolve(root, path), "utf8")]));
    const byPath = readMessageCatalogEntriesByPath(texts);
    expect([...byPath.keys()]).toEqual([...texts.keys()]);
    const keys = new Set<string>();
    for (const [path, entries] of byPath) {
      expect(entries, path).not.toBeNull();
      for (const key of entries!.keys()) keys.add(key);
    }
    expect([...keys].sort()).toEqual(Object.keys(messages.en).sort());
    for (const path of [`${MESSAGES}/en.ts`, `${MESSAGES}/ko.ts`, `${MESSAGES}/generated/shellExecution.ts`]) {
      expect(byPath.get(path), path).toEqual(readMessageCatalogEntries(texts.get(path)!, path));
    }
    // Barrels carry no keys; verify them separately against the fragments.
    const barrel = readFileSync(resolve(root, MESSAGES, "generated/index.ts"), "utf8");
    expect(readMessageCatalogEntries(barrel)).toBeNull();
    expect(readMessageCatalogEntriesByPath(new Map([
      [`${MESSAGES}/generated/index.ts`, barrel],
      [`${MESSAGES}/generated/panel.ts`, "export const en = {"],
      [`${MESSAGES}/generated/other.ts`, null],
    ]))).toEqual(new Map([
      [`${MESSAGES}/generated/index.ts`, null],
      [`${MESSAGES}/generated/panel.ts`, null],
      [`${MESSAGES}/generated/other.ts`, null],
    ]));
  });

  it("keeps by-path catalog results equal to individual reads with mixed valid and refused modules", () => {
    const texts = new Map<string, string | null>([
      [`${MESSAGES}/en.ts`, 'export const en = { "seed.title": "Seed" } as const;'],
      [`${MESSAGES}/generated/panel.ts`, 'export const en = { "panel.title": "Panel" } as const; export const ko: Record<keyof typeof en, string> = { "panel.title": "패널" };'],
      [`${MESSAGES}/generated/dynamic.ts`, 'export const en = { "panel.title": label("Panel") } as const; export const ko: Record<keyof typeof en, string> = { "panel.title": "패널" };'],
      [`${MESSAGES}/generated/broken.ts`, 'export const en = { "panel.title": "unterminated };'],
      [`${MESSAGES}/generated/separator.ts`, 'export const en = { "panel.title": "Panel\u2028title" } as const;'],
      [`${MESSAGES}/generated/absent.ts`, null],
      [`${MESSAGES}/generated/index.ts`, 'export { en } from "./panel.js";'],
    ]);
    const catalogs = readMessageCatalogEntriesByPath(texts);
    expect([...catalogs.keys()]).toEqual([...texts.keys()]);
    for (const [path, text] of texts) {
      expect(catalogs.get(path), path).toEqual(readMessageCatalogEntries(text, path));
    }
    expect(catalogs.get(`${MESSAGES}/en.ts`)).toEqual(new Map([["seed.title", { en: "Seed" }]]));
    expect(catalogs.get(`${MESSAGES}/generated/panel.ts`)).toEqual(new Map([["panel.title", { en: "Panel", ko: "패널" }]]));
    for (const name of ["dynamic", "broken", "separator", "absent", "index"]) {
      expect(catalogs.get(`${MESSAGES}/generated/${name}.ts`), name).toBeNull();
    }
    expect(readMessageCatalogEntries(texts.get(`${MESSAGES}/generated/index.ts`)!)).toBeNull();
  });

  it("refuses a colliding batch without retaining catalog state for the next snapshot", () => {
    const path = `${MESSAGES}/generated/panel.ts`;
    const alias = `${MESSAGES}/generated/./panel.ts`;
    const text = 'export const en = { "panel.title": "Panel" } as const; export const ko: Record<keyof typeof en, string> = { "panel.title": "패널" };';
    expect(readMessageCatalogEntriesByPath(new Map([[path, text], [alias, text]]))).toEqual(new Map([
      [path, null],
      [alias, null],
    ]));
    expect(readMessageCatalogEntriesByPath(new Map([[path, text]])).get(path)).toEqual(new Map([
      ["panel.title", { en: "Panel", ko: "패널" }],
    ]));
    const restored = text.replaceAll("Panel", "Restored");
    expect(readMessageCatalogEntriesByPath(new Map([[path, restored]])).get(path)).toEqual(new Map([
      ["panel.title", { en: "Restored", ko: "패널" }],
    ]));
    expect(readMessageCatalogEntriesByPath(new Map())).toEqual(new Map());
  });

  it("refuses catalog shapes whose keys it cannot read", () => {
    expect(readMessageCatalogEntries('export const en = { "a.b": "x" + "y", "a.c": `z` } as const;')).toEqual(
      new Map([["a.b", { en: "xy" }], ["a.c", { en: "z" }]]),
    );
    for (const text of [
      'export const en = { ...base, "a.b": "x" };',
      'export const en = { ["a." + id]: "x" };',
      'export const en = { "a.b": `x ${name}` };',
      'export const en = { "a.b": label("x") };',
      'export const en = { "a.b": "unterminated };',
      "export const en = 1;",
      'export const en = { "a.b": "x", "a.b": "y" } as const;',
      'export const en = { "a.b": "x" } as const; en["a.b"] = "y";',
      'export const en = { "a.b": "x" } as const; export { en as ko };',
      'export let en = { "a.b": "x" } as const;',
      'const en = { "a.b": "x" } as const;',
      'import "./mutate.js"; export const en = { "a.b": "x" } as const;',
      null,
    ]) {
      expect(readMessageCatalogEntries(text), String(text)).toBeNull();
    }
  });

  const fragment = (title: string, other = "Other") =>
    `export const en = {\n  "panel.title": ${JSON.stringify(title)},\n  "other.label": ${JSON.stringify(other)},\n} as const;\n` +
    'export const ko: Record<keyof typeof en, string> = {\n  "panel.title": "패널",\n  "other.label": "기타",\n};\n';
  const runtimeTree = new Map([
    ["src/i18n/runtime.ts", 'export function t(key: string, vars?: unknown) { return key; } export function getLocale() { return "en"; }'],
    ["src/i18n/translate.ts", 'export type TranslateFn = (key: string, vars?: unknown) => string; export function translate(locale: string, key: string, vars?: unknown) { return key; } export function interpolate(value: string) { return value; }'],
    ["src/i18n/react.tsx", 'export function useTranslation(): { t: (key: string, vars?: unknown) => string } { throw null; }'],
  ]);
  const fixtureTree = new Map<string, string>([
    ["src/ui/panel.tsx", 'import { t } from "../i18n/runtime.js"; export const title = () => t("panel.title");'],
    ["src/ui/panel-kinds.ts", 'export const keys = { title: "panel.title" } as const;'],
    ["src/ui/other.tsx", 'import { t } from "../i18n/runtime.js"; export const label = () => t("other.label");'],
    ["src/marketplace/language-check.ts", 'export const catalogPath = "i18n/messages";'],
    ["src/ui/__tests__/panel-copy.test.tsx", 'import { t } from "../../i18n/runtime.js"; export const actual = t("panel.title");'],
    ["src/ui/__tests__/other.test.tsx", 'import { t } from "../../i18n/runtime.js"; export const actual = t("other.label");'],
    ["src/i18n/__tests__/i18n.test.ts", 'export const suiteName = "i18n";'],
    ["test/e2e/panel.spec.ts", 'import { t } from "../../src/i18n/runtime.js"; export const expected = t("panel.title");'],
    ["docs/panel.md", '"panel.title"'],
  ]);
  const selectFixture = (before: string | null, after: string, tree = fixtureTree) =>
    selectMessageCatalogChecks(
      [{ ...(before === null ? added : modified)(`${MESSAGES}/generated/panel.ts`), baseSha: "base", localSha: "local" }],
      {
        readBlob: (sha, path) => (path === `${MESSAGES}/generated/panel.ts` ? (sha === "base" ? before : after) : null),
        trackedFiles: [...new Set([...runtimeTree.keys(), ...tree.keys()])],
        readTrackedFile: (path) => tree.get(path) ?? runtimeTree.get(path) ?? null,
      },
    );

  it("selects the modules and tests that name a changed namespace, the catalog readers and the i18n suites", () => {
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"))).toEqual({
      namespaces: ["panel"],
      testFiles: ["src/i18n/__tests__/i18n.test.ts", "src/ui/__tests__/panel-copy.test.tsx"],
      consumerModules: ["src/marketplace/language-check.ts", "src/ui/panel-kinds.ts", "src/ui/panel.tsx"],
    });
    expect(selectFixture(fragment("Panel"), fragment("Panel").replace('"패널"', '"패널 제목"')).namespaces).toEqual(["panel"]);
    expect(selectFixture(null, fragment("Panel")).namespaces).toEqual(["other", "panel"]);
    // Unattributable source value changes require full checks.
    expect(selectFixture(fragment("Panel"), `// reflowed\n${fragment("Panel")}`)).toEqual({
      reason: `${MESSAGES}/generated/panel.ts has changes outside attributable message values; full checks required`,
    });
  });

  const orderedFragment = 'export const en = { "panel.title": "Panel", "other.label": "Other" };\n' +
    'export const ko = { "panel.title": "패널", "other.label": "기타" };\n';
  const reorderedFragment = orderedFragment.replace('"panel.title": "Panel", "other.label": "Other"',
    '"other.label": "Other", "panel.title": "Panel"');

  it("keeps full checks when a catalog reorder changes an order exported through an i18n helper", () => {
    const order = (text: string) => runInNewContext(`${text.replaceAll("export const ", "const ")}; Object.keys(en);`);
    expect(order(orderedFragment)).toEqual(["panel.title", "other.label"]);
    expect(order(reorderedFragment)).toEqual(["other.label", "panel.title"]);
    const tree = new Map(fixtureTree);
    tree.set("src/i18n/message-order.ts", 'import { en } from "./messages/generated/panel.js"; export const messageOrder = Object.keys(en);');
    tree.set("src/ui/__tests__/message-order.test.ts", 'import { messageOrder } from "../../i18n/message-order.js"; export const actual = messageOrder;');
    expect(selectFixture(orderedFragment, reorderedFragment, tree)).toEqual({
      reason: `${MESSAGES}/generated/panel.ts has changes outside attributable message values; full checks required`,
    });
  });

  it.each([
    ["english value", "generated/panel.ts", fragment("Panel"), fragment("Panel heading"), ["panel"]],
    ["translated value", "generated/panel.ts", fragment("Panel"), fragment("Panel").replace('"패널"', '"패널 제목"'), ["panel"]],
    ["literal whitespace", "generated/panel.ts", fragment("Panel"), fragment(" Panel "), ["panel"]],
    ["literal newline", "generated/panel.ts", fragment("Panel"), fragment("Panel\n"), ["panel"]],
    ["multibyte values", "generated/panel.ts", fragment("🧪 패널"), fragment("🧪 패널 제목", "Other heading"), ["other", "panel"]],
    ["equivalent escape", "generated/panel.ts", fragment("Panel"), fragment("Panel").replace('"Panel"', String.raw`"\u0050anel"`), null],
    ["equivalent escape with another value", "generated/panel.ts", fragment("Panel"), fragment("Panel", "Other heading").replace('"Panel"', String.raw`"\u0050anel"`), null],
    ["added comment", "generated/panel.ts", fragment("Panel"), `// catalog note\n${fragment("Panel")}`, null],
    ["comment with value", "generated/panel.ts", fragment("Panel"), `// catalog note\n${fragment("Panel heading")}`, null],
    ["source whitespace", "generated/panel.ts", fragment("Panel"), `${fragment("Panel")}\n`, null],
    ["english reorder", "generated/panel.ts", orderedFragment, reorderedFragment, null],
    ["english reorder with value", "generated/panel.ts", orderedFragment, reorderedFragment.replace('"Panel"', '"Panel heading"'), null],
    ["translated reorder", "generated/panel.ts", orderedFragment, orderedFragment.replace('"panel.title": "패널", "other.label": "기타"', '"other.label": "기타", "panel.title": "패널"'), null],
    ["translated reorder with value", "generated/panel.ts", orderedFragment, orderedFragment.replace('"panel.title": "패널", "other.label": "기타"', '"other.label": "기타", "panel.title": "패널 제목"'), null],
    ["new fragment", "generated/panel.ts", null, fragment("Panel"), ["other", "panel"]],
    ["empty fragment", "generated/panel.ts", null, "export const en = {}; export const ko = {};", null],
    ["seed comment", "en.ts", 'export const en = { "panel.title": "Panel" };', '// catalog note\nexport const en = { "panel.title": "Panel" };', null],
    ["barrel comment", "generated/index.ts", 'export { en } from "./panel.js";', '// catalog note\nexport { en } from "./panel.js";', null],
    ["locale barrel comment", "generated-locales/ko.ts", 'export { ko } from "../generated/panel.js";', '// catalog note\nexport { ko } from "../generated/panel.js";', null],
  ] as const)("never returns an empty fast namespace selection for a changed catalog: %s", (_kind, name, before, after, expected) => {
    expect(after).not.toBe(before);
    const path = `${MESSAGES}/${name}`;
    const selection = selectMessageCatalogChecks([
      { ...(before === null ? added : modified)(path), baseSha: "base", localSha: "local" },
    ], {
      readBlob: (sha) => sha === "base" ? before : after,
      trackedFiles: [...runtimeTree.keys(), ...fixtureTree.keys()],
      readTrackedFile: (path) => fixtureTree.get(path) ?? runtimeTree.get(path) ?? null,
    });
    expect(selection.namespaces).not.toEqual([]);
    if (expected === null) expect(selection.reason).toMatch(/full checks required$/);
    else {
      expect(selection.reason).toBeUndefined();
      expect(selection.namespaces).toEqual(expected);
    }
  });

  it.each([false, true])("keeps full checks for an unattributed file beside an attributed value edit (reverse=%j)", (reverse) => {
    const valuePath = `${MESSAGES}/generated/panel.ts`;
    const unassignedPath = `${MESSAGES}/generated/other.ts`;
    const changes = [valuePath, unassignedPath].map((path) => ({ ...modified(path), baseSha: "base", localSha: "local" }));
    if (reverse) changes.reverse();
    expect(selectMessageCatalogChecks(changes, {
      readBlob: (sha, path) => path === valuePath
        ? fragment(sha === "base" ? "Panel" : "Panel heading")
        : `${sha === "base" ? "" : "// catalog note\n"}${fragment("Panel")}`,
      trackedFiles: [...runtimeTree.keys(), ...fixtureTree.keys()],
      readTrackedFile: (path) => fixtureTree.get(path) ?? runtimeTree.get(path) ?? null,
    })).toEqual({
      reason: `${unassignedPath} has changes outside attributable message values; full checks required`,
    });
  });

  it("keeps the full checks when a changed namespace has no literal consumer or a consumer is a global input", () => {
    const unnamed = new Map([...fixtureTree].filter(([path]) => !["src/ui/panel.tsx", "src/ui/panel-kinds.ts",
      "src/ui/__tests__/panel-copy.test.tsx", "test/e2e/panel.spec.ts"].includes(path)));
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), unnamed)).toEqual({
      reason: "no source file names message namespace panel; a computed key may reach it, full checks required",
    });
    const preload = new Map([...fixtureTree, ["src/panel-preload.ts", 'import { t } from "./i18n/runtime.js"; const title = t("panel.title");']]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), preload)).toEqual({
      reason: "src/panel-preload.ts names a changed message namespace and is a global test or build input",
    });
    expect(selectFixture("export const en = { ...base };", fragment("Panel heading"))).toEqual({
      reason: `${MESSAGES}/generated/panel.ts has a shape the message key reader does not accept; full checks required`,
    });
  });

  // Independent expected decisions must reject unresolved coverage even beside a literal consumer.
  it.each([
    'export const title = (ns: string) => t(`${ns}.title`);',
    'export const title = (kind: string) => t(`panel.${kind}`);',
    'export const title = (key: string) => t(key);',
    'export const title = (key: string) => t?.(key);',
    'export const title = (key: string) => i18n.t(key);',
    'export const title = (key: string) => i18n["t"](key);',
    'const member = "t"; export const title = (ns: string) => useTranslation()[member](`${ns}.title`);',
    'export const title = (locale: string, expression: string) => translate(locale, expression);',
    'export const title = (ns: string) => translate("en", `${ns}.title`);',
    'const context = useTranslation(); export const title = (member: string, ns: string) => context[member](`${ns}.title`);',
    'const { [member]: render } = useTranslation(); export const title = (ns: string) => render(`${ns}.title`);',
    'import { useTranslation as useText } from "../i18n/react.js"; const member = "t"; export const title = () => useText()[member](expression);',
    'import { translate as render } from "../i18n/index.js"; export const title = () => render(locale, expression);',
    'import * as text from "../i18n/index.js"; export const title = () => text[member](locale, expression);',
    'export const render = translate;',
    'export const useText = useTranslation;',
    'const text = await import("../i18n/index.js"); text[member](expression);',
    'const text = await import(modulePath); text[member](expression);',
    'const text = require("../i18n/index.js"); text[member](expression);',
    'export * from "../i18n/index.js";',
    'import { t as translate } from "../i18n/index.js"; export const title = (key: string) => translate(key);',
    'const translate = t; export const title = (key: string) => translate(key);',
    'const translate = (t); export const title = (key: string) => translate(key);',
    'const translate = i18n.t; export const title = (key: string) => translate(key);',
    'const translate = i18n["t"]; export const title = (key: string) => translate(key);',
    'const translate = enabled ? t : other; export const title = (key: string) => translate(key);',
    'const translate = t.bind(null); export const title = (key: string) => translate(key);',
    'const { t: translate } = i18n; export const title = (key: string) => translate(key);',
    'let translate; ({ t: translate } = i18n); export const title = (key: string) => translate(key);',
    'let translate; ({ ["t"]: translate } = i18n); export const title = (key: string) => translate(key);',
    'const { ["t"]: translate } = i18n; export const title = (key: string) => translate(key);',
    'export const dictionary = { translate: i18n.t };',
    'export const dictionary = { t };',
    'export const translator = () => t;',
    'export { t as translate };',
    'export const labels = keys.map(t);',
    'export const labels = keys.map(i18n.t);',
    'export const title = () => t("panel." + "title");',
    'export const title = () => t();',
    'export const keys = { title: `${namespace}.title` };',
    'export const MESSAGE_KEYS = [namespace + ".title"];',
    'export const keys = { ...sharedKeys };',
    'export const keys = makeKeys(namespace);',
    'export const titleKeys = { title: `${namespace}.title` };',
  ])("keeps full checks for an unresolved consumer alongside a literal consumer: %s", (text) => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.ts", text);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.ts has an unresolved dynamic message consumer; full checks required",
    });
  });

  it.each([
    'import { t } from "../i18n/runtime.js"; export const title = () => t("panel.title");',
    'import { t as render } from "../i18n/runtime.js"; export const title = () => render("panel.title");',
    'import { translate } from "../i18n/translate.js"; export const title = () => translate(locale, "panel.title");',
    'import { translate as render } from "../i18n/translate.js"; export const title = () => render(locale, "panel.title");',
    'import { useTranslation } from "../i18n/react.js"; const { t } = useTranslation(); export const title = () => t("panel.title");',
    'import { useTranslation as useText } from "../i18n/react.js"; const { t: render } = useText(); export const title = () => render("panel.title");',
    'import { t } from "../i18n/./runtime.js"; export const title = () => t("panel.title", { ...vars });',
  ])("recognizes a proven literal-key call: %s", (text) => {
    const tree = new Map([["src/ui/literal.ts", text]]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      namespaces: ["panel"], testFiles: [], consumerModules: ["src/ui/literal.ts"],
    });
  });

  it.each([
    ["relative namespace", "src/i18n/dynamic.ts", 'import * as text from "./runtime.js"; const member = "t"; text[member](`${ns}.title`);'],
    ["unknown receiver signature", "src/ui/dynamic.ts", 'intl.translate(`${ns}.title`, "fallback");'],
  ])("requires full checks for the reviewed %s omission beside a literal consumer", (_kind, path, text) => {
    const tree = new Map(fixtureTree);
    tree.set(path!, text!);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: `${path} has an unresolved dynamic message consumer; full checks required`,
    });
  });

  it.each([
    ["namespace import", 'import * as text from "../i18n/runtime.js"; text.t("panel.title");'],
    ["default import", 'import render from "../i18n/runtime.js"; render("panel.title");'],
    ["side effect import", 'import "../i18n/runtime.js";'],
    ["import assignment", 'import text = require("../i18n/runtime.js"); text.t("panel.title");'],
    ["computed member", 'import { t } from "../i18n/runtime.js"; t[member]("panel.title");'],
    ["computed literal member", 'import { t } from "../i18n/runtime.js"; t["call"](null, "panel.title");'],
    ["unknown t receiver", 'intl.t("panel.title");'],
    ["unknown receiver binding", 'const { "translate": render } = intl; render(`${ns}.title`, "fallback");'],
    ["indirect export name", 'Reflect.get(intl, "translate")(`${ns}.title`, "fallback");'],
    ["constructed export name", 'Reflect.get(intl, "trans" + "late")(`${ns}.title`, "fallback");'],
    ["indirect alias", 'const render = Reflect.get(intl, "trans" + "late"); render(expression);'],
    ["unknown direct callable", 'render(expression);'],
    ["unknown member callable", 'intl.render(expression);'],
    ["generated callable", 'const render = new Function(code); render(expression);'],
    ["evaluated callable", 'eval(code);'],
    ["unknown computed receiver", 'intl["translate"](`${ns}.title`, "fallback");'],
    ["wrapped computed receiver", 'intl[("translate")](`${ns}.title`, "fallback");'],
    ["computed expression receiver", 'intl["trans" + "late"](`${ns}.title`, "fallback");'],
    ["unresolved computed receiver", 'intl[member](`${ns}.title`, "fallback");'],
    ["unbound literal call", 't("panel.title");'],
    ["unfollowed alias", 'import { t } from "../i18n/runtime.js"; const render = t; render("panel.title");'],
    ["instantiated alias", 'import { t as render } from "../i18n/runtime.js"; const invoke = render<string>; invoke(expression);'],
    ["heritage reference", 'import { t as render } from "../i18n/runtime.js"; class Consumer extends mixin(render) {}'],
    ["callback reference", 'import { t } from "../i18n/runtime.js"; values.map(t);'],
    ["object reference", 'import { t } from "../i18n/runtime.js"; export const functions = { t };'],
    ["spread after key", 'import { t } from "../i18n/runtime.js"; t("panel.title", ...values);'],
    ["spread before key", 'import { translate } from "../i18n/translate.js"; translate(...values, "panel.title");'],
    ["spread after explicit locale key", 'import { translate } from "../i18n/translate.js"; translate(locale, "panel.title", ...values);'],
    ["optional call", 'import { t } from "../i18n/runtime.js"; t?.("panel.title");'],
    ["wrapped call", 'import { t } from "../i18n/runtime.js"; (t)("panel.title");'],
    ["dynamic key", 'import { t } from "../i18n/runtime.js"; t(expression);'],
    ["different explicit locale signature", 'import { translate } from "../i18n/translate.js"; translate(`${ns}.title`, expression);'],
    ["extra arguments", 'import { t } from "../i18n/runtime.js"; t("panel.title", values, fallback);'],
    ["shadowed import", 'import { t as render } from "../i18n/runtime.js"; function invoke(render: Function) { render(expression, "fallback"); }'],
    ["other runtime export", 'import { getLocale } from "../i18n/runtime.js"; getLocale();'],
    ["other translation export", 'import { interpolate } from "../i18n/translate.js"; interpolate("panel.title");'],
    ["named re-export", 'export { t as render } from "../i18n/runtime.js";'],
    ["star re-export", 'export * from "../i18n/runtime.js";'],
    ["local re-export", 'import { t } from "../i18n/runtime.js"; export { t };'],
    ["default re-export", 'import { t } from "../i18n/runtime.js"; export default t;'],
    ["context member call", 'import { useTranslation } from "../i18n/react.js"; useTranslation().t("panel.title");'],
    ["stored context", 'import { useTranslation } from "../i18n/react.js"; const context = useTranslation(); context.t("panel.title");'],
    ["mutable context binding", 'import { useTranslation } from "../i18n/react.js"; let { t } = useTranslation(); t("panel.title");'],
    ["computed context binding", 'import { useTranslation } from "../i18n/react.js"; const { ["t"]: render } = useTranslation(); render("panel.title");'],
    ["default context binding", 'import { useTranslation } from "../i18n/react.js"; const { t = fallback } = useTranslation(); t("panel.title");'],
    ["rest context binding", 'import { useTranslation } from "../i18n/react.js"; const { t, ...rest } = useTranslation(); t("panel.title");'],
    ["extra context binding", 'import { useTranslation } from "../i18n/react.js"; const { t, locale } = useTranslation(); t("panel.title");'],
    ["exported context binding", 'import { useTranslation } from "../i18n/react.js"; export const { t: render } = useTranslation();'],
    ["factory arguments", 'import { useTranslation } from "../i18n/react.js"; const { t } = useTranslation(...values); t("panel.title");'],
    ["escaped context binding", 'import { useTranslation } from "../i18n/react.js"; const { t } = useTranslation(); const render = t; render("panel.title");'],
    ["dynamic namespace import", 'const text = await import("../i18n/runtime.js"); text.t("panel.title");'],
    ["unresolved module identity", 'import { t as render } from "../missing/runtime.js"; render("panel.title");'],
    ["unproven extension rewrite", 'import { t as render } from "../i18n/runtime.mjs"; render("panel.title");'],
    ["opaque package identity", 'import { t as render } from "@app/i18n/runtime"; render("panel.title");'],
    ["opaque evaluator import", 'import { runInThisContext as render } from "node:vm"; render(code);'],
  ])("rejects the unrecognized %s form with a literal sibling present", (_kind, text) => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.ts", text!);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.ts has an unresolved dynamic message consumer; full checks required",
    });
  });

  it("resolves a named import from the importing module's directory", () => {
    const tree = new Map([["src/i18n/literal.ts", 'import { t as render } from "./runtime.js"; render("panel.title");']]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      namespaces: ["panel"], testFiles: [], consumerModules: ["src/i18n/literal.ts"],
    });
  });

  it("allows direct helper calls whose definitions and module identities are proven", () => {
    const tree = new Map([
      ["src/shared/copy.ts", 'export function copy(value: string) { return value; }'],
      ["src/ui/literal.ts", 'import { copy } from "../shared/copy.js"; import { t } from "../i18n/runtime.js"; function label() { return copy(t("panel.title")); } label();'],
    ]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      namespaces: ["panel"], testFiles: [], consumerModules: ["src/ui/literal.ts"],
    });
  });

  it.each([
    'export function View({ Render, id }: { Render: (props: { id: string }) => unknown; id: string }) { return <Render id={id} />; }',
    'export const view = <section />;',
    '@decorate class View {}',
  ])("keeps full checks for invocation syntax without a proven direct call", (source) => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.tsx", source);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.tsx has an unresolved dynamic message consumer; full checks required",
    });
  });

  it("keeps full checks for a fragment with an unparsed custom runtime beside a literal consumer", () => {
    const tree = new Map(fixtureTree);
    tree.set("scripts/catalog-runtime/jsx-runtime.ts", 'import { t } from "../../src/i18n/runtime.js"; export const Fragment = "fragment"; export function jsx() { return t("panel.title"); } export function jsxs() { return t("panel.title"); }');
    tree.set("src/ui/dynamic.tsx", '/** @jsxImportSource ../../scripts/catalog-runtime */\nexport const view = <>fixed</>;');
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.tsx has an unresolved dynamic message consumer; full checks required",
    });
  });

  it.each([
    'export const view = <>fixed</>;',
    'export const view = <></>;',
    'export const view = <><>fixed</></>;',
    'export const view = <section>fixed</section>;',
    'export const view = <Section />;',
    'export function View() { return <>fixed</>; }',
    'export const view = () => (<>fixed</>);',
  ])("keeps full checks for every JSX form beside a literal consumer: %s", (source) => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.tsx", source);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.tsx has an unresolved dynamic message consumer; full checks required",
    });
  });

  it.each([
    '/** @jsxImportSource ../../scripts/catalog-runtime */',
    '/** @jsx customFactory */',
    '/** @jsxFrag CustomFragment */',
    '/** @jsxRuntime automatic */',
    '// @jsxImportSource ../../scripts/catalog-runtime\u2028',
    '\uFEFF/** @jsx customFactory */',
  ])("keeps full checks for a JSX override even without JSX syntax: %s", (pragma) => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.tsx", `${pragma}\nexport const marker = "fixed";`);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.tsx has an unresolved dynamic message consumer; full checks required",
    });
  });

  it("allows a JSX-looking string when the module has no JSX syntax or override", () => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/example.tsx", 'export const example = "<>fixed</>";');
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      namespaces: ["panel"],
      testFiles: ["src/i18n/__tests__/i18n.test.ts", "src/ui/__tests__/panel-copy.test.tsx"],
      consumerModules: ["src/marketplace/language-check.ts", "src/ui/panel-kinds.ts", "src/ui/panel.tsx"],
    });
  });

  it("keeps full checks when a dynamic scope can replace a proven local callable", () => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.cjs", 'function render(key) { return key; } with (scope) { render(dynamicKey); }');
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.cjs has an unresolved dynamic message consumer; full checks required",
    });
  });

  it("proves a context binding through its declared interface and imported function type", () => {
    const tree = new Map([
      ["src/i18n/react.tsx", 'import type { TranslateFn as RenderFn } from "./translate.js"; export interface I18nContextValue { t: RenderFn; } export function useTranslation(): I18nContextValue { throw null; }'],
      ["src/ui/literal.ts", 'import { useTranslation } from "../i18n/react.js"; const { t: render } = useTranslation(); render("panel.title");'],
    ]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      namespaces: ["panel"], testFiles: [], consumerModules: ["src/ui/literal.ts"],
    });
  });

  const scopedAliasConsumer = 'import { useTranslation } from "../i18n/react.js"; ' +
    'export function preview() { const { t: render } = useTranslation(); return render("other.label"); } ' +
    'export function message(ns: string) { return render("en", `${ns}.title`); }';

  it("keeps full checks when an ambient callable differs from an inner proven alias", () => {
    const tree = new Map(fixtureTree);
    tree.set("src/shared/ambient.d.ts", 'declare function render(locale: string, key: string): string;');
    tree.set("src/ui/dynamic.ts", scopedAliasConsumer);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.ts has an unresolved dynamic message consumer; full checks required",
    });
  });

  it("keeps full checks for a proven alias referenced outside its declaring scope", () => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.ts", scopedAliasConsumer);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.ts has an unresolved dynamic message consumer; full checks required",
    });
  });

  it.each([
    ["parameter", 'import { t as render } from "../i18n/runtime.js"; export const other = render("other.label"); export function message(render: (locale: string, key: string) => string, ns: string) { return render("en", `${ns}.title`); }'],
    ["block binding", 'import { t as render } from "../i18n/runtime.js"; export const other = render("other.label"); export function message(ns: string) { const render = (locale: string, key: string) => key; return render("en", `${ns}.title`); }'],
    ["factory", 'import { useTranslation as useText } from "../i18n/react.js"; export function preview() { const { t } = useText(); return t("other.label"); } export function message(useText: () => { t: (locale: string, key: string) => string }, ns: string) { const { t: render } = useText(); return render("en", `${ns}.title`); }'],
    ["ordinary helper", 'function render(value: string) { return value; } export const other = render("other.label"); export function message(render: (locale: string, key: string) => string, ns: string) { return render("en", `${ns}.title`); }'],
  ])("keeps full checks when a %s shadows a proven binding", (_kind, source) => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/dynamic.ts", source!);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.ts has an unresolved dynamic message consumer; full checks required",
    });
  });

  it.each([
    'import { useTranslation } from "../i18n/react.js"; export function label() { const { t: render } = useTranslation(); return render("panel.title"); }',
    'import { useTranslation } from "../i18n/react.js"; const { t: render } = useTranslation(); export function label() { return render("panel.title"); }',
  ])("allows a nested call that resolves to the proven declaration: %s", (source) => {
    const tree = new Map([["src/ui/literal.ts", source]]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      namespaces: ["panel"], testFiles: [], consumerModules: ["src/ui/literal.ts"],
    });
  });

  it("keeps full checks for a canonical barrel's runtime re-exports", () => {
    const tree = new Map(fixtureTree);
    tree.set("src/i18n/index.ts", 'export { t } from "./runtime.js";');
    tree.set("src/ui/dynamic.ts", 'import { t } from "../i18n/index.js"; t("panel.title");');
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree).reason).toBe(
      "src/i18n/index.ts has an unresolved dynamic message consumer; full checks required",
    );
  });

  it.each([
    ["static import", 'import { render } from "../../scripts/catalog-consumer.mjs"; render(expression);'],
    ["dynamic import", 'const text = await import("../../scripts/catalog-consumer.mjs"); text.render(expression);'],
    ["module loader", 'const text = require("../../scripts/catalog-consumer.mjs"); text.render(expression);'],
    ["re-export", 'export { render } from "../../scripts/catalog-consumer.mjs";'],
  ])("keeps full checks when a %s reaches a dependency outside the parsed tree", (_kind, source) => {
    const tree = new Map(fixtureTree);
    tree.set("scripts/catalog-consumer.mjs", 'export { t as render } from "../src/i18n/runtime.js";');
    tree.set("src/ui/dynamic.ts", source!);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/ui/dynamic.ts has an unresolved dynamic message consumer; full checks required",
    });
  });

  it("keeps full checks when a parsed bridge re-exports an unparsed dependency", () => {
    const tree = new Map(fixtureTree);
    tree.set("scripts/catalog-consumer.mjs", 'export { t as render } from "../src/i18n/runtime.js";');
    tree.set("src/shared/catalog-bridge.ts", 'export { render } from "../../scripts/catalog-consumer.mjs";');
    tree.set("src/ui/dynamic.ts", 'import { render } from "../shared/catalog-bridge.js"; render(expression);');
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      reason: "src/shared/catalog-bridge.ts has an unresolved dynamic message consumer; full checks required",
    });
  });

  it.each([
    ["foreign runtime", "src/shared/i18n/runtime.ts", 'export function t(key: string, vars?: unknown) { return key; }'],
    ["changed signature", "src/i18n/runtime.ts", 'export function t(locale: string, key: string, vars?: unknown) { return key; }'],
    ["shifted key position", "src/i18n/runtime.ts", 'export function t(locale: string, key: string) { return key; }'],
    ["non-callable export", "src/i18n/runtime.ts", 'export const t = "panel.title";'],
    ["default export", "src/i18n/runtime.ts", 'export default function t(key: string, vars?: unknown) { return key; }'],
    ["ambient export", "src/i18n/runtime.ts", 'export declare function t(key: string, vars?: unknown): string;'],
    ["unknown context signature", "src/i18n/react.tsx", 'export function useTranslation() { throw null; }'],
    ["different context signature", "src/i18n/react.tsx", 'export function useTranslation(): { t: (locale: string, key: string) => string } { throw null; }'],
    ["ambiguous module", "src/i18n/runtime.tsx", 'export function t(key: string, vars?: unknown) { return key; }'],
  ])("requires a proven module and export signature for %s", (kind, path, source) => {
    const tree = new Map(fixtureTree);
    tree.set(path!, source!);
    if (path === "src/i18n/react.tsx") {
      tree.set("src/ui/dynamic.ts", 'import { useTranslation } from "../i18n/react.js"; const { t: render } = useTranslation(); render("panel.title", expression);');
    } else {
      const specifier = kind === "foreign runtime" ? "../shared/i18n/runtime.js" : "../i18n/runtime.js";
      tree.set("src/ui/dynamic.ts", `import { t as render } from "${specifier}"; render("panel.title");`);
    }
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree).reason).toMatch(/full checks required$/);
  });

  it.each(["src/ui/__tests__/dynamic.test.ts", "test/e2e/dynamic.spec.ts", "src/i18n/dynamic.ts"])(
    "does not ignore unresolved consumers in %s", (path) => {
      const tree = new Map(fixtureTree);
      tree.set(path, 't(`${namespace}.title`);');
      expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree).reason).toBe(
        `${path} has an unresolved dynamic message consumer; full checks required`,
      );
    },
  );

  it("decodes literal key escapes and excludes t() text inside comments and strings", () => {
    const tree = new Map([
      ["src/ui/panel.ts", String.raw`import { t } from "../i18n/runtime.js"; const label = t("\u0070anel.title"); // t(dynamic)`],
      ["src/ui/example.ts", 'const example = "t(dynamic)";'],
    ]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree)).toEqual({
      namespaces: ["panel"], testFiles: [], consumerModules: ["src/ui/panel.ts"],
    });
  });

  it("keeps full checks for unreadable or unparseable consumers", () => {
    const tree = new Map(fixtureTree);
    tree.set("src/ui/invalid.ts", 't("panel.title"');
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), tree).reason).toBe(
      "src/ui/invalid.ts could not be parsed for message consumers; full checks required",
    );
  });

  it("compares values by their locale bindings, including decoded escapes", () => {
    expect(readMessageCatalogEntries(fragment("Panel"), `${MESSAGES}/generated/panel.ts`)?.get("panel.title"))
      .toEqual({ en: "Panel", ko: "패널" });
    expect(readMessageCatalogEntries(fragment("Panel"))?.get("panel.title")).toEqual({ en: "Panel", ko: "패널" });
    const before = fragment("Panel");
    const after = before.replace('"Panel"', String.raw`"\u0050anel"`);
    expect(after).not.toBe(before);
    expect(selectFixture(before, after)).toEqual({
      reason: `${MESSAGES}/generated/panel.ts has changes outside attributable message values; full checks required`,
    });
    const changed = after.replace(String.raw`\u0050anel`, String.raw`\u0050anel heading`);
    expect(selectFixture(before, changed).namespaces).toEqual(["panel"]);
  });

  it("keeps full checks when the real fragment's locale bindings are swapped", () => {
    const before = readFileSync(resolve(root, MESSAGES, "generated/be_hookRunner.ts"), "utf8");
    const after = before.replace("const en =", "const ko =").replace("const ko:", "const en:");
    expect(after).not.toBe(before);
    expect(selectFixture(before, after)).toEqual({
      reason: `${MESSAGES}/generated/panel.ts has a shape the message key reader does not accept; full checks required`,
    });
  });

  it.each(["\u2028", "\u2029", "\r"])("handles a line comment terminated by %j conservatively", (terminator) => {
    const before = fragment("Panel").replace('"panel.title": "Panel",', `// comment${terminator}"panel.title": "Panel",`);
    const after = before.replace('"Panel"', '"Panel heading"');
    const selection = selectFixture(before, after);
    if (terminator === "\r") expect(selection.namespaces).toEqual(["panel"]);
    else expect(selection.reason).toBe(`${MESSAGES}/generated/panel.ts has a shape the message key reader does not accept; full checks required`);
  });

  it.each([
    (text: string) => `${text}en["panel.title"] = "replacement";`,
    (text: string) => `${text}export { en as extra };`,
    (text: string) => text.replace("export const en", "export let en"),
    (text: string) => text.replace("keyof typeof en", "keyof typeof other"),
    (text: string) => text.replace('"panel.title": "패널",', ""),
    (text: string) => text.replace('"panel.title": "Panel",', '"panel.title": "Panel", "panel.title": "duplicate",'),
  ])("validates the whole fragment before selecting checks", (change) => {
    expect(selectFixture(fragment("Panel"), change(fragment("Panel"))).reason).toBe(
      `${MESSAGES}/generated/panel.ts has a shape the message key reader does not accept; full checks required`,
    );
  });

  it("keeps full checks on the real tree when any dynamic consumer remains unresolved", () => {
    const path = `${MESSAGES}/generated/shellExecution.ts`;
    const after = readFileSync(resolve(root, path), "utf8");
    const before = after.replace(/("shellExecution\.cwd": ")[^"]*"/, '$1old"');
    const selection = selectMessageCatalogChecks([{ ...modified(path), baseSha: "base", localSha: "local" }], {
      readBlob: (sha) => sha === "base" ? before : after, trackedFiles: tracked, readTrackedFile: readTracked,
    });
    expect(selection.reason).toMatch(/unresolved dynamic message consumer; full checks required$/);
    expect(selection.testFiles).toBeUndefined();
    expect(selection.consumerModules).toBeUndefined();
    // Parse tracked modules through the same compiler service used by the hook.
  }, 30_000);

  it("keeps a shell execution wording change on full checks when its approval surface uses dynamic keys", () => {
    const path = `${MESSAGES}/generated/shellExecution.ts`;
    const after = readFileSync(resolve(root, path), "utf8");
    const before = after.replace(/("shellExecution\.cwd": ")[^"]*"/, '$1old"');
    expect(before).not.toBe(after);
    const selection = selectMessageCatalogChecks([{ ...modified(path), baseSha: "base", localSha: "local" }], {
      readBlob: (sha) => (sha === "base" ? before : after),
      trackedFiles: [
        "src/shared/shell-execution-environment.ts",
        "src/ui/renderer/components/ToolApprovalContent.tsx",
        "src/ui/renderer/components/__tests__/ToolApprovalContent-host-execution.test.tsx",
        "src/i18n/__tests__/used-keys-exist.test.ts",
      ],
      readTrackedFile: readTracked,
    });
    expect(selection.reason).toMatch(/unresolved dynamic message consumer; full checks required$/);
  });
});

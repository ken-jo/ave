/**
 * A branch push of an ordinary source change ran the whole suite and the
 * build (`bun run test` + `bun run build`), the same work CI and the merge
 * gate repeat on the merged tree. The fast tier scopes the push to the
 * change: typecheck gate, duplicate helpers, lock suites, changed tests and
 * the tests `vitest related` finds. Inputs the import graph cannot show keep
 * the full checks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AVE_APP_LOCK_SUITE_TRIGGERS,
  boundRelatedTests,
  FULL_CHECK_GLOBAL_INPUT_FILES,
  isFullCheckGlobalInput,
  AVE_APP_LOCK_SUITES,
  RELATED_TEST_BOUND,
  selectFastSourceChecks,
  selectTriggeredLockSuites,
} from "../../scripts/hooks/pre-push-source-policy.mjs";

const root = resolve(import.meta.dirname, "../..");

function modified(path: string) {
  return { status: "M", oldMode: "100644", newMode: "100644", path };
}
function added(path: string) {
  return { status: "A", oldMode: "000000", newMode: "100644", path };
}
function deleted(path: string) {
  return { status: "D", oldMode: "100644", newMode: "000000", path };
}

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
    // Unconsumed documentation alone is the docs-only tier's, not this one's.
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
    "src/i18n/messages/generated/statusBar.ts",
    "src/i18n/messages/generated-locales/ko.ts",
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
    expect(hook).toContain("[checks] tier=fast pre-push");
    expect(hook).toContain("[checks] tier=full ${stage}");
    expect(hook).not.toContain('"--passWithNoTests"');
    expect(hook).toContain('"--reporter=json"');
    expect(hook.indexOf("getFastSourceRelatedSelection(repoRoot,")).toBeGreaterThanOrEqual(0);
    expect(hook.indexOf("getFastSourceRelatedSelection(repoRoot,")).toBeLessThan(hook.indexOf("[checks] tier=fast pre-push"));
    expect(hook).toContain('"run", ...directArgs], dir, withoutGitContext()');
    // The skip switch is the shell hook's and keeps its meaning.
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
    expect(selectFastSourceChecks([modified("docs/ko/app-readme.md")]).testFiles).toEqual([
      "src/plugins/__tests__/registry-atomicity.test.ts",
      "test/scripts/repository-identity.test.ts",
    ]);
    // Without a recorded reader set the change keeps the full checks.
    expect(selectFastSourceChecks([modified("web/NOT-RECORDED.md")])).toMatchObject({
      eligible: false,
      reason: "web/NOT-RECORDED.md is documentation that tests or the build read, with no recorded reader set",
    });
    expect(selectFastSourceChecks([deleted("web/DEPLOY.md")]).eligible).toBe(false);
  });

  it("pins the lock-suite trigger table", () => {
    // A change to this table changes which cross-cutting suites a fast push
    // skips. Each trigger is a path the suite scans or reads, or a module it pins.
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
    // Every trigger names something that exists.
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
    // Under the bound nothing is narrowed.
    expect(boundRelatedTests([{ source: "src/a.ts", tests: fanOut.slice(0, 30) }], read)).toEqual({
      tests: [...fanOut.slice(0, 30)].sort(), narrowed: [],
    });
    // A fan-out module with no direct importer is not silently dropped.
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
    // The PR #43 review case: 255 related tests, 21 direct importers, and the
    // IPC and preload lock suites reach the module only through
    // src/contract/app-contract.ts. They must survive both ways.
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
    // Derived from the import graphs rather than listed by hand: a suite that
    // reaches src/contract/app-contract.ts reaches its imports only through it.
    const barrel = "src/contract/app-contract.ts";
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|vi\.mock\(\s*)["'](\.[^"']+)["']/g;
    const resolveModule = (from: string, spec: string) => {
      const base = normalize(join(dirname(from), spec)).replace(/\.(?:js|mjs)$/, "");
      return [".ts", ".tsx", ".mts", "/index.ts"].map((ext) => base + ext).find((path) => existsSync(resolve(root, path))) ?? null;
    };
    // Comments are stripped first: a JSDoc `{@link import("./x.js")}` is not an import.
    const imports = (file: string) => [...readFileSync(resolve(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").matchAll(specifier)]
      .map((match) => resolveModule(file, match[1]!))
      .filter((path): path is string => path !== null && path.startsWith("src/"));
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

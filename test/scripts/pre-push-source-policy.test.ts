/**
 * A branch push of an ordinary source change ran the whole suite and the
 * build (`bun run test` + `bun run build`), the same work CI and the merge
 * gate repeat on the merged tree. The fast tier scopes the push to the
 * change: typecheck gate, duplicate helpers, lock suites, changed tests and
 * the tests `vitest related` finds. Inputs the import graph cannot show keep
 * the full checks.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FULL_CHECK_GLOBAL_INPUT_FILES,
  isFullCheckGlobalInput,
  AVE_APP_LOCK_SUITES,
  selectFastSourceChecks,
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
      reason: "AGENTS.md is documentation that tests or the build read",
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
    expect(hook.indexOf("getFastSourceCoverageReason(repoRoot,")).toBeGreaterThanOrEqual(0);
    expect(hook.indexOf("getFastSourceCoverageReason(repoRoot,")).toBeLessThan(hook.indexOf("[checks] tier=fast pre-push"));
    expect(hook).toContain('"run", ...directArgs], dir, withoutGitContext()');
    // The skip switch is the shell hook's and keeps its meaning.
    const shellHook = readFileSync(resolve(root, "scripts/hooks/pre-push"), "utf8");
    expect(shellHook).toContain('if [ "${AVE_HOOKS_SKIP:-}" = "1" ] || [ "${SKIP_AVE_HOOKS:-}" = "1" ]; then');
  });
});

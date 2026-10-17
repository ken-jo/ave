/**
 * Pull-request CI runs the affected Vitest tests, and the full suite whenever
 * that selection cannot be trusted (scripts/run-ci-suite.mjs). These cases pin
 * the selection against the real import graph of this tree: a leaf module
 * selects its own tests, a shared module selects the tests of the modules
 * that import it, and a global input falls back to the full suite.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AFFECTED_TEST_LIMIT,
  expandMustRunTests,
  loadsComputedImport,
  MUST_RUN_TESTS_PATH,
  namedRepositoryPaths,
  namesChangedPath,
  planCiSuite,
  selectCiTests,
} from "../../scripts/run-ci-suite.mjs";
import { parseGitRawDiff } from "../../scripts/hooks/pre-push-ref-updates.mjs";
import { isCollectedVitestFile } from "../../scripts/hooks/pre-push-source-policy.mjs";
import { modifiedEntry as modified } from "../../src/__tests__/support/git-diff-entry.js";

const root = resolve(import.meta.dirname, "../..");

const trackedTests = spawnSync("git", ["ls-files", "-z", "--", "src", "test"], { cwd: root, encoding: "utf8" })
  .stdout.split("\0")
  .filter((path) => path && isCollectedVitestFile(path))
  .sort();
const mustRunDocument: unknown = JSON.parse(readFileSync(join(root, MUST_RUN_TESTS_PATH), "utf8"));
const mustRunTests = expandMustRunTests(mustRunDocument, trackedTests);

function readText(path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

/** Per-module `vitest related` discovery over this tree, as CI runs it. */
function discoverRelated(paths: string[]): { source: string; tests: string[] }[] | null {
  const result = spawnSync(process.execPath, [join(root, "scripts/hooks/pre-push-related-tests.mjs"), ...paths], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout) as { source: string; tests: string[] }[];
}


function select(changes: ReturnType<typeof modified>[], discover = discoverRelated) {
  return selectCiTests({ changes, trackedTests, mustRunTests, readText, discoverRelated: discover });
}

describe("CI test selection over the real import graph", () => {
  it("selects a leaf module's own tests, plus the must-run set", () => {
    const plan = select([modified("src/core/route-engine.ts")]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain("src/core/__tests__/route-engine.test.ts");
    expect(plan.tests).toEqual(expect.arrayContaining(mustRunTests));
    // A leaf change does not drag in the rest of the suite.
    expect(plan.tests.length).toBeLessThan(trackedTests.length / 2);
  }, 120_000);

  it("selects the tests of a shared module's consumers, not only its direct importers", () => {
    const consumerTest = "src/main/__tests__/link-window-service.test.ts";
    // The consumer's test reaches escape-html only through link-window-service.
    expect(readText(consumerTest)).not.toContain("escape-html");
    expect(readText("src/main/link-window-service.ts")).toContain('from "../shared/escape-html.js"');

    const plan = select([modified("src/shared/escape-html.ts")]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain("src/shared/__tests__/escape-html.test.ts");
    expect(plan.tests).toContain(consumerTest);
  }, 120_000);

  it("selects a test that reads a changed module as text, which the import graph does not show", () => {
    // module-size-boundaries.test.ts reads each module it bounds with fs; on
    // 2026-08-07 a guard block pushed src/plugins/runtime/index.ts past its
    // ceiling and only that test failed.
    const reader = "src/__tests__/module-size-boundaries.test.ts";
    expect(readText(reader)).toContain('"src/plugins/runtime/index.ts"');
    const related = discoverRelated(["src/plugins/runtime/index.ts"]);
    expect(related?.[0]?.tests).not.toContain(reader);

    const plan = select([modified("src/plugins/runtime/index.ts")]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain(reader);
  }, 120_000);

  it.each([
    "vitest.config.ts",
    "config/vitest.analysis.config.ts",
    MUST_RUN_TESTS_PATH,
    "package.json",
    "bun.lock",
    "tsconfig.json",
    ".github/workflows/ci.yml",
    "scripts/run-ci-suite.mjs",
    "src/__tests__/vitest-ave-home.ts",
    "src/i18n/testing/vitest-ambient-intl.ts",
    "src/preload.ts",
  ])("falls back to the full suite when %s changes", (path) => {
    const plan = select([modified("src/core/route-engine.ts"), modified(path)], () => {
      throw new Error("a global input must be decided before any discovery");
    });
    expect(plan).toEqual({ mode: "full", reason: `${path} is a global test or build input`, tests: [] });
  });
});

describe("CI test selection fallbacks", () => {
  const noDiscovery = () => {
    throw new Error("discovery must not run for this change");
  };

  it("runs the full suite for message catalog data", () => {
    expect(select([modified("src/i18n/messages/generated/chat.ts")], noDiscovery))
      .toMatchObject({ mode: "full", reason: "src/i18n/messages/generated/chat.ts is message catalog data" });
  });

  it("runs the full suite when a changed module computes what it imports", () => {
    expect(select([modified("src/plugins/runtime/plugin-loader.ts")], noDiscovery))
      .toMatchObject({ mode: "full", reason: "src/plugins/runtime/plugin-loader.ts loads code through a computed import" });
  });

  it("runs the full suite for a deleted or renamed module", () => {
    expect(select([{ status: "D", oldMode: "100644", newMode: "000000", path: "src/core/route-engine.ts" }], noDiscovery).mode)
      .toBe("full");
  });

  it("runs the full suite when discovery fails or a module has no test", () => {
    expect(select([modified("src/core/route-engine.ts")], () => null))
      .toMatchObject({ mode: "full", reason: "related test discovery failed" });
    expect(select([modified("src/core/route-engine.ts")], (paths) => paths.map((source) => ({ source, tests: [] }))))
      .toMatchObject({ mode: "full", reason: "src/core/route-engine.ts has no related test files" });
  });

  it("runs the full suite when the selection is most of the suite", () => {
    const wide = trackedTests.slice(0, AFFECTED_TEST_LIMIT + 1);
    expect(select([modified("src/core/route-engine.ts")], (paths) => paths.map((source) => ({ source, tests: wide }))))
      .toMatchObject({ mode: "full", reason: expect.stringMatching(new RegExp(`^\\d+ changed and related test files exceed ${AFFECTED_TEST_LIMIT}$`)) });
  });

  it("runs a changed test file directly, with the lock suites its path triggers", () => {
    const plan = select([modified("src/ipc/__tests__/gated.test.ts"), modified("src/ui/renderer/types.ts")],
      (paths) => paths.map((source) => ({ source, tests: ["src/__tests__/preload.test.ts"] })));
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual(expect.arrayContaining([
      "src/ipc/__tests__/gated.test.ts",
      "src/__tests__/preload.test.ts",
      "src/__tests__/preload-shape.test.ts",
    ]));
  });

  it("runs the full suite on every event but a pull request, and refuses a missing event", () => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      expect(planCiSuite(event)).toEqual({ mode: "full", reason: `${event} runs the full suite`, tests: [] });
    }
    expect(() => planCiSuite(undefined)).toThrow("GITHUB_EVENT_NAME is unset");
  });
});

describe("the must-run set", () => {
  it("names security, permissions, sandbox, contract, IPC and naming tests that all exist", () => {
    expect(Object.keys((mustRunDocument as { groups: object }).groups).sort())
      .toEqual(["contract", "ipc", "naming", "permissions", "sandbox", "security"]);
    expect(mustRunTests).toContain("src/permissions/__tests__/runner-decisions.test.ts");
    expect(mustRunTests).toContain("src/ipc/__tests__/channel-inventory.test.ts");
    expect(mustRunTests).toContain("src/plugins/__tests__/tool-name-policy.test.ts");
  });

  it("refuses an entry that selects nothing", () => {
    expect(() => expandMustRunTests({ groups: { stale: ["src/gone/__tests__/gone.test.ts"] } }, trackedTests))
      .toThrow("entry src/gone/__tests__/gone.test.ts selects no collected test file");
    expect(() => expandMustRunTests({ groups: { empty: [] } }, trackedTests)).toThrow("must list at least one path");
    expect(() => expandMustRunTests({}, trackedTests)).toThrow('must hold a "groups" object');
  });
});

describe("computed-import detection", () => {
  it.each([
    ["await import(entryUrl)", true],
    ["require(modulePath)", true],
    ["import.meta.glob('./x/*.ts')", true],
    ["await import(`./locales/${lang}.js`)", true],
    ['await import("./literal.js")', false],
    ["await import('./literal.js')", false],
    ['import(/* webpackChunkName: "x" */ "./x.js")', false],
    ["await import(`./literal.js`)", false],
    ['const x = require("node:fs")', false],
    ['import { a } from "./a.js"', false],
    ["vi.importActual<typeof m>(\"./m.js\")", false],
  ])("%s -> %s", (text, expected) => {
    expect(loadsComputedImport(text)).toBe(expected);
  });
});

describe("paths a test names", () => {
  it("collects repository-rooted and test-relative literals", () => {
    const text = [
      'readFileSync("src/plugins/runtime/index.ts")',
      "scan('src/ui/renderer/')",
      'resolve(__dirname, "../fixtures/case.json")',
      "const dynamic = `src/${name}.ts`;",
      'walk(join(repoRoot, "test"))',
      'const fixtureHome = join(home, "src");',
    ].join("\n");
    expect(namedRepositoryPaths("src/a/__tests__/x.test.ts", text).sort()).toEqual([
      "src/a/fixtures/case.json",
      "src/plugins/runtime/index.ts",
      "src/ui/renderer/",
      "test/",
    ]);
  });

  it("matches the file, the same module under another extension, or a directory holding it", () => {
    expect(namesChangedPath("src/a/b.ts", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/a/b.js", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/a", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/a/", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/ab", "src/a/b.ts")).toBe(false);
    expect(namesChangedPath("src/a/b.ts", "src/a/bc.ts")).toBe(false);
  });
});

describe("raw diff parsing shared with the pre-push hook", () => {
  it("parses entries and refuses a truncated record", () => {
    const record = ":100644 100644 aaaa bbbb M\0src/a.ts\0:000000 100644 0000 cccc A\0src/b.ts\0";
    expect(parseGitRawDiff(record)).toEqual([
      { oldMode: "100644", newMode: "100644", status: "M", path: "src/a.ts" },
      { oldMode: "000000", newMode: "100644", status: "A", path: "src/b.ts" },
    ]);
    expect(parseGitRawDiff(":100644 100644 aaaa bbbb M\0")).toBeNull();
    expect(parseGitRawDiff("not a diff\0")).toBeNull();
  });
});

/**
 * A branch push of an ordinary source change ran the whole suite and the
 * build (`bun run test` + `bun run build`), the same work CI and the merge
 * gate repeat on the merged tree. The fast tier scopes the push to the
 * change: typecheck gate, duplicate helpers, lock suites, changed tests and
 * the tests `vitest related` finds. Inputs the import graph cannot show keep
 * the full checks.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AVE_APP_LOCK_SUITE_TRIGGERS,
  boundRelatedTests,
  FULL_CHECK_GLOBAL_INPUT_FILES,
  isFullCheckGlobalInput,
  isMessageCatalogPath,
  AVE_APP_LOCK_SUITES,
  readMessageCatalogEntries,
  RELATED_TEST_BOUND,
  selectFastSourceChecks,
  selectMessageCatalogChecks,
  selectTriggeredLockSuites,
} from "../../scripts/hooks/pre-push-source-policy.mjs";
import { messages } from "../../src/i18n/messages/index.js";

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

/**
 * Message catalog changes used to be global inputs: every test reaches the
 * catalog through t(), so `vitest related` on a fragment returns most of the
 * suite and nearly every UI change took the full tier. They are selected by
 * key instead: the modules and tests that name a changed key's namespace.
 */
describe("pre-push message catalog selection", () => {
  const MESSAGES = "src/i18n/messages";
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "src", "test"], { encoding: "utf8" })
    .split("\0").filter(Boolean);
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
    // Removing a fragment leaves keys behind that the new tree cannot show.
    expect(selectFastSourceChecks([deleted(`${MESSAGES}/generated/shellExecution.ts`)]).eligible).toBe(false);
    expect(selectFastSourceChecks([{ ...modified(`${MESSAGES}/en.ts`), newMode: "100755" }]).eligible).toBe(false);
  });

  it("reads every key of the real catalog, and nothing the runtime does not load", () => {
    const keys = new Set<string>();
    for (const path of catalogFiles()) {
      const entries = readMessageCatalogEntries(readFileSync(resolve(root, path), "utf8"), path);
      expect(entries, path).not.toBeNull();
      for (const key of entries!.keys()) keys.add(key);
    }
    expect([...keys].sort()).toEqual(Object.keys(messages.en).sort());
    // The barrels carry no keys; the barrel check proves they match the fragments.
    expect(readMessageCatalogEntries(readFileSync(resolve(root, MESSAGES, "generated/index.ts"), "utf8"))).toBeNull();
  }, 30_000);

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
  const fixtureTree = new Map<string, string>([
    ["src/ui/panel.tsx", 'export const title = () => t("panel.title");'],
    ["src/ui/panel-kinds.ts", 'export const keys = { title: "panel.title" } as const;'],
    ["src/ui/other.tsx", 'export const label = () => t("other.label");'],
    ["src/marketplace/language-check.ts", 'import { messages } from "../i18n/messages/index.js";'],
    ["src/ui/__tests__/panel-copy.test.tsx", 'expect(t("panel.title")).toBe("패널");'],
    ["src/ui/__tests__/other.test.tsx", 'expect(t("other.label")).toBe("기타");'],
    ["src/i18n/__tests__/i18n.test.ts", "it(\"loads\", () => {});"],
    ["src/i18n/translate.ts", 'import { messages } from "./messages/index.js";'],
    ["test/e2e/panel.spec.ts", 'page.getByText(t("panel.title"));'],
    ["docs/panel.md", '"panel.title"'],
  ]);
  const selectFixture = (before: string | null, after: string, tree = fixtureTree) =>
    selectMessageCatalogChecks(
      [{ ...(before === null ? added : modified)(`${MESSAGES}/generated/panel.ts`), baseSha: "base", localSha: "local" }],
      {
        readBlob: (sha, path) => (path === `${MESSAGES}/generated/panel.ts` ? (sha === "base" ? before : after) : null),
        trackedFiles: [...tree.keys()],
        readTrackedFile: (path) => tree.get(path) ?? null,
      },
    );

  it("selects the modules and tests that name a changed namespace, the catalog readers and the i18n suites", () => {
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"))).toEqual({
      namespaces: ["panel"],
      testFiles: ["src/i18n/__tests__/i18n.test.ts", "src/ui/__tests__/panel-copy.test.tsx"],
      consumerModules: ["src/marketplace/language-check.ts", "src/ui/panel-kinds.ts", "src/ui/panel.tsx"],
    });
    // A translation-only change selects the same way.
    expect(selectFixture(fragment("Panel"), fragment("Panel").replace('"패널"', '"패널 제목"')).namespaces).toEqual(["panel"]);
    // An added fragment changes every key it declares.
    expect(selectFixture(null, fragment("Panel")).namespaces).toEqual(["other", "panel"]);
    // Nothing changed but formatting: only the catalog readers and suites.
    expect(selectFixture(fragment("Panel"), `// reflowed\n${fragment("Panel")}`)).toEqual({
      namespaces: [],
      testFiles: ["src/i18n/__tests__/i18n.test.ts"],
      consumerModules: ["src/marketplace/language-check.ts"],
    });
  });

  it("keeps the full checks when a changed namespace has no literal consumer or a consumer is a global input", () => {
    const unnamed = new Map([...fixtureTree].filter(([path]) => !["src/ui/panel.tsx", "src/ui/panel-kinds.ts",
      "src/ui/__tests__/panel-copy.test.tsx", "test/e2e/panel.spec.ts"].includes(path)));
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), unnamed)).toEqual({
      reason: "no source file names message namespace panel; a computed key may reach it, full checks required",
    });
    const preload = new Map([...fixtureTree, ["src/panel-preload.ts", 'const title = t("panel.title");']]);
    expect(selectFixture(fragment("Panel"), fragment("Panel heading"), preload)).toEqual({
      reason: "src/panel-preload.ts names a changed message namespace and is a global test or build input",
    });
    expect(selectFixture("export const en = { ...base };", fragment("Panel heading"))).toEqual({
      reason: `${MESSAGES}/generated/panel.ts has a shape the message key reader does not accept; full checks required`,
    });
  });

  // These inputs and expected decisions are specified independently of both
  // the catalog reader and the consumer scanner. A literal sibling must never
  // turn unresolved coverage into a fast selection.
  it.each([
    'export const title = (ns: string) => t(`${ns}.title`);',
    'export const title = (kind: string) => t(`panel.${kind}`);',
    'export const title = (key: string) => t(key);',
    'export const title = (key: string) => t?.(key);',
    'export const title = (key: string) => i18n.t(key);',
    'export const title = (key: string) => i18n["t"](key);',
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
      ["src/ui/panel.ts", String.raw`const label = t("\u0070anel.title"); // t(dynamic)`],
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
    expect(selectFixture(before, after).namespaces).toEqual([]);
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
    expect(selection).toEqual({
      reason: "src/ui/renderer/components/ToolApprovalContent.tsx has an unresolved dynamic message consumer; full checks required",
    });
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { classifyDocumentationChanges, isCanonicalGitPath } from "../../scripts/hooks/pre-push-markdown-policy.mjs";
import { isIntegrationBranchRef, parseGitRawDiff } from "../../scripts/hooks/pre-push-ref-updates.mjs";
import {
  selectFastSourceChecks,
  selectMessageCatalogChecks,
  selectTriggeredLockSuites,
} from "../../scripts/hooks/pre-push-source-policy.mjs";
import { selectTargetedAveAppVitestFiles } from "../../scripts/hooks/pre-push-test-policy.mjs";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";
// Git writes loose objects read-only, and Electron's synchronous recursive removal
// refuses read-only files on Windows; the async removal clears the attribute.
import { cleanupTmpDir } from "../../src/__tests__/support/tmp-dir-teardown.js";

const source = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
const start = source.indexOf("function classifyPrePushChanges(");
const end = source.indexOf("// Staged safety scan", start);
const baseSha = "a".repeat(40);
const localSha = "b".repeat(40);
const update = { localRef: "refs/heads/topic", remoteRef: "refs/heads/topic", localSha, remoteSha: baseSha };
const modified = (path: string) => ({ path, status: "M", oldMode: "100644", newMode: "100644" });
interface ClassificationOptions {
  update?: Partial<typeof update>;
  fastForward?: boolean;
  commentOnly?: boolean;
  historyReason?: string;
  messageCatalog?: { reason?: string; namespaces?: string[]; testFiles?: string[]; consumerModules?: string[] };
}

// Execute the classifier's actual function with controlled Git and blob reads.
// This exercises precedence without launching the checks the classifier selects.
function classify(entries: ReturnType<typeof modified>[], options: ClassificationOptions = {}) {
  const classifyChanges = runInNewContext(`${source.slice(start, end)}; classifyPrePushChanges`, {
    isNullObjectId: (sha: string) => /^0+$/.test(sha),
    getProtectedBranchNames: () => new Set(["main", "master"]),
    findNewBranchBase: () => ({ sha: baseSha }),
    isIntegrationBranchRef,
    selectTriggeredLockSuites,
    isFastForwardUpdate: () => options.fastForward !== false,
    getChangedEntries: () => entries,
    getPushedHistoryFullReason: () => options.historyReason ?? null,
    isCanonicalGitPath,
    classifyDocumentationChanges,
    selectFastSourceChecks,
    selectTargetedAveAppVitestFiles,
    selectCommentOnlyAveAppFiles: () => ({ eligible: options.commentOnly === true, files: [] }),
    getGitBlob: () => "",
    getMessageCatalogSelection: (_root: string, entries: { path: string }[]) =>
      options.messageCatalog ?? { reason: `unexpected catalog selection for ${entries.map(({ path }) => path).join(", ")}` },
  });
  return classifyChanges("/fixture", { complete: true, updates: [{ ...update, ...options.update }] }, "origin", "/remote");
}

describe("pre-push classification precedence", () => {
  it.each([
    { update: { remoteRef: "refs/tags/example" } },
    { fastForward: false },
  ])("keeps full checks ahead of unconsumed documentation for %j", (options) => {
    expect(classify([modified("docs/notes/example.md")], options).docsOnly).toBe(false);
  });

  it.each([
    { remoteSha: baseSha },
    { remoteSha: "0".repeat(40) },
  ])("keeps a direct push to an integration branch on the full checks (%j)", (options) => {
    const result = classify([modified("src/lib/example.ts")], {
      update: { remoteRef: "refs/heads/integration/permissions", ...options },
    });
    expect(result.fastSource).not.toBe(true);
    expect(result.reason).toBe("push to integration branch refs/heads/integration/permissions requires full checks");
  });

  it("checks nothing for a new branch whose commit the remote already contains", () => {
    const result = classify([], {
      update: { localRef: "refs/heads/feat/start", remoteRef: "refs/heads/feat/start", localSha: baseSha, remoteSha: "0".repeat(40) },
    });
    expect(result).toMatchObject({
      alreadyOnRemote: true,
      reason: "every pushed commit is already on a default or integration branch of the remote",
    });
  });

  it("takes a sub-branch pushed beside an integration branch on the fast tier", () => {
    const result = classify([modified("src/ipc/domains/example.ts")], {
      update: { localRef: "refs/heads/feat/judge-slot", remoteRef: "refs/heads/feat/judge-slot", remoteSha: "0".repeat(40) },
    });
    expect(result).toMatchObject({ fastSource: true, relatedFiles: ["src/ipc/domains/example.ts"] });
    expect(result.lockSuites.map(({ suite }: { suite: string }) => suite)).toEqual([
      "src/ipc/__tests__/channel-inventory.test.ts",
      "src/ipc/__tests__/domain-exports.test.ts",
      "src/ipc/__tests__/host-renderer-only-channels.test.ts",
      "src/ui/renderer/__tests__/format-ipc-error-coverage.test.ts",
    ]);
  });

  it("does not let a global source input take the comment-only tier", () => {
    const result = classify([modified("src/__tests__/vitest-ave-home.ts")], { commentOnly: true });
    expect(result.commentOnly).not.toBe(true);
    expect(result.fastSource).not.toBe(true);
  });

  it.each([
    "src/i18n/messages/en.ts",
    "src/i18n/messages/ko.ts",
    "src/i18n/messages/generated/panel.ts",
    "src/i18n/messages/generated/index.ts",
    "src/i18n/messages/generated-locales/ko.ts",
  ])("keeps catalog attribution ahead of the comment-only tier: %s", (path) => {
    expect(classify([modified(path)], {
      commentOnly: true,
      messageCatalog: { reason: "catalog edit requires full checks" },
    })).toEqual({ docsOnly: false, reason: "catalog edit requires full checks" });
  });

  it("does not let a mode change take the test-only tier", () => {
    const result = classify([{ ...modified("test/example.test.ts"), oldMode: "100755" }]);
    expect(result.testOnly).not.toBe(true);
    expect(result.fastSource).not.toBe(true);
  });

  it("keeps changed tests in a mixed source push", () => {
    expect(classify([modified("src/lib/example.ts"), modified("test/example.test.ts")])).toMatchObject({
      fastSource: true,
      relatedFiles: ["src/lib/example.ts"],
      testFiles: ["test/example.test.ts"],
    });
  });

  it.each(["src/lib/example.ts", "test/example.test.ts"])("requires full checks when only %s is deleted", (path) => {
    const result = classify([{ path, status: "D", oldMode: "100644", newMode: "000000" }]);
    expect(result.testOnly).not.toBe(true);
    expect(result.fastSource).not.toBe(true);
  });

  it("runs the destination of a renamed test instead of silently losing it", () => {
    const result = classify([
      { path: "test/old-name.test.ts", status: "D", oldMode: "100644", newMode: "000000" },
      { path: "test/new-name.test.ts", status: "A", oldMode: "000000", newMode: "100644" },
    ]);
    expect(result).toMatchObject({ fastSource: true, testFiles: ["test/new-name.test.ts"] });
  });

  it.each(["config/vitest.analysis.config.ts", "src/__tests__/vitest-ave-home.ts", "tsconfig.tests.json", "package.json"])(
    "keeps a sole global change on full checks: %s", (path) => {
      const result = classify([modified(path)], { commentOnly: true });
      expect(result.commentOnly).not.toBe(true);
      expect(result.testOnly).not.toBe(true);
      expect(result.fastSource).not.toBe(true);
    },
  );

  it("honors a full-tier input in an earlier pushed commit even after it was reverted", () => {
    const result = classify([modified("src/lib/example.ts")], { historyReason: "package.json changed in pushed history" });
    expect(result.fastSource).not.toBe(true);
    expect(result.reason).toContain("pushed history");
  });

  it("reads the global input from real pushed history when the final diff contains only source", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pre-push-history-"));
    const env = gitFixtureEnv(repo);
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
    try {
      git(["init", "-q"]);
      git(["config", "user.name", "Fixture"]);
      git(["config", "user.email", "fixture@example.invalid"]);
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "package.json"), "{}\n");
      writeFileSync(join(repo, "src/example.ts"), "export const value = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "initial fixture"]);
      const base = git(["rev-parse", "HEAD"]);
      writeFileSync(join(repo, "package.json"), '{"scripts":{}}\n');
      git(["commit", "-qam", "change compiler input"]);
      writeFileSync(join(repo, "package.json"), "{}\n");
      writeFileSync(join(repo, "src/example.ts"), "export const value = 2;\n");
      git(["commit", "-qam", "restore input and change source"]);
      expect(git(["diff", "--name-only", base, "HEAD"])).toBe("src/example.ts");
      const historyStart = source.indexOf("function decodeUtf8Strict(");
      const historyEnd = source.indexOf("function classifyPrePushChanges(");
      const historyReason = runInNewContext(`${source.slice(historyStart, historyEnd)}; getPushedHistoryFullReason`, {
        commands: { git: "git" }, TextDecoder, Buffer, classifyDocumentationChanges, selectFastSourceChecks, parseGitRawDiff,
        spawnSync: (command: string, args: string[], options: object) => spawnSync(command, args, { ...options, env }),
        captureOptional: (_command: string, args: string[]) => git(args),
      });
      expect(historyReason(repo, base, git(["rev-parse", "HEAD"]))).toContain("package.json is a global test or build input in pushed history");
    } finally {
      await cleanupTmpDir(repo);
    }
  });

  it("retains a merged main input even when a later commit removes it from the pushed net diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pre-push-main-merge-"));
    const env = gitFixtureEnv(repo);
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
    try {
      git(["init", "-qb", "main"]);
      git(["config", "user.name", "Fixture"]);
      git(["config", "user.email", "fixture@example.invalid"]);
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "package.json"), "{}\n");
      writeFileSync(join(repo, "src/example.ts"), "export const value = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "initial fixture"]);
      git(["checkout", "-qb", "topic"]);
      writeFileSync(join(repo, "src/example.ts"), "export const value = 2;\n");
      git(["commit", "-qam", "published source"]);
      const published = git(["rev-parse", "HEAD"]);
      git(["checkout", "-q", "main"]);
      writeFileSync(join(repo, "package.json"), '{"scripts":{}}\n');
      git(["commit", "-qam", "main input"]);
      git(["checkout", "-q", "topic"]);
      git(["merge", "--no-ff", "-qm", "merge main fixture", "main"]);
      writeFileSync(join(repo, "package.json"), "{}\n");
      writeFileSync(join(repo, "src/example.ts"), "export const value = 3;\n");
      git(["commit", "-qam", "restore input and update source"]);
      expect(git(["diff", "--name-only", published, "HEAD"])).toBe("src/example.ts");
      const historyStart = source.indexOf("function decodeUtf8Strict(");
      const historyEnd = source.indexOf("function classifyPrePushChanges(");
      const historyReason = runInNewContext(`${source.slice(historyStart, historyEnd)}; getPushedHistoryFullReason`, {
        commands: { git: "git" }, TextDecoder, Buffer, classifyDocumentationChanges, selectFastSourceChecks, parseGitRawDiff,
        spawnSync: (command: string, args: string[], options: object) => spawnSync(command, args, { ...options, env }),
        captureOptional: (_command: string, args: string[]) => git(args),
      });
      expect(historyReason(repo, published, git(["rev-parse", "HEAD"])))
        .toContain("package.json is a global test or build input in pushed history");
    } finally { await cleanupTmpDir(repo); }
  });

  it("takes a message-only push on the fast tier with its consumers instead of the full suite", () => {
    const result = classify([modified("src/i18n/messages/generated/shellExecution.ts")], {
      update: { localRef: "refs/heads/feat/copy", remoteRef: "refs/heads/feat/copy", remoteSha: "0".repeat(40) },
      messageCatalog: {
        namespaces: ["shellExecution"],
        testFiles: ["src/i18n/__tests__/i18n.test.ts", "src/shared/__tests__/shell-execution-environment.test.ts"],
        consumerModules: ["src/shared/shell-execution-environment.ts"],
      },
    });
    expect(result).toMatchObject({
      fastSource: true,
      relatedFiles: [],
      testFiles: ["src/i18n/__tests__/i18n.test.ts", "src/shared/__tests__/shell-execution-environment.test.ts"],
      messageCatalog: {
        files: ["src/i18n/messages/generated/shellExecution.ts"],
        namespaces: ["shellExecution"],
        consumerModules: ["src/shared/shell-execution-environment.ts"],
      },
    });
    expect(result.lockSuites).toEqual([]);
  });

  it("keeps a message change with a test change off the test-only tier, so the catalog checks still run", () => {
    const result = classify([modified("src/i18n/messages/generated/shellExecution.ts"), modified("test/example.test.ts")], {
      messageCatalog: { namespaces: ["shellExecution"], testFiles: ["src/i18n/__tests__/i18n.test.ts"], consumerModules: [] },
    });
    expect(result.testOnly).not.toBe(true);
    expect(result).toMatchObject({
      fastSource: true,
      testFiles: ["src/i18n/__tests__/i18n.test.ts", "test/example.test.ts"],
      messageCatalog: { files: ["src/i18n/messages/generated/shellExecution.ts"] },
    });
  });

  it("does not hand a changed consumer to discovery twice", () => {
    const result = classify([modified("src/shared/shell-execution-environment.ts"), modified("src/i18n/messages/generated/shellExecution.ts")], {
      messageCatalog: { namespaces: ["shellExecution"], testFiles: [], consumerModules: ["src/shared/shell-execution-environment.ts", "src/ui/panel.tsx"] },
    });
    expect(result.relatedFiles).toEqual(["src/shared/shell-execution-environment.ts"]);
    expect(result.messageCatalog.consumerModules).toEqual(["src/ui/panel.tsx"]);
  });

  it("keeps the full checks when the message selection cannot be made", () => {
    const result = classify([modified("src/i18n/messages/generated/shellExecution.ts")], {
      messageCatalog: { reason: "no source file names message namespace shellExecution; a computed key may reach it, full checks required" },
    });
    expect(result.fastSource).not.toBe(true);
    expect(result.reason).toContain("computed key");
  });

  it.each(["src/i18n/messages/index.ts", "src/i18n/testing/vitest-ambient-intl.ts"])(
    "keeps the catalog loader and the Vitest setup file global: %s", (path) => {
      const result = classify([modified(path)]);
      expect(result.fastSource).not.toBe(true);
      expect(result.reason).toBe(`${path} is a global test or build input`);
    },
  );

  it("selects message consumers from the pushed blobs and the checked-out tree of a real repository", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pre-push-messages-"));
    const env = gitFixtureEnv(repo);
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
    const write = (path: string, text: string) => {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), text);
    };
    try {
      git(["init", "-q"]);
      git(["config", "user.name", "Fixture"]);
      git(["config", "user.email", "fixture@example.invalid"]);
      const fragment = "src/i18n/messages/generated/panel.ts";
      const catalog = (english: string) =>
        `export const en = {\n  "panel.title": ${JSON.stringify(english)},\n  "other.label": "Other",\n} as const;\n` +
        'export const ko: Record<keyof typeof en, string> = {\n  "panel.title": "패널",\n  "other.label": "기타",\n};\n';
      write(fragment, catalog("Panel"));
      write("src/i18n/runtime.ts", 'export function t(key: string, vars?: unknown) { return key; }\n');
      write("src/ui/panel.tsx", 'import { t } from "../i18n/runtime.js"; export const title = () => t("panel.title");\n');
      write("src/ui/other.tsx", 'import { t } from "../i18n/runtime.js"; export const label = () => t("other.label");\n');
      write("src/ui/__tests__/panel-copy.test.tsx", 'import { t } from "../../i18n/runtime.js"; export const actual = t("panel.title");\n');
      write("src/i18n/__tests__/i18n.test.ts", 'export const suiteName = "i18n";\n');
      write("test/e2e/panel.spec.ts", 'import { t } from "../../src/i18n/runtime.js"; export const expected = t("panel.title");\n');
      git(["add", "."]);
      git(["commit", "-qm", "initial fixture"]);
      const base = git(["rev-parse", "HEAD"]);
      write(fragment, catalog("Panel heading"));
      git(["commit", "-qam", "reword the panel title"]);
      const local = git(["rev-parse", "HEAD"]);
      const start = source.indexOf("function decodeUtf8Strict(");
      const end = source.indexOf("function classifyPrePushChanges(");
      const select = runInNewContext(`${source.slice(start, end)}; getMessageCatalogSelection`, {
        commands: { git: "git" }, TextDecoder, Buffer, join, readFileSync, selectMessageCatalogChecks,
        spawnSync: (command: string, args: string[], options: object) => spawnSync(command, args, { ...options, env }),
      });
      expect(select(repo, [{ ...modified(fragment), baseSha: base, localSha: local }])).toEqual({
        namespaces: ["panel"],
        testFiles: ["src/i18n/__tests__/i18n.test.ts", "src/ui/__tests__/panel-copy.test.tsx"],
        consumerModules: ["src/ui/panel.tsx"],
      });
      // Keep the literal consumer in the same pushed tree. Its presence must
      // not hide a second consumer whose namespace is computed at runtime.
      write("src/ui/dynamic.ts", 'export const title = (ns: string) => t(`${ns}.title`);\n');
      git(["add", "src/ui/dynamic.ts"]);
      git(["commit", "-qm", "add computed consumer"]);
      const messageCatalog = select(repo, [{ ...modified(fragment), baseSha: base, localSha: git(["rev-parse", "HEAD"]) }]);
      const result = classify([modified(fragment)], { messageCatalog });
      expect(result).toEqual({
        docsOnly: false,
        reason: "src/ui/dynamic.ts has an unresolved dynamic message consumer; full checks required",
      });
    } finally {
      await cleanupTmpDir(repo);
    }
  });
});

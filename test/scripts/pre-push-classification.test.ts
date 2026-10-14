import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { classifyDocumentationChanges, isCanonicalGitPath } from "../../scripts/hooks/pre-push-markdown-policy.mjs";
import { isIntegrationBranchRef } from "../../scripts/hooks/pre-push-ref-updates.mjs";
import { selectFastSourceChecks, selectTriggeredLockSuites } from "../../scripts/hooks/pre-push-source-policy.mjs";
import { selectTargetedAveAppVitestFiles } from "../../scripts/hooks/pre-push-test-policy.mjs";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

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

  it("reads the global input from real pushed history when the final diff contains only source", () => {
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
        commands: { git: "git" }, TextDecoder, Buffer, classifyDocumentationChanges, selectFastSourceChecks,
        spawnSync: (command: string, args: string[], options: object) => spawnSync(command, args, { ...options, env }),
        captureOptional: (_command: string, args: string[]) => git(args),
      });
      expect(historyReason(repo, base, git(["rev-parse", "HEAD"]))).toContain("package.json is a global test or build input in pushed history");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("retains a merged main input even when a later commit removes it from the pushed net diff", () => {
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
        commands: { git: "git" }, TextDecoder, Buffer, classifyDocumentationChanges, selectFastSourceChecks,
        spawnSync: (command: string, args: string[], options: object) => spawnSync(command, args, { ...options, env }),
        captureOptional: (_command: string, args: string[]) => git(args),
      });
      expect(historyReason(repo, published, git(["rev-parse", "HEAD"])))
        .toContain("package.json is a global test or build input in pushed history");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

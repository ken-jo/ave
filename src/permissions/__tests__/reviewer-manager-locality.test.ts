import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../permission-manager.js";
import { LlmRiskClassifier } from "../reviewer/risk-classifier.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";

describe.runIf(process.platform === "win32")("reviewer manager current file facts", () => {
  it("uses fresh path evidence when the same operands resolve outside their original scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-reviewer-path-facts-"));
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    const operand = join(allowed, "alias");
    mkdirSync(join(allowed, "original"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(join(allowed, "original"), operand, "junction");
    const manager = new PermissionManager(join(root, "permissions.json"));
    const cache = new VerdictCache(join(root, "verdicts.jsonl"));
    const provider = { complete: vi.fn(async () => ({
      text: '{"level":"low","reason":"bounded write"}', tokensIn: 1, tokensOut: 1, costUsd: 0,
    })) };
    setReviewerForTest(manager, { classifier: new LlmRiskClassifier(provider, "fixture", "deny"), cache });
    manager.setMode("auto");
    const review = () => manager.dispatchReviewer("write_file", {
      invocationId: randomUUID(), sessionId: "review", source: "builtin", category: "write",
      pathFields: ["path"], finalInput: { path: join(operand, "note.txt") }, executionCwd: allowed,
      allowedDirectories: [caseFoldForMatch(canonicalizePathForMatch(allowed))],
      sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
    }, undefined, { lane: "foreground-auto" });
    try {
      expect((await review()).verdict.level).toBe("low");
      expect(await review()).toMatchObject({ outcome: "cache", verdict: { level: "low" } });
      expect(provider.complete).toHaveBeenCalledOnce();
      unlinkSync(operand);
      symlinkSync(outside, operand, "junction");
      expect((await review()).verdict.level).toBe("high");
      expect(provider.complete).toHaveBeenCalledOnce();
    } finally {
      await cleanupTmpDir(root);
    }
  });
});

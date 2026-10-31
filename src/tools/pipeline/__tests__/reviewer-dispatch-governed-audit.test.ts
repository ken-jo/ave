import { setReviewerForTest } from "../../../__tests__/support/reviewer-judge.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { RuleBasedRiskClassifier } from "../../../permissions/reviewer/risk-classifier.js";
import { VerdictCache } from "../../../permissions/reviewer/verdict-cache.js";
import { dispatchReviewerForHeadless } from "../reviewer-dispatch.js";

describe("headless reviewer dispatch audit ownership", () => {
  it("returns strict headless denial without invoking review or duplicating denial history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-strict-governed-"));
    try {
      const permissionManager = new PermissionManager(
        join(directory, "permissions.json"),
      );
      const recentlyDenied = makeRecentlyDeniedStore(
        join(directory, "recently-denied.jsonl"),
      );
      permissionManager.setMode("strict");
      const classifier = new RuleBasedRiskClassifier();
      const classify = vi.spyOn(classifier, "classify");
      const append = vi.spyOn(recentlyDenied, "append");
      setReviewerForTest(permissionManager, {
        classifier,
        cache: new VerdictCache(join(directory, "reviewer-cache.jsonl")),
        recentlyDenied,
      });

      const result = await dispatchReviewerForHeadless(
        permissionManager,
        "domain_network",
        "plugin",
        "network",
        [],
        {
          operation: "status",
          opaqueSecret: "must-never-reach-deferred-storage",
        },
        [],
        [],
        { trustOrigin: "plugin-emitted", headless: true },
        {
          pathFields: [],
          targetFilePaths: [],
          sensitivePathsAdjacent: [],
        },
        {},
        undefined,
        { groupId: "group", toolUseId: "tool-use", displayOrder: 0 },
        undefined,
        undefined,
        undefined,
        { operation: "status" },
        "reviewer-governed-audit-session",
      );

      expect(result).toMatchObject({
        allowed: false,
        message: "Nobody can approve this request; do not retry.",
        permissionResult: { decision: "deny", reasonCode: "no-approver" },
      });
      expect(classify).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(await recentlyDenied.list()).toEqual([]);
    } finally {
      await cleanupTmpDir(directory);
    }
  });
});

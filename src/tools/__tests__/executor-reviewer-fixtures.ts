import { join } from "node:path";
import { vi } from "vitest";

import type { ExecutionMode } from "../../shared/permission-mode.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";

// Use default mode to test approval prompts and auto mode to test reviewer rationale.
export function makePermissionManager(
  dir: string,
  classifySpy: ReturnType<typeof vi.fn>,
  mode: ExecutionMode = "default",
): PermissionManager {
  const permMgr = new PermissionManager(join(dir, "permissions.json"));
  permMgr.setMode(mode);
  permMgr.setInteractiveAutoApprove("low");
  setReviewerForTest(permMgr, {
    classifier: { classify: classifySpy },
    cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl")),
  });
  return permMgr;
}

// Use a nonexistent settings path so persisted rules cannot contradict the fixed verdict.
export function permissionManagerReturning(
  result: ReturnType<PermissionManager["checkDetailed"]>,
): PermissionManager {
  const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
  permMgr.checkDetailed = () => result;
  return permMgr;
}

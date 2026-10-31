import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";

describe("routine write permission dependency", () => {
  it.each([undefined, "medium", "high"] as const)("uses the reviewer result before headless fallback for a reply: %s", async (level) => {
    const dir = mkdtempSync(join(tmpdir(), "routine-write-"));
    try {
      const execute = vi.fn(async () => ({ output: "sent", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "samplemail_email_reply", pluginId: "samplemail", source: "plugin",
        description: "Send a reply", category: "network", pathFields: [], isReadOnly: () => false,
        jsonSchema: { type: "object", properties: {} }, execute,
      }));
      const manager = new PermissionManager(join(dir, "permissions.json"));
      manager.setMode("auto");
      const classify = vi.fn(() => ({ level: level ?? "high", reason: "External write" }));
      if (level) setReviewerForTest(manager, { classifier: { classify }, cache: new VerdictCache(join(dir, "cache.jsonl")), recentlyDenied: makeRecentlyDeniedStore(join(dir, "deferred.jsonl")) });
      const executor = new ToolExecutor(registry, undefined, manager);
      const pending = executor.executeAll([{ id: "reply", name: "samplemail_email_reply", input: {} }], {
        sessionId: "routine-session", permissionContext: userPermissionContext({ headless: true }),
      });
      if (level === undefined) {
        await expect(pending).rejects.toThrow("Permission judge is not wired");
        expect(execute).not.toHaveBeenCalled();
        return;
      }
      const [result] = await pending;
      if (level === "medium") {
        expect(result.is_error).toBeUndefined();
        expect(execute).toHaveBeenCalledOnce();
      } else {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("Nobody can approve this request; do not retry.");
        expect(execute).not.toHaveBeenCalled();
      }
      expect(classify).toHaveBeenCalled();
    } finally { await cleanupTmpDir(dir); }
  });
});

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { ToolRegistry } from "../../registry.js";
import { AuditWriter } from "../audit-writer.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { userPermissionContext } from "../../__tests__/tool-context-fixture.js";

describe("tool lifecycle hook audit persistence", () => {
  it.each(["PermissionDenied", "PostToolUseFailure"] as const)("persists bounded %s identity and context metadata without hook output", async (event) => {
    const root = mkdtempSync(join(tmpdir(), "ave-lifecycle-audit-"));
    const audit = new AuditLogger(root);
    try {
      const manager = new ScriptHookManager();
      vi.spyOn(manager, "runLifecycleEvent").mockResolvedValue({ decision: "allow", reason: "private-hook-output", results: [{
        hookPath: "project-hook", hookType: event, source: "config", hookSource: "project", handlerType: "http", matcher: "probe_tool",
        decision: "deny", reason: "HTTP hook request failed", commandIdentity: "reviewed-definition", additionalContext: "private-hook-output",
        rawStdout: "private-header-value", durationMs: 7, timedOut: false,
      }] });
      const writer = new AuditWriter(audit, new ToolRegistry(), manager, false);
      expect(await writer.fireLifecycleEvent(event, "audit-session", userPermissionContext(), {})).toMatchObject({ status: "executed" });
      await audit.flush();
      const bytes = readdirSync(root).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(root, name), "utf8")).join("");
      expect(bytes).not.toContain("private-hook-output");
      expect(bytes).not.toContain("private-header-value");
      const rows = bytes.trim().split("\n").map((line) => JSON.parse(line));
      expect(rows.map((row) => JSON.parse(row.input))).toContainEqual(expect.objectContaining({ type: "hook_executed", event,
        hookName: "project-hook", hookSource: "project", handlerType: "http", matcher: "probe_tool", failureReason: "request-failed", commandIdentity: "reviewed-definition", additionalContextChars: 19 }));
    } finally { await audit.close(); await cleanupTmpDir(root); }
  });
});

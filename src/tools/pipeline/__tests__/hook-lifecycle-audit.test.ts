import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { ToolRegistry } from "../../registry.js";
import { AuditWriter, type LifecycleDispatchObservation } from "../audit-writer.js";
import { admitToolInvocation } from "../../invocation-ledger.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { userPermissionContext } from "../../__tests__/tool-context-fixture.js";

/** PermissionDenied reaches the writer only through a ledger denial, so it is fired by committing a denied row. */
async function fire(writer: AuditWriter, event: "PermissionDenied" | "PostToolUseFailure"): Promise<LifecycleDispatchObservation | undefined> {
  if (event === "PostToolUseFailure") return writer.fireLifecycleEvent(event, "audit-session", userPermissionContext(), {});
  let observed: LifecycleDispatchObservation | undefined;
  const admission = admitToolInvocation("probe_tool");
  admission.terminal.hostTerminal(async () => {}, { governed: () => false,
    fire: async (denial) => { observed = await writer.fireDenied(denial, "audit-session", userPermissionContext(), {}); } });
  await admission.terminal.commit((row) => row({ kind: "denied", entry: { decision: "deny", ts: new Date().toISOString(), auditId: "probe",
    tool: "probe_tool", source: "builtin", category: "meta", trustOrigin: "unknown", toolUseId: "tu-probe",
    denyReasons: [{ reason: "probe", source: "tool-executor" }] } }));
  admission.settle();
  return observed;
}

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
      expect(await fire(writer, event)).toMatchObject({ status: "executed" });
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

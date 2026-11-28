import { afterEach, describe, expect, it, vi } from "vitest";

import { collectPermissionEvents } from "../../../__tests__/support/permission-events.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { AuditWriter, type LifecycleDispatchObservation } from "../audit-writer.js";
import { admitToolInvocation } from "../../invocation-ledger.js";
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

afterEach(() => vi.restoreAllMocks());

describe("tool lifecycle hook logging", () => {
  it.each(["PermissionDenied", "PostToolUseFailure"] as const)("emits bounded %s outcome fields without hook output", async (event) => {
    const { events } = collectPermissionEvents();
    const manager = new ScriptHookManager();
    vi.spyOn(manager, "runLifecycleEvent").mockResolvedValue({ decision: "allow", reason: "private-hook-output", results: [{
      hookPath: "project-hook", hookType: event, source: "config", hookSource: "project", handlerType: "http", matcher: "probe_tool",
      decision: "deny", reason: "HTTP hook request failed", commandIdentity: "reviewed-definition", additionalContext: "private-hook-output",
      rawStdout: "private-header-value", durationMs: 7, timedOut: false,
    }] });
    const writer = new AuditWriter(manager);
    expect(await fire(writer, event)).toMatchObject({ status: "executed" });

    expect(events).toContainEqual(expect.objectContaining({
      event: "hook_executed", hookType: event, hookSource: "project",
      handlerType: "http", failureReason: "request-failed", elapsedMs: 7,
    }));
    const output = JSON.stringify(events);
    expect(output).not.toContain("private-hook-output");
    expect(output).not.toContain("private-header-value");
    expect(output).not.toContain("reviewed-definition");
  });
});

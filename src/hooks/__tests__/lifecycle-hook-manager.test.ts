// Lifecycle denials are audit-only; untrusted hooks never enter the registry. Lifecycle hooks are config-only (docs/architecture/hook-runtime-expansion-design.md).
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ScriptHookManager } from "../script-hook-manager.js";
import type { HookConfigEntry } from "../hook-config.js";
import type { LifecycleEventPayload, LifecycleHookEvent } from "../script-hook-types.js";
import { hasExecutable } from "./test-helpers.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");
const ECHO = resolve(FIXTURE_ROOT, "cmd-lifecycle-echo.js");
const DENY = resolve(FIXTURE_ROOT, "cmd-lifecycle-deny.js");

const HAS_NODE = hasExecutable("node");

function lifecycleEntry(
  event: LifecycleHookEvent,
  command: string[],
  over: Partial<HookConfigEntry> = {},
): HookConfigEntry {
  return {
    id: `${event}#0.0`,
    event,
    command,
    timeoutMs: 5000,
    source: "config",
    ...over,
  };
}

const ALL_EVENTS: LifecycleHookEvent[] = [
  "PostToolUseFailure",
  "PermissionDenied",
  "SessionStart",
  "Stop",
  "PreCompact",
  "PostCompact",
];

describe("#811 m2 — lifecycle event dispatch", () => {
  it.skipIf(!HAS_NODE).each(ALL_EVENTS)(
    "fires the registered hook for %s with the event + sessionId in the payload",
    async (event) => {
      const m = new ScriptHookManager();
      m.setTrustedRegistry([], [lifecycleEntry(event, ["node", ECHO])]);
      const out = await m.runLifecycleEvent(event, "sess-42", "unknown");
      expect(out.results).toHaveLength(1);
      expect(out.results[0].reason).toContain(`event=${event}`);
      expect(out.results[0].reason).toContain("session=sess-42");
      expect(out.results[0].hookType).toBe(event);
    },
  );

  it.skipIf(!HAS_NODE)("PostToolUseFailure carries toolName + errorMessage + durationMs", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PostToolUseFailure", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PostToolUseFailure", "s1", "unknown", {
      toolName: "fs_write",
      errorMessage: "disk full",
      durationMs: 123,
    });
    expect(out.results[0].reason).toContain("tool=fs_write");
    expect(out.results[0].reason).toContain("err=disk full");
    expect(out.results[0].reason).toContain("dur=123");
  });

  it.skipIf(!HAS_NODE)("PermissionDenied carries the denyReason {source}", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PermissionDenied", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PermissionDenied", "s1", "unknown", {
      toolName: "bash",
      denyReason: { source: "tool-executor" },
    });
    expect(out.results[0].reason).toContain('deny={"source":"tool-executor"}');
  });

  it.skipIf(!HAS_NODE)("PreCompact carries reason + tokenEstimate", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PreCompact", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PreCompact", "s1", "unknown", {
      reason: "auto-compact",
      tokenEstimate: 90000,
    });
    expect(out.results[0].reason).toContain("reason=auto-compact");
    expect(out.results[0].reason).toContain("est=90000");
  });

  it.skipIf(!HAS_NODE)("PostCompact carries messages/tokens before + after", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PostCompact", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PostCompact", "s1", "unknown", {
      messagesBefore: 50,
      messagesAfter: 10,
      tokensBefore: 90000,
      tokensAfter: 20000,
    });
    expect(out.results[0].reason).toContain("mb=50");
    expect(out.results[0].reason).toContain("ma=10");
    expect(out.results[0].reason).toContain("tb=90000");
    expect(out.results[0].reason).toContain("ta=20000");
  });

  it.skipIf(!HAS_NODE)("PermissionDenied carries the finalized deny reason text", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PermissionDenied", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PermissionDenied", "s1", "unknown", {
      toolName: "bash",
      denyReason: { source: "tool-executor", reason: "tool-not-found" },
    });
    expect(out.results[0].reason).toContain(
      'deny={"source":"tool-executor","reason":"tool-not-found"}',
    );
  });

  it.skipIf(!HAS_NODE)("PermissionDenied DLP-redacts a secret-shaped deny reason", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PermissionDenied", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PermissionDenied", "s1", "unknown", {
      toolName: "bash",
      denyReason: { source: "tool-executor", reason: "blocked write for 415-555-1234" },
    });
    expect(out.results[0].reason).toContain('"source":"tool-executor","reason":"blocked write for ');
    expect(out.results[0].reason).not.toContain("415-555-1234");
  });

  it.skipIf(!HAS_NODE)("SubagentStart carries agentId + agentType", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("SubagentStart", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("SubagentStart", "s1", "unknown", {
      agentId: "spawn-1",
      agentType: "explore",
    });
    expect(out.results[0].reason).toContain("agent=spawn-1");
    expect(out.results[0].reason).toContain("agentType=explore");
  });

  it.skipIf(!HAS_NODE)("Notification carries the DLP-redacted message", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("Notification", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("Notification", "s1", "unknown", {
      message: "done; call 415-555-1234",
    });
    expect(out.results[0].reason).toContain("msg=done; call ");
    expect(out.results[0].reason).not.toContain("415-555-1234");
  });

  it.skipIf(!HAS_NODE)("SessionStart carries sessionMeta", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("SessionStart", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("SessionStart", "s1", "unknown", {
      sessionMeta: { sessionKind: "routine", routineId: "r1" },
    });
    expect(out.results[0].reason).toContain('meta={"sessionKind":"routine","routineId":"r1"}');
  });

  it.skipIf(!HAS_NODE)("DLP-redacts a secret-bearing errorMessage before dispatch", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("PostToolUseFailure", ["node", ECHO])]);
    const out = await m.runLifecycleEvent("PostToolUseFailure", "s1", "unknown", {
      toolName: "fs_read",
      errorMessage: "failed to email owner@ave.example.com",
    });
    // The email is redacted before the hook ever sees it.
    expect(out.results[0].reason).toContain("[REDACTED:EMAIL]");
    expect(out.results[0].reason).not.toContain("owner@ave.example.com");
  });
});

describe("#811 m2 — NON-BLOCKING semantics (observe-only)", () => {
  it.skipIf(!HAS_NODE)("records a deny but the caller can ignore it (decision is observe-only)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("Stop", ["node", DENY])]);
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown", { stopReason: "end_turn" });
    expect(out.decision).toBe("deny");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].decision).toBe("deny");
    // Callers must ignore lifecycle denials; they cannot abort the turn.
  });

  it("never throws and returns an empty observe result when nothing matches", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], []);
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown", { stopReason: "end_turn" });
    expect(out.decision).toBe("allow");
    expect(out.results).toEqual([]);
  });
});

describe("#811 m2 — trust boundary + matcher", () => {
  it.each<{ event: LifecycleHookEvent; matcher: string; payload: LifecycleEventPayload; other: LifecycleEventPayload }>([
    { event: "PostToolUseFailure", matcher: "write_file", payload: { toolName: "write_file" }, other: { toolName: "read_file" } },
    { event: "PermissionDenied", matcher: "write_file", payload: { toolName: "write_file" }, other: { toolName: "read_file" } },
    { event: "PreCompact", matcher: "manual", payload: { reason: "manual" }, other: { reason: "auto-compact" } },
    { event: "PreCompact", matcher: "auto", payload: { reason: "auto-compact" }, other: { reason: "manual" } },
    { event: "PostCompact", matcher: "manual", payload: { reason: "manual" }, other: { reason: "auto-compact" } },
    { event: "PostCompact", matcher: "auto", payload: { reason: "auto-compact" }, other: { reason: "manual" } },
    { event: "SubagentStart", matcher: "worker", payload: { agentType: "worker" }, other: { agentType: "reviewer" } },
    { event: "SubagentStop", matcher: "worker", payload: { agentType: "worker" }, other: { agentType: "reviewer" } },
    { event: "SessionEnd", matcher: "load-session", payload: { reason: "load-session" }, other: { reason: "new-conversation" } },
    { event: "SessionStart", matcher: "resume", payload: { sessionSource: "resume" }, other: { sessionSource: "clear" } },
    { event: "Notification", matcher: "permission_prompt", payload: { notificationType: "permission_prompt" }, other: { notificationType: "agent_completed" } },
  ])("filters $event by its event payload ($matcher)", async ({ event, matcher, payload, other }) => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry(event, ["node", ECHO], { matcher })]);
    expect((await m.runLifecycleEvent(event, "session-example", "unknown", payload)).results).toHaveLength(1);
    expect((await m.runLifecycleEvent(event, matcher, "unknown", other)).results).toEqual([]);
    expect((await m.runLifecycleEvent(event, matcher, "unknown", {})).results).toEqual([]);
  });

  it.each(["SessionStart", "Notification"] as const)("never uses the session ID for %s matching", async (event) => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry(event, ["node", ECHO], { matcher: "^session-allowed$" })]);
    expect((await m.runLifecycleEvent(event, "session-allowed", "unknown")).results).toEqual([]);
    expect((await m.runLifecycleEvent(event, "session-other", "unknown", { reason: "session-allowed" })).results).toEqual([]);
  });

  it.skipIf(!HAS_NODE)("an untrusted / quarantined hook never fires (not in the trusted registry)", async () => {
    const m = new ScriptHookManager();
    // Quarantine excludes entries from the trusted registry.
    m.setTrustedRegistry([], []);
    const out = await m.runLifecycleEvent("SessionStart", "s1", "unknown");
    expect(out.results).toEqual([]);
    expect(m.size()).toBe(0);
  });

  it.skipIf(!HAS_NODE)("Stop ignores the matcher for every session", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [lifecycleEntry("Stop", ["node", ECHO], { matcher: "^sess-allowed.*$" })]);

    const matched = await m.runLifecycleEvent("Stop", "sess-allowed-1", "unknown");
    expect(matched.results).toHaveLength(1);

    const skipped = await m.runLifecycleEvent("Stop", "sess-other", "unknown");
    expect(skipped.results).toHaveLength(1);
    expect(skipped.decision).toBe("allow");
  });

  it.skipIf(!HAS_NODE)("only the matching event's hook fires (event filter)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry(
      [],
      [
        lifecycleEntry("Stop", ["node", ECHO], { id: "Stop#0.0" }),
        lifecycleEntry("SessionStart", ["node", DENY], { id: "SessionStart#0.0" }),
      ],
    );
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown");
    expect(out.results).toHaveLength(1);
    expect(out.decision).toBe("allow");
    expect(out.results[0].reason).toContain("event=Stop");
  });
});

describe("#811 m2 — back-compat (no lifecycle config)", () => {
  it("a tool-use registry with no lifecycle entries dispatches nothing for lifecycle events", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [
      { id: "PreToolUse#0.0", event: "pre", command: ["./pre.sh"], timeoutMs: 5000, source: "config" },
    ]);
    const out = await m.runLifecycleEvent("Stop", "s1", "unknown", { stopReason: "end_turn" });
    expect(out.results).toEqual([]);
    expect(out.decision).toBe("allow");
  });
});

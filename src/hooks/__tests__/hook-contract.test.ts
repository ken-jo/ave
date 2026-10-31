import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptHookManager } from "../script-hook-manager.js";
import { parseHookConfig } from "../hook-config.js";
import { hookJsonInput, stopHookBlockFeedback, type HookEventName } from "../hook-contract.js";
import { parseHookStdout, runOneHookScript } from "../script-hook-runner.js";
import type { HookEvent, LifecycleEventPayload, ScriptHookStdin } from "../script-hook-types.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs");
const TOOL_INPUT = { path: "/workspace/result.txt" };
const TOOL_PAYLOAD = { toolName: "write_file", source: "builtin" as const, category: "write" as const,
  input: TOOL_INPUT, sessionId: "contract-session", trustOrigin: "user-keyboard" as const };

const EVENT_CASES: Array<{ name: HookEventName; event: HookEvent; payload: LifecycleEventPayload; expected: Record<string, unknown> }> = [
  { name: "PreToolUse", event: "pre", payload: {}, expected: { tool_name: "write_file", tool_input: TOOL_INPUT } },
  { name: "PostToolUse", event: "post", payload: {}, expected: { tool_name: "write_file", tool_input: TOOL_INPUT, tool_response: "written", is_error: false } },
  { name: "PermissionRequest", event: "perm", payload: {}, expected: { tool_name: "write_file", tool_input: TOOL_INPUT } },
  { name: "UserPromptSubmit", event: "UserPromptSubmit", payload: {}, expected: { prompt: "check this change" } },
  { name: "PostToolUseFailure", event: "PostToolUseFailure", payload: { toolName: "write_file", errorMessage: "disk full", durationMs: 10 }, expected: { tool_name: "write_file", error: "disk full", duration_ms: 10 } },
  { name: "PermissionDenied", event: "PermissionDenied", payload: { toolName: "write_file", denyReason: { source: "policy", reason: "outside scope" } }, expected: { tool_name: "write_file", deny_reason: { source: "policy", reason: "outside scope" } } },
  { name: "SessionStart", event: "SessionStart", payload: { sessionMeta: { persona: "default" }, sessionSource: "resume" }, expected: { source: "resume", session_meta: { persona: "default" } } },
  { name: "SessionEnd", event: "SessionEnd", payload: { reason: "new-conversation", stopReason: "reset" }, expected: { reason: "new-conversation", stop_reason: "reset" } },
  { name: "Notification", event: "Notification", payload: { message: "Turn complete", notificationType: "agent_completed" }, expected: { message: "Turn complete", notification_type: "agent_completed" } },
  { name: "Stop", event: "Stop", payload: { stopReason: "complete", toolCount: 2, durationMs: 10, stopHookActive: true }, expected: { stop_reason: "complete", tool_count: 2, duration_ms: 10, stop_hook_active: true } },
  { name: "PreCompact", event: "PreCompact", payload: { reason: "manual", tokenEstimate: 42 }, expected: { reason: "manual", token_estimate: 42 } },
  { name: "PostCompact", event: "PostCompact", payload: { messagesBefore: 4, messagesAfter: 2, tokensBefore: 42, tokensAfter: 20 }, expected: { messages_before: 4, messages_after: 2, tokens_before: 42, tokens_after: 20 } },
  { name: "SubagentStart", event: "SubagentStart", payload: { agentId: "child", agentType: "worker" }, expected: { agent_id: "child", agent_type: "worker" } },
  { name: "SubagentStop", event: "SubagentStop", payload: { agentId: "child", agentType: "worker", stopReason: "complete", stopHookActive: false }, expected: { agent_id: "child", agent_type: "worker", stop_reason: "complete", stop_hook_active: false } },
];

async function dispatch(entry: typeof EVENT_CASES[number], mode: string, denied = false) {
  const manager = new ScriptHookManager();
  if (denied) manager.setCommandAuthorizer(async () => ({ decision: "deny", reason: "shell policy" }));
  const parsed = parseHookConfig({ hooks: { [entry.name]: [{ hooks: [{ type: "command", command: [mode === "spawn-failure" ? "ave-nonexistent-hook-program" : "node", COMMAND, mode], timeoutMs: mode === "slow" ? 100 : 5000 }] }] } });
  expect(parsed.errors).toEqual([]);
  expect(parsed.warnings).toEqual([]);
  manager.setTrustedRegistry([], parsed.entries);
  switch (entry.event) {
    case "pre": return manager.runPreToolUse(TOOL_PAYLOAD);
    case "post": return manager.runPostToolUse({ ...TOOL_PAYLOAD, toolOutput: "written", isError: false });
    case "perm": return manager.runPermissionRequest(TOOL_PAYLOAD);
    case "UserPromptSubmit": return manager.runUserPromptSubmit("contract-session", "user-keyboard", { inputText: "check this change" });
    default: return manager.runLifecycleEvent(entry.event, "contract-session", "user-keyboard", entry.payload);
  }
}

describe("user hook event contract", () => {
  it.each([
    { event: "PreCompact", reason: "manual", trigger: "manual" },
    { event: "PreCompact", reason: "auto-compact", trigger: "auto" },
    { event: "PostCompact", reason: "manual", trigger: "manual" },
    { event: "PostCompact", reason: "auto-compact", trigger: "auto" },
  ] as const)("serializes $event reason $reason as trigger $trigger", async ({ event, reason, trigger }) => {
    const result = await dispatch({ name: event, event, payload: { reason }, expected: {} }, "echo");
    expect(result.results).toHaveLength(1);
    expect(JSON.parse(result.results[0].rawStdout).received).toMatchObject({
      hook_event_name: event, trigger,
    });
  });

  it.each(EVENT_CASES)("serializes $name through the registry and real command runner", async (entry) => {
    const result = await dispatch(entry, "echo");
    expect(result.decision, result.reason).toBe("allow");
    expect(result.results).toHaveLength(1);
    const input = JSON.parse(result.results[0].rawStdout).received;
    expect(input).toMatchObject({ schema_version: 1, hook_event_name: entry.name,
      session_id: "contract-session", sessionId: "contract-session", trustOrigin: "user-keyboard",
      hookType: entry.event, event: entry.event, cwd: process.cwd(), ...entry.expected });
    if (entry.event !== "pre" && entry.event !== "post" && entry.event !== "perm") {
      expect(input).not.toHaveProperty("tool_input");
    }
  });

  for (const mode of ["silent", "block", "failure", "signal", "invalid", "slow", "decision", "spawn-failure"] as const) {
    it.each(EVENT_CASES)(`${mode} has a defined outcome for $name`, async (entry) => {
      const result = await dispatch(entry, mode);
      expect(result.results).toHaveLength(1);
      const invocation = result.results[0];
      expect(invocation.decision).toBe(mode === "silent" ? "allow" : "deny");
      if (mode === "silent") expect(invocation.exitCode).toBe(0);
      if (mode === "block") {
        expect(invocation.exitCode).toBe(2);
        expect(invocation.reason).toContain("Policy requires a focused correction before proceeding.");
        expect(invocation.reason).not.toContain("cannot override");
      }
      if (mode === "failure") expect(invocation).toMatchObject({ exitCode: 7, reason: expect.stringContaining("exited non-zero") });
      if (mode === "signal") {
        expect(invocation).toMatchObject({ timedOut: false, reason: expect.stringContaining("exited non-zero") });
        if (process.platform !== "win32") expect(invocation.reason).toContain("terminated by SIGTERM");
      }
      if (mode === "invalid") expect(invocation.reason).toContain("not valid decision JSON");
      if (mode === "slow") expect(invocation).toMatchObject({ timedOut: true, reason: "hook timed out after 100ms" });
      if (mode === "decision") expect(invocation.reason).toBe("Review required");
      if (mode === "spawn-failure") expect(invocation.reason).toContain("hook spawn error");
      // Only a deliberate block may continue a stopped run; failures never do.
      const feedback = ({ block: "Policy requires a focused correction before proceeding.", decision: "Review required" } as Record<string, string>)[mode];
      expect(invocation.blockFeedback).toBe(feedback);
      expect(stopHookBlockFeedback(result)).toBe(feedback);
    });
  }

  it.each(EVENT_CASES)("enforces shell admission for $name before spawning", async (entry) => {
    const result = await dispatch(entry, "echo", true);
    expect(result.results[0]).toMatchObject({ decision: "deny", rawStdout: "", reason: "hook command denied: shell policy" });
  });

  it("redacts post-tool output before either wire spelling reaches a script", async () => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], parseHookConfig({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: ["node", COMMAND, "echo"] }] }] } }).entries);
    const result = await manager.runPostToolUse({ ...TOOL_PAYLOAD, toolOutput: "contact 415-555-1234" });
    const received = JSON.parse(result.results[0].rawStdout).received;
    expect(received.toolOutput).not.toContain("415-555-1234");
    expect(received.tool_response).toBe(received.toolOutput);
  });

  it("omits unavailable event fields rather than fabricating transcript metadata", () => {
    const input = JSON.parse(JSON.stringify(hookJsonInput({ hookType: "SessionEnd", event: "SessionEnd", sessionId: "s", trustOrigin: "unknown" }, "/workspace")));
    expect(input).not.toHaveProperty("stop_reason");
    expect(input).not.toHaveProperty("transcript_path");
  });
});

describe("structured hook decisions", () => {
  it.each(["allow", "deny"] as const)("parses a pre-tool %s without granting tool authority", (decision) => {
    expect(parseHookStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: "policy" } }), "pre"))
      .toEqual({ action: decision, reason: decision === "deny" ? "policy" : "hook completed" });
  });
  it.each(["allow", "deny"] as const)("parses a permission %s", (behavior) => {
    expect(parseHookStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, message: "policy" } } }), "perm"))
      .toEqual({ action: behavior, reason: behavior === "deny" ? "policy" : "hook completed" });
  });
  it.each([
    { hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "allow" } },
    { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } },
    { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: {} } },
    { action: "allow", reason: "legacy", decision: "block" },
    { decision: "unknown" },
    { continue: "false" },
    { additionalContext: "unsupported context injection" },
  ])("rejects unsupported or ambiguous control %j", (output) => {
    expect(parseHookStdout(JSON.stringify(output), "pre")).toBeNull();
  });
  it("allows empty JSON and retains deny precedence across control fields", () => {
    expect(parseHookStdout("{}", "pre")).toEqual({ action: "allow", reason: "hook completed" });
    expect(parseHookStdout("log message {}", "pre")).toBeNull();
    expect(parseHookStdout('```json\n{"decision":"block","reason":"policy"}\n```', "pre"))
      .toEqual({ action: "deny", reason: "policy", block: true });
    expect(parseHookStdout('{"continue":false,"stopReason":"halt","decision":"allow"}', "pre"))
      .toEqual({ action: "deny", reason: "halt" });
  });
  it("does not mark a block that also stops outright, or a legacy deny, as continuable", () => {
    expect(parseHookStdout('{"continue":false,"stopReason":"halt","decision":"block","reason":"policy"}', "Stop"))
      .toEqual({ action: "deny", reason: "policy" });
    expect(parseHookStdout('{"action":"deny","reason":"legacy"}', "Stop")).toEqual({ action: "deny", reason: "legacy" });
  });
  it.each(["stopReason", "updatedPermissions", "permissionDecision", "additionalContext", "suppressOutput", "systemMessage", "async", "asyncTimeout"])("rejects legacy output mixed with unsupported %s control", (key) => {
    expect(parseHookStdout(JSON.stringify({ action: "allow", reason: "legacy", [key]: "unsupported" }), "pre")).toBeNull();
  });
  it("reports output overflow and invalid timeout before treating a command as successful", async () => {
    const payload: ScriptHookStdin = { ...TOOL_PAYLOAD, hookType: "pre" };
    const hook = { id: "large", hookType: "pre" as const, hookPath: COMMAND, command: ["node", COMMAND, "large"] };
    expect(await runOneHookScript(hook, payload)).toMatchObject({ decision: "deny", reason: "hook stdout exceeded capture limit" });
    for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) {
      expect(await runOneHookScript(hook, payload, { timeoutMs })).toMatchObject({ decision: "deny", reason: expect.stringContaining("timeout must be") });
    }
  });
});

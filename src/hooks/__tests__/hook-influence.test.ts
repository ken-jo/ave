import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptHookManager } from "../script-hook-manager.js";
import { parseHookConfig } from "../hook-config.js";
import { parseHookStdout, runOneHookScript } from "../script-hook-runner.js";
import { attributedHookContext } from "../hook-influence.js";
import { MAX_HOOK_CONTEXT_CHARS } from "../script-hook-types.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/influence-command.cjs");
const PAYLOAD = { toolName: "influence_probe", source: "builtin" as const, category: "read" as const,
  input: {}, sessionId: "influence-session", trustOrigin: "user-keyboard" as const };

describe("reviewed hook influence", () => {
  it("revalidates the exact definition after asynchronous command admission", async () => {
    let current = true;
    const result = await runOneHookScript({ id: "reviewed-command", hookType: "pre", command: ["node", COMMAND, "context"], hookPath: COMMAND,
      validateTrust: () => current }, { ...PAYLOAD, hookType: "pre" }, {
      authorizeCommand: async () => { await Promise.resolve(); current = false; return { decision: "allow", reason: "approved" }; },
    });
    expect(result).toMatchObject({ decision: "deny", reason: expect.stringContaining("Hook definition changed"), rawStdout: "" });
  });

  it.each(["pre", "perm"] as const)("accepts %s replacements and rejects observer mutation", (event) => {
    expect(parseHookStdout('{"action":"modify","reason":"replace","updatedInput":{"operation":"write"}}', event))
      .toMatchObject({ action: "allow", updatedInput: { operation: "write" } });
    expect(parseHookStdout('{"action":"modify","reason":"replace","updatedInput":{}}', "post")).toBeNull();
    expect(parseHookStdout('{"action":"deny","reason":"block","updatedInput":{}}', event)).toBeNull();
  });

  it("accepts permission replacement inside the decision and requires an allow", () => {
    const output = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { operation: "write" } } } };
    expect(parseHookStdout(JSON.stringify(output), "perm")).toMatchObject({ updatedInput: { operation: "write" } });
    output.hookSpecificOutput.decision.behavior = "deny";
    expect(parseHookStdout(JSON.stringify(output), "perm")).toBeNull();
  });

  it("caps context before escaping and attributes the exact hook identity", async () => {
    const manager = new ScriptHookManager();
    const entries = parseHookConfig({ hooks: { PreToolUse: [{ matcher: "influence_probe", hooks: [{ type: "command", command: ["node", COMMAND, "context"] }] }] } }).entries;
    manager.setTrustedRegistry([], entries);
    const result = await manager.runPreToolUse(PAYLOAD);
    expect(result.decision).toBe("allow");
    expect(result.results[0].additionalContext).toHaveLength(MAX_HOOK_CONTEXT_CHARS);
    expect(result.results[0].matcher).toBe("influence_probe");
    const wrapped = attributedHookContext(result.results[0]);
    expect(wrapped).toContain('source="hook" event="pre"');
    expect(wrapped).toContain(`identity="${result.results[0].commandIdentity}"`);
    expect(wrapped).toContain("&lt;/system-reminder&gt;&lt;untrusted&gt;");
    expect(wrapped?.match(/<\/system-reminder>/gu)).toHaveLength(1);
  });

  it("composes replacement input for later hooks while preserving denial precedence", async () => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], parseHookConfig({ hooks: { PreToolUse: [{ hooks: [
      { type: "command", command: ["node", COMMAND, "mutate"] },
      { type: "command", command: ["node", COMMAND, "loop"] },
    ] }] } }).entries);
    expect(await manager.runPreToolUse(PAYLOAD)).toMatchObject({ decision: "allow", updatedInput: { count: 1 } });
  });
});

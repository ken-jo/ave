import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { createHookCommandAuthorizer } from "../../hooks/hook-command-policy.js";
import { parseHookConfig } from "../../hooks/hook-config.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

function setup(event: string, errored = false, denied = false) {
  const root = mkdtempSync(join(tmpdir(), "ave-executor-hook-contract-"));
  roots.push(root);
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => ({ output: errored ? "tool failed" : "tool completed", isError: errored }));
  registry.register(createDynamicTool({ name: "contract_probe", description: "Reads a bounded probe result",
    source: "builtin", category: "read", isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} }, execute }));
  const permissions = new PermissionManager(join(root, "permissions.json"));
  permissions.setRules([{ pattern: "contract_probe", action: denied ? "deny" : "allow" }, { pattern: "Bash(node *)", action: "allow" }]);
  const manager = new ScriptHookManager();
  const requestAndWait = vi.fn(async () => ({ requestId: "hook", choice: "allow-once" as const }));
  const authorizeCommand = vi.fn(createHookCommandAuthorizer({ permissionManager: permissions,
    approvalGate: { requestAndWait } }));
  manager.setCommandAuthorizer(authorizeCommand);
  manager.setTrustedRegistry([], parseHookConfig({ hooks: { [event]: [{ hooks: [{ type: "command", command: ["node", COMMAND, "block"] }] }] } }).entries);
  const executor = new ToolExecutor(registry, undefined, permissions, undefined, undefined, manager);
  return { execute, authorizeCommand, requestAndWait, run: () => executor.executeAll([{ id: "contract-tool", name: "contract_probe", input: {} }],
    { sessionId: "contract-session", permissionContext: userPermissionContext() }) };
}

describe("user hook model feedback and permission precedence", () => {
  it("returns exit-2 stderr to the model before the tool can execute", async () => {
    const probe = setup("PreToolUse");
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Policy requires a focused correction before proceeding.");
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
  });

  it.each(["PostToolUse", "PostToolUseFailure"])("returns %s stderr after preserving the tool outcome", async (event) => {
    const errored = event === "PostToolUseFailure";
    const probe = setup(event, errored);
    const [result] = await probe.run();
    expect(result.is_error === true).toBe(errored);
    expect(result.content).toContain(errored ? "tool failed" : "tool completed");
    expect(result.content).toContain("Policy requires a focused correction before proceeding.");
    expect(probe.execute).toHaveBeenCalledOnce();
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
  });

  it("keeps an upstream permission deny above hook execution", async () => {
    const probe = setup("PreToolUse", false, true);
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.authorizeCommand).not.toHaveBeenCalled();
    expect(probe.requestAndWait).not.toHaveBeenCalled();
  });
});

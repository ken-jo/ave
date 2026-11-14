import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { parseHookConfig } from "../../hooks/hook-config.js";
import { buildHookRegistry } from "../../hooks/hook-registry.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import type { ApprovalGate } from "../../permissions/approval-gate.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/influence-command.cjs");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTmpDir(root); });

function setup(event: "PreToolUse" | "PermissionRequest", mode = "mutate") {
  const root = mkdtempSync(join(tmpdir(), "ave-hook-mutation-"));
  roots.push(root);
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => ({ output: "completed", isError: false }));
  registry.register(createDynamicTool({ name: "mutation_probe", description: "Performs a bounded operation", source: "builtin", category: "read",
    categoryForInput: (input) => (input as { operation?: string }).operation === "write" ? "write" : "read",
    isReadOnly: (input) => (input as { operation?: string }).operation !== "write",
    jsonSchema: { type: "object", properties: {} }, execute }));
  const permissions = new PermissionManager(join(root, "permissions.json"));
  if (event === "PermissionRequest") permissions.setRules([{ pattern: "mutation_probe", action: "ask" }]);
  const manager = new ScriptHookManager();
  manager.setTrustedRegistry([], parseHookConfig({ hooks: { [event]: [{ hooks: [{ type: "command", command: ["node", COMMAND, mode] }] }] } }).entries);
  const requestAndWait = vi.fn(async (_request: { args?: Record<string, unknown> }) => ({ requestId: "target", choice: "deny-once" as const }));
  const executor = new ToolExecutor(registry, undefined, permissions, undefined, { requestAndWait } as unknown as ApprovalGate, manager);
  const pre = vi.spyOn(manager, "runPreToolUse");
  const permission = vi.spyOn(manager, "runPermissionRequest");
  return { root, manager, execute, requestAndWait, pre, permission, run: () => executor.executeAll([{ id: "mutated-call", name: "mutation_probe", input: {} }], {
    sessionId: "mutation-session", executionCwd: root, permissionContext: userPermissionContext(),
  }) };
}

describe("hook replacement permission reentry", () => {
  it("resolves project hooks using the host session root throughout pre and permission stages", async () => {
    const probe = setup("PermissionRequest");
    probe.manager.setTrustedRegistry([], []);
    const projectEntries = buildHookRegistry([], parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", COMMAND, "context"] }] }] } }).entries);
    const resolveProject = vi.fn(async (_cwd: string) => projectEntries);
    probe.manager.setProjectHookResolver(resolveProject);
    const [result] = await probe.run();
    expect(resolveProject).toHaveBeenCalled();
    expect(resolveProject.mock.calls.every(([cwd]) => cwd === probe.root)).toBe(true);
    expect(result.content).toContain('event="pre"');
    expect(result.content).toContain("&lt;untrusted&gt;");
  });

  it("classifies a pre-hook replacement as a write and asks instead of using the read allow", async () => {
    const probe = setup("PreToolUse");
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.requestAndWait).toHaveBeenCalled();
    expect(probe.requestAndWait.mock.calls[0][0]).toMatchObject({ args: { operation: "write" } });
    expect(result.content).toContain('source="hook"');
    expect(result.content).toContain("Arguments changed by the reviewed hook.");
  });

  it("bounds changing replacements before any target execution", async () => {
    const probe = setup("PreToolUse", "loop");
    const [result] = await probe.run();
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("could not safely restart") });
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.requestAndWait).not.toHaveBeenCalled();
  });

  it("restarts pre-hooks and classification after permission-hook mutation before showing the changed approval", async () => {
    const probe = setup("PermissionRequest");
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.pre).toHaveBeenCalledTimes(2);
    expect(probe.permission).toHaveBeenCalledTimes(2);
    expect(probe.permission.mock.calls[0][0]).toMatchObject({ category: "read", input: {} });
    expect(probe.permission.mock.calls[1][0]).toMatchObject({ category: "write", input: { operation: "write" } });
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
    expect(probe.requestAndWait.mock.calls[0][0]).toMatchObject({ args: { operation: "write" } });
  });
});

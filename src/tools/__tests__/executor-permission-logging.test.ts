import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { watchPermissionEvents } from "../../__tests__/support/permission-events.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { RULE_PROVENANCE } from "../../permissions/decision-provenance.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";

const CANARY = "NESTED_SECRET_CANARY_ba5c1a";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ave-permission-log-"));
  roots.push(root);
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => ({ output: CANARY, isError: false }));
  for (const name of ["allowed_tool", "denied_tool"]) {
    registry.register(createDynamicTool({
      name, description: "fixture", category: "read", source: "builtin",
      isReadOnly: () => true, jsonSchema: { type: "object" }, execute,
    }));
  }
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.checkDetailed = (name) => name === "denied_tool"
    ? { decision: "deny", provenance: RULE_PROVENANCE, reason: CANARY }
    : { decision: "allow", provenance: RULE_PROVENANCE, reason: CANARY };
  return { executor: new ToolExecutor(registry, undefined, manager), execute };
}

const opts = { sessionId: "permission-session", permissionContext: { trustOrigin: "user-keyboard" } } as const;

it("logs one decision per attempt without recording nested arguments, output, or reasons", async () => {
  const { executor, execute } = fixture();
  const records: Record<string, unknown>[] = [];
  watchPermissionEvents((entry) => {
    if (entry.event === "permission_decision") records.push(entry);
  });
  const result = await executor.executeAll([
    { id: "allow-1", name: "allowed_tool", input: { nested: { authorization: CANARY } } },
    { id: "deny-1", name: "denied_tool", input: { nested: { command: CANARY } } },
  ], opts);
  expect(result.map((row) => row.is_error ?? false)).toEqual([false, true]);
  expect(execute).toHaveBeenCalledOnce();
  expect(records).toHaveLength(2);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolUseId: "allow-1", decision: "allow", category: "read" }),
    expect.objectContaining({ toolUseId: "deny-1", decision: "deny", terminalKind: "denied" }),
  ]));
  expect(JSON.stringify(records)).not.toContain(CANARY);
});

it("does not change execution or repeat an effect when the logger throws", async () => {
  const { executor, execute } = fixture();
  const failing = vi.fn(() => { throw new Error("sink unavailable"); });
  watchPermissionEvents(failing);
  const result = await executor.executeAll([{ id: "allow-1", name: "allowed_tool", input: {} }], opts);
  expect(result[0]).toMatchObject({ tool_use_id: "allow-1", content: CANARY });
  expect(result[0]?.is_error).not.toBe(true);
  expect(execute).toHaveBeenCalledOnce();
  expect(failing).toHaveBeenCalledWith(expect.objectContaining({ event: "permission_decision", decision: "allow" }));
});

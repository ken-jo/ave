import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { drainToolInvocationAuditForExit } from "../invocation-ledger.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { parseHookConfig } from "../../hooks/hook-config.js";
import { bindHookConfigPaths } from "../../hooks/hook-config-trust.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { answeredApprovalDecision } from "../../__tests__/support/answering-approval-gate.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import type { ApprovalGate, ApprovalRequestInput } from "../../permissions/approval-gate.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/influence-command.cjs");
const TOOL = "denial_probe";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTmpDir(root); });

type Source = "rule" | "human" | "hook-mutation" | "host" | "integrity" | "deadline";

async function setup(source: Source) {
  const root = mkdtempSync(join(tmpdir(), "ave-denial-lock-"));
  roots.push(root);
  const audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain("ef".repeat(32));
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  let started!: () => void;
  const running = new Promise<void>((done) => { started = done; });
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: TOOL, description: "Performs a bounded operation", source: "builtin", category: "read",
    categoryForInput: (input) => (input as { operation?: string }).operation === "write" ? "write" : "read",
    isReadOnly: (input) => (input as { operation?: string }).operation !== "write",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      started();
      if (source === "deadline") await held;
      return { output: "completed", isError: false };
    } }));
  const permissions = new PermissionManager(join(root, "permissions.json"));
  if (source === "rule") permissions.setRules([{ pattern: TOOL, action: "deny" }]);
  if (source === "human" || source === "host" || source === "integrity") permissions.setRules([{ pattern: TOOL, action: "ask" }]);
  const hooks = new ScriptHookManager();
  if (source === "hook-mutation") {
    const entries = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", COMMAND, "loop"] }] }] } }).entries;
    bindHookConfigPaths(entries, dirname(COMMAND));
    hooks.setTrustedRegistry([], entries);
  }
  const lifecycle = vi.spyOn(hooks, "runLifecycleEvent");
  // human: the desk denies this call; host: an allow settled for another call; integrity: a deny settled for another call.
  const requestAndWait = vi.fn(async (request: ApprovalRequestInput) => answeredApprovalDecision(
    { requestId: request.id, choice: source === "host" ? "allow-once" : "deny-once" }, "desk", request.toolName,
    source === "human" ? request.invocationToolUseId : "another-call"));
  const executor = new ToolExecutor(registry, undefined, permissions, undefined, { requestAndWait } as unknown as ApprovalGate, hooks, audit);
  const run = () => executor.executeAll([{ id: "denied-call", name: TOOL, input: {} }], {
    sessionId: "denial-session", executionCwd: root, permissionContext: userPermissionContext(),
  });
  const rows = () => readFileSync(audit.getPermissionAuditLogFile(), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.toolUseId === "denied-call" && row.decision !== "ask");
  const denials = () => lifecycle.mock.calls.filter(([event]) => event === "PermissionDenied");
  return { audit, run, rows, denials, running, release };
}

async function expectOneDenial(probe: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await vi.waitFor(() => expect(probe.rows()).toHaveLength(1));
  await vi.waitFor(() => expect(probe.denials()).toHaveLength(1));
  await new Promise<void>((done) => setImmediate(done));
  expect(probe.rows()).toEqual([expect.objectContaining({ decision: "deny" })]);
  expect(probe.denials()).toEqual([["PermissionDenied", "denial-session", "user-keyboard",
    expect.objectContaining({ toolName: TOOL, denyReason: expect.objectContaining({ source: "tool-executor" }) }), expect.anything()]]);
}

describe("one deny row fires one PermissionDenied for every deny source", () => {
  it.each(["rule", "human", "hook-mutation", "host", "integrity"] as const)("%s", async (source) => {
    const probe = await setup(source);
    try {
      await probe.run().catch(() => undefined);
      await expectOneDenial(probe);
    } finally {
      await probe.audit.close();
    }
  });

  // Runs last: the exit drain closes this file's ledger.
  it("deadline", async () => {
    const probe = await setup("deadline");
    try {
      const result = probe.run().catch(() => undefined);
      await probe.running;
      expect(await drainToolInvocationAuditForExit(() => probe.audit.close(), 5_000)).toBe("committed");
      await expectOneDenial(probe);
      expect(probe.rows()).toEqual([expect.objectContaining({ denyReasons: [expect.objectContaining({ reason: "host-shutdown" })] })]);
      probe.release();
      await result;
      await new Promise<void>((done) => setImmediate(done));
      expect(probe.denials()).toHaveLength(1);
    } finally {
      probe.release();
      await probe.audit.close();
    }
  });
});

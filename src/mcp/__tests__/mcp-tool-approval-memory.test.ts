import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mcpToolToTool } from "../mcp-tool-adapter.js";
import type { McpToolSchema } from "../types.js";
import { approvalIdentityFor } from "../../tools/pipeline/display-mask.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { wireJudgeForTest } from "../../__tests__/support/reviewer-judge.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { approvalCacheKeyIdentity, recordApproval, __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { ToolPermissionContext } from "../../tools/executor-contract.js";
import type { Tool } from "../../tools/base.js";

function schema(name = "update"): McpToolSchema {
  return { name, description: "Changes a catalog item", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
}
function tool(serverId = "catalog", rawName = "update") {
  const call = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ text: String(args.value) }));
  return { tool: mcpToolToTool(serverId, `mcp_${serverId}_${rawName}`, schema(rawName), call), call };
}

describe("external tool remembered identity", () => {
  it("covers different arguments of exactly one server and tool", async () => {
    const first = tool();
    const one = await approvalIdentityFor(first.tool, { value: "first" }, "/workspace");
    const two = await approvalIdentityFor(first.tool, { value: "second" }, "/workspace");
    expect(one).toEqual(two);
    expect(one.approvalCacheKey).toBe('mcp_catalog_update:["catalog","update"]');
    expect(one.approvalMemory).toMatchObject({ kind: "key", scope: { kind: "mcp-tool", serverId: "catalog", toolName: "update" } });
    expect(await approvalIdentityFor(tool("other").tool, { value: "first" }, "/workspace")).not.toEqual(one);
    expect(await approvalIdentityFor(tool("catalog", "delete").tool, { value: "first" }, "/workspace")).not.toEqual(one);
  });

  it("keeps tuple identities unambiguous and freezes discovery identity before execution", async () => {
    const original = schema("original");
    const call = vi.fn(async () => ({ text: "ok" }));
    const registered = mcpToolToTool("catalog", "mcp_catalog_original", original, call);
    original.name = "replacement";
    expect(registered.approvalMemoryScope?.({})).toEqual({ kind: "mcp-tool", serverId: "catalog", toolName: "original" });
    await registered.execute({ value: "first" }, { cwd: "/workspace", extraAllowedDirectories: [], metadata: {} });
    expect(call).toHaveBeenCalledWith("original", { value: "first" });
    const left = mcpToolToTool("a:b", "entry", schema("c"), call);
    const right = mcpToolToTool("a", "entry", schema("b:c"), call);
    expect(left.approvalCacheKey?.({})).not.toBe(right.approvalCacheKey?.({}));
  });

  it("rejects an execution scope from another tool or server", async () => {
    const entry = tool();
    const result = await entry.tool.execute({ value: "first" }, { cwd: "/workspace", extraAllowedDirectories: [], metadata: { approvalMemoryScope: { kind: "mcp-tool", serverId: "other", toolName: "update" } } });
    expect(result.isError).toBe(true);
    expect(entry.call).not.toHaveBeenCalled();
  });

  it("rejects a tool scope declared by a different source or live server", async () => {
    const entry = tool();
    await expect(approvalIdentityFor({ ...entry.tool, source: "plugin" }, { value: "first" }, "/workspace")).rejects.toThrow("does not match the registered tool");
    await expect(approvalIdentityFor({ ...entry.tool, mcpServerId: "other" }, { value: "first" }, "/workspace")).rejects.toThrow("does not match the registered tool");
  });

  it("retains read-only hint behavior while using the same explicit tool identity", () => {
    const readonlySchema = { ...schema("list"), annotations: { readOnlyHint: true } };
    const registered = mcpToolToTool("catalog", "mcp_catalog_list", readonlySchema, async () => ({ text: "ok" }));
    expect(registered.mcpReadOnlyHint).toBe(true);
    expect(registered.approvalMemoryScope?.({})).toEqual({ kind: "mcp-tool", serverId: "catalog", toolName: "list" });
  });
});

describe("external tool per-tool approval execution", () => {
  let root: string;
  let audit: AuditLogger;
  let manager: PermissionManager;
  let gate: ApprovalGate;
  const sessionId = "tool-memory-conversation";
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "ave-external-tool-memory-")));
    vi.stubEnv("AVE_HOME", join(root, "state"));
    __resetSessionStoreForTest();
    audit = new AuditLogger(join(root, "audit"));
    manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("default");
    wireJudgeForTest(manager);
  });
  afterEach(async () => {
    gate?.disposeAll();
    await audit.close();
    __resetSessionStoreForTest();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function harness(tools: Tool[], scope: "once" | "session" | "persistent" | "global" = "session") {
    const registry = new ToolRegistry();
    for (const entry of tools) registry.register(entry);
    const cards: ApprovalRequest[] = [];
    const recordings: Promise<void>[] = [];
    const surface = {
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel !== "ave:approval:request") return;
        cards.push(request);
        recordings.push((async () => {
          try {
            const snapshot = gate.getRequestSnapshot(request.id)!;
            if (scope !== "once" && snapshot.persistentAllowAllowed) {
              await recordApproval(snapshot.toolName, canonicalStringify(snapshot.args), snapshot.source, {
                decision: "allow", scope,
                ...(scope === "session" ? { sessionId: snapshot.sessionId } : scope === "persistent" ? { projectCwd: root } : {}),
                verdictAtApproval: snapshot.verdictAtApproval,
                nlJustification: null,
                trustOrigin: snapshot.trustOrigin,
                approvalCacheKey: approvalCacheKeyIdentity(snapshot.approvalCacheKey, snapshot.approvalMemory),
                workingDirectoryIdentity: snapshot.workingDirectoryIdentity,
              });
            }
          } finally {
            gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, surface as never);
          }
        })());
      },
    };
    gate = new ApprovalGate(surface as never);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, audit);
    const run = async (name: string, value: string, context: Partial<ToolPermissionContext> = {}) => {
      const [result] = await executor.executeAll([{ id: randomUUID(), name, input: { value } }], {
        sessionId, executionCwd: root,
        permissionContext: { trustOrigin: "user-keyboard", additionalDirectories: [root], ...context },
      });
      await Promise.all(recordings);
      return result;
    };
    return { run, cards };
  }

  it.each(["session", "persistent", "global"] as const)("reuses a %s tool approval for different arguments", async (scope) => {
    const entry = tool();
    const { run, cards } = harness([entry.tool], scope);
    expect((await run(entry.tool.name, "first")).is_error).not.toBe(true);
    expect((await run(entry.tool.name, "second")).is_error).not.toBe(true);
    expect(cards).toHaveLength(1);
    expect(entry.call).toHaveBeenNthCalledWith(1, "update", { value: "first" });
    expect(entry.call).toHaveBeenNthCalledWith(2, "update", { value: "second" });
  });

  it.each(["strict", "auto"] as const)("uses explicit tool consent before further review in %s mode", async (mode) => {
    manager.setMode(mode);
    const dispatch = vi.spyOn(manager, "dispatchReviewer");
    const entry = tool();
    const { run, cards } = harness([entry.tool]);
    await run(entry.tool.name, "first");
    const initialReviews = dispatch.mock.calls.length;
    expect((await run(entry.tool.name, "second")).is_error).not.toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(initialReviews);
    expect(cards).toHaveLength(1);
  });

  it("uses the existing tool consent when the next call has no approver", async () => {
    const entry = tool();
    const { run, cards } = harness([entry.tool]);
    await run(entry.tool.name, "first");
    expect((await run(entry.tool.name, "second", { headless: true })).is_error).not.toBe(true);
    expect(cards).toHaveLength(1);
    expect(entry.call).toHaveBeenCalledTimes(2);
  });

  it.each(["current-key", "legacy-keyless"] as const)("keeps a %s exact denial ahead of a remembered tool approval", async (keyMode) => {
    const entry = tool();
    const { run, cards } = harness([entry.tool]);
    await run(entry.tool.name, "first");
    const identity = await approvalIdentityFor(entry.tool, { value: "second" }, root);
    await recordApproval(entry.tool.name, canonicalStringify({ value: "second" }), "mcp", { decision: "deny", scope: "persistent", verdictAtApproval: "high", nlJustification: null, trustOrigin: "user-keyboard", approvalCacheKey: keyMode === "legacy-keyless" ? undefined : approvalCacheKeyIdentity(identity.approvalCacheKey, { kind: "args" }) });
    expect((await run(entry.tool.name, "second")).is_error).toBe(true);
    expect(cards).toHaveLength(1);
    expect(entry.call).toHaveBeenCalledOnce();
    expect((await run(entry.tool.name, "third")).is_error).not.toBe(true);
    expect(cards).toHaveLength(1);
    expect(entry.call).toHaveBeenCalledTimes(2);
  });

  it("keeps allow-once limited to the current invocation", async () => {
    const entry = tool();
    const { run, cards } = harness([entry.tool], "once");
    await run(entry.tool.name, "first");
    await run(entry.tool.name, "second");
    expect(cards).toHaveLength(2);
  });

  it("does not reuse consent across another tool or another server", async () => {
    const entries = [tool(), tool("other"), tool("catalog", "delete")];
    const { run, cards } = harness(entries.map((entry) => entry.tool));
    for (const entry of entries) await run(entry.tool.name, "value");
    expect(cards).toHaveLength(3);
  });

  it("still blocks a deny rule added after the tool was approved", async () => {
    const entry = tool();
    const { run, cards } = harness([entry.tool]);
    await run(entry.tool.name, "first");
    manager.setRules([{ pattern: entry.tool.name, action: "deny" }]);
    expect((await run(entry.tool.name, "second")).is_error).toBe(true);
    expect(cards).toHaveLength(1);
    expect(entry.call).toHaveBeenCalledOnce();
  });

  it("retains explicit ask and mandatory one-time floors before remembered consent", async () => {
    const entry = tool();
    const { run, cards } = harness([entry.tool]);
    await run(entry.tool.name, "first");
    manager.setRules([{ pattern: entry.tool.name, action: "ask" }]);
    await run(entry.tool.name, "second");
    expect(cards).toHaveLength(2);
    manager.setRules([]);
    await run(entry.tool.name, "third", { floor: { code: "other-principal", reason: "Another principal requires one-time approval" } });
    expect(cards).toHaveLength(3);
    expect(cards[2].requireExplicit).toBe(true);
    expect(cards[2].allowedChoices).toEqual(["allow-once", "deny-once"]);
  });
});

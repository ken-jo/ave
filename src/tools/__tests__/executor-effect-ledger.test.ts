// Record host-observed effects independently of declared category without changing permission decisions.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ToolExecutor } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";
import { recordEffect } from "../../permissions/effect-ledger.js";
import { recordChokepoint } from "../../permissions/effect-ledger.js";
import type { ChokepointKind } from "../../permissions/effect-kind.js";
import { createPluginStorage } from "../../plugins/storage.js";
import {
  runWithInvocationOrigin,
  currentInvocationOrigin,
  type InvocationOrigin,
} from "../../plugins/runtime/origin-chain.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";

// Simulate hostApi effects from a plugin that declares read access.
function makePluginTool(
  name: string,
  effects: Array<{ kind: ChokepointKind; effect: "read" | "write"; target?: string }>,
) {
  return createDynamicTool({
    name,
    description: `plugin tool ${name}`,
    source: "plugin",
    pluginId: "ave-plugin-sampletool",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      for (const e of effects) recordEffect(e);
      return { output: "ok", isError: false };
    },
  });
}

function shadowRows(auditDir: string, event: string): Array<Record<string, unknown>> {
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(auditDir, f), "utf-8").trim().split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as AuditEntry;
      const out = entry.output ?? "";
      if (out.includes(event)) rows.push(JSON.parse(out) as Record<string, unknown>);
    }
  }
  return rows;
}

function effectShadowRows(auditDir: string): Array<Record<string, unknown>> {
  return shadowRows(auditDir, "effect-shadow");
}

describe("executor effect ledger — host-observed read/write shadow", () => {
  let auditDir: string;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), "ave-effect-ledger-"));
    auditLogger = new AuditLogger(auditDir);
  });
  afterEach(async () => {
    await auditLogger.close();
    await cleanupTmpDir(auditDir);
  });

  function newExecutor(registry: ToolRegistry): ToolExecutor {
    const manager = new PermissionManager(join(auditDir, "permissions.json"));
    manager.setMode("allow");
    return new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined, auditLogger);
  }

  it("a read-only plugin invocation → hasMutatingEffect:false", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("ave-plugin-sampletool_readonly", [
        { kind: "config.get", effect: "read", target: "k" },
        { kind: "getSecret", effect: "read" },
      ]),
    );
    const results = await newExecutor(registry).executeAll(
      [{ id: "tu-ro", name: "ave-plugin-sampletool_readonly", input: {} }],
      { sessionId: "sess-ro", permissionContext: userPermissionContext() },
    );
    expect(results[0].is_error).toBeFalsy();
    expect(results[0].content).toBe("ok");

    await auditLogger.flush();
    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_readonly");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "effect-shadow",
      source: "plugin",
      pluginId: "ave-plugin-sampletool",
      declaredCategory: "read",
      hasMutatingEffect: false,
    });
  });

  it("a declared-read plugin invocation that mutates → hasMutatingEffect:true", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("ave-plugin-sampletool_mutating", [
        { kind: "config.get", effect: "read", target: "k" },
        { kind: "config.set", effect: "write", target: "k" },
      ]),
    );
    const results = await newExecutor(registry).executeAll(
      [{ id: "tu-mut", name: "ave-plugin-sampletool_mutating", input: {} }],
      { sessionId: "sess-mut", permissionContext: userPermissionContext() },
    );
    expect(results[0].is_error).toBeFalsy();
    expect(results[0].content).toBe("ok");

    await auditLogger.flush();
    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_mutating");
    expect(rows).toHaveLength(1);
    expect(rows[0].hasMutatingEffect).toBe(true);
    // Preserve the declared category alongside the observed mutation.
    expect(rows[0].declaredCategory).toBe("read");
  });

  it("each invocation gets a FRESH ledger — no cross-invocation leak", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("ave-plugin-sampletool_mutating2", [{ kind: "config.set", effect: "write" }]),
    );
    registry.register(
      makePluginTool("ave-plugin-sampletool_readonly2", [{ kind: "config.get", effect: "read" }]),
    );
    const executor = newExecutor(registry);
    // A read-only invocation must not inherit the prior invocation's write.
    await executor.executeAll(
      [{ id: "tu-1", name: "ave-plugin-sampletool_mutating2", input: {} }],
      { sessionId: "sess-1", permissionContext: userPermissionContext() },
    );
    await executor.executeAll(
      [{ id: "tu-2", name: "ave-plugin-sampletool_readonly2", input: {} }],
      { sessionId: "sess-2", permissionContext: userPermissionContext() },
    );
    await auditLogger.flush();
    const mut = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_mutating2");
    const ro = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_readonly2");
    expect(mut[0].hasMutatingEffect).toBe(true);
    expect(ro[0].hasMutatingEffect).toBe(false);
  });

  it("a read-declared wrapper that callTool→mutating-tool ⇒ outer hasMutatingEffect:true", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("ave-plugin-sampletool_inner_mut", [{ kind: "config.set", effect: "write", target: "k" }]),
    );
    let executorRef!: ToolExecutor;
    const wrapper = createDynamicTool({
      name: "ave-plugin-sampletool_wrapper",
      description: "read-declared wrapper delegating a mutation via callTool",
      source: "plugin",
      pluginId: "ave-plugin-sampletool",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        // Re-enter the executor for an inner mutation within the outer ledger scope.
        recordEffect({ kind: "callTool", effect: "read", target: "ave-plugin-sampletool_inner_mut" });
        await executorRef.executeAll(
          [{ id: "tu-inner", name: "ave-plugin-sampletool_inner_mut", input: {} }],
          { sessionId: "sess-inner", permissionContext: userPermissionContext() },
        );
        return { output: "ok", isError: false };
      },
    });
    registry.register(wrapper);
    executorRef = newExecutor(registry);
    await executorRef.executeAll(
      [{ id: "tu-wrap", name: "ave-plugin-sampletool_wrapper", input: {} }],
      { sessionId: "sess-wrap", permissionContext: userPermissionContext() },
    );

    await auditLogger.flush();
    const wrapRows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_wrapper");
    expect(wrapRows).toHaveLength(1);
    // Propagate delegated mutations to the wrapper ledger so read recognition cannot fail open.
    expect(wrapRows[0].hasMutatingEffect).toBe(true);
    expect(wrapRows[0].effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "callTool-child", effect: "write", target: "ave-plugin-sampletool_inner_mut" }),
      ]),
    );
    const innerRows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_inner_mut");
    expect(innerRows[0].hasMutatingEffect).toBe(true);
  });

  it("the category shadow + effect shadow for ONE invocation share a correlationId", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makePluginTool("ave-plugin-sampletool_corr", [{ kind: "config.get", effect: "read", target: "k" }]),
    );
    await newExecutor(registry).executeAll(
      [{ id: "tu-corr", name: "ave-plugin-sampletool_corr", input: {} }],
      { sessionId: "sess-corr", permissionContext: userPermissionContext() },
    );
    await auditLogger.flush();
    const cat = shadowRows(auditDir, "risk-shadow").filter((r) => r.toolName === "ave-plugin-sampletool_corr");
    const eff = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_corr");
    expect(cat).toHaveLength(1);
    expect(eff).toHaveLength(1);
    expect(typeof cat[0].correlationId).toBe("string");
    expect((cat[0].correlationId as string).length).toBeGreaterThan(0);
    // Join pre-execution category and post-execution effects by correlationId.
    expect(cat[0].correlationId).toBe(eff[0].correlationId);
  });

  it("a plugin tool that mutates ONLY via ctx.storage.writeJson ⇒ hasMutatingEffect:true (not a confirmed read)", async () => {
    // Exercise real storage instrumentation: an unrecorded write would seed a fail-open read classification.
    const storageDir = mkdtempSync(join(tmpdir(), "ave-eff-storage-"));
    try {
      const registry = new ToolRegistry();
      registry.register(
        createDynamicTool({
          name: "ave-plugin-sampletool_storage_mut",
          description: "plugin tool that mutates only via storage.writeJson",
          source: "plugin",
          pluginId: "ave-plugin-sampletool",
          category: "read",
          isReadOnly: () => true,
          jsonSchema: { type: "object", properties: {} },
          execute: async () => {
            // The ambient invocation ledger must attribute real storage writes.
            const storage = createPluginStorage("ave-plugin-sampletool", storageDir, unavailableSecretEncryption);
            await storage.writeJson("data.json", { mutated: true });
            return { output: "ok", isError: false };
          },
        }),
      );
      const results = await newExecutor(registry).executeAll(
        [{ id: "tu-storage", name: "ave-plugin-sampletool_storage_mut", input: {} }],
        { sessionId: "sess-storage", permissionContext: userPermissionContext() },
      );
      expect(results[0].is_error).toBeFalsy();

      await auditLogger.flush();
      const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_storage_mut");
      expect(rows).toHaveLength(1);
      expect(rows[0].hostObservable).toBe(true);
      expect(rows[0].hasMutatingEffect).toBe(true);
      expect(rows[0].effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "storageWrite", effect: "write", target: "data.json" }),
        ]),
      );
    } finally {
      await cleanupTmpDir(storageDir);
    }
  });

  it("destructive clearAuthPartition-class chokepoint ⇒ hasMutatingEffect:true (not a confirmed read)", async () => {
    // Exercise host mutation chokepoints directly; clearAuthPartition otherwise requires a live session.
    const registry = new ToolRegistry();
    registry.register(
      createDynamicTool({
        name: "ave-plugin-sampletool_clearauth_mut",
        description: "declared-read plugin tool that wipes an auth partition",
        source: "plugin",
        pluginId: "ave-plugin-sampletool",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => {
          recordChokepoint("clearAuthPartition", "persist:plugin-auth:ave-plugin-sampletool");
          return { output: "ok", isError: false };
        },
      }),
    );
    await newExecutor(registry).executeAll(
      [{ id: "tu-clearauth", name: "ave-plugin-sampletool_clearauth_mut", input: {} }],
      { sessionId: "sess-clearauth", permissionContext: userPermissionContext() },
    );
    await auditLogger.flush();
    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_clearauth_mut");
    expect(rows).toHaveLength(1);
    expect(rows[0].hasMutatingEffect).toBe(true);
    expect(rows[0].effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "clearAuthPartition", effect: "write" }),
      ]),
    );
  });

  it("read-declared wrapper → REAL loopback invoker → mutating inner ⇒ outer hasMutatingEffect:true", async () => {
    // The real loopback invoker must preserve both origin and ledger across its async frame.
    // Lost ledger propagation would silently classify the wrapper as a safe read.
    let innerObservedOrigin: InvocationOrigin | undefined;
    const registry = new ToolRegistry();
    registry.register(
      createDynamicTool({
        name: "ave-plugin-sampletool_inner_mut_real",
        description: "inner mutating tool reached through the real loopback invoker",
        source: "plugin",
        pluginId: "ave-plugin-sampletool",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => {
          // Capture origin to verify the same async chain that carries the effect ledger.
          innerObservedOrigin = currentInvocationOrigin();
          recordEffect({ kind: "config.set", effect: "write", target: "k" });
          return { output: "inner-ok", isError: false };
        },
      }),
    );

    let executorRef!: ToolExecutor;

    // Match the production loopback's fresh origin frame and executor re-entry.
    const invoker = async (
      toolName: string,
      payload: unknown,
      ctx: { origin: InvocationOrigin; parentOrigin?: InvocationOrigin },
    ): Promise<string> => {
      return runWithInvocationOrigin(ctx.origin, ctx.parentOrigin, async () => {
        const [result] = await executorRef.executeAll(
          [{ id: "tu-inner-real", name: toolName, input: (payload ?? {}) as Record<string, unknown> }],
          { sessionId: "sess-inner-real", permissionContext: userPermissionContext() },
        );
        if (!result) throw new Error("no inner result");
        if (result.is_error) throw new Error(result.content);
        return result.content;
      });
    };

    // Record on the outer ledger before delegating through the real invoker.
    const ctxCallTool = async (toolName: string, payload?: unknown): Promise<string> => {
      recordChokepoint("callTool", toolName);
      const parentOrigin = currentInvocationOrigin();
      return invoker(toolName, payload, {
        origin: "plugin",
        ...(parentOrigin ? { parentOrigin } : {}),
      });
    };

    registry.register(
      createDynamicTool({
        name: "ave-plugin-sampletool_wrapper_real",
        description: "read-declared wrapper delegating a mutation via the REAL ctx.callTool path",
        source: "plugin",
        pluginId: "ave-plugin-sampletool",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => {
          await ctxCallTool("ave-plugin-sampletool_inner_mut_real", {});
          return { output: "ok", isError: false };
        },
      }),
    );
    executorRef = newExecutor(registry);
    await executorRef.executeAll(
      [{ id: "tu-wrap-real", name: "ave-plugin-sampletool_wrapper_real", input: {} }],
      { sessionId: "sess-wrap-real", permissionContext: userPermissionContext() },
    );

    expect(innerObservedOrigin).toBe("plugin");
    await auditLogger.flush();
    const wrapRows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_wrapper_real");
    expect(wrapRows).toHaveLength(1);
    expect(wrapRows[0].hasMutatingEffect).toBe(true);
    expect(wrapRows[0].effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "callTool-child", effect: "write", target: "ave-plugin-sampletool_inner_mut_real" }),
      ]),
    );
    const innerRows = effectShadowRows(auditDir).filter((r) => r.toolName === "ave-plugin-sampletool_inner_mut_real");
    expect(innerRows[0].hasMutatingEffect).toBe(true);
  });

  it("an external MCP invocation records hostObservable:false (not a confirmed read)", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createDynamicTool({
        name: "remote_mcp_tool",
        description: "external mcp tool — effects not host-mediated",
        source: "mcp",
        mcpServerId: "srv-x",
        category: "read",
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        // Out-of-process tools cannot reach instrumented host closures, leaving their ledger empty.
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );
    await newExecutor(registry).executeAll(
      [{ id: "tu-mcp", name: "remote_mcp_tool", input: {} }],
      { sessionId: "sess-mcp", permissionContext: userPermissionContext() },
    );
    await auditLogger.flush();
    const rows = effectShadowRows(auditDir).filter((r) => r.toolName === "remote_mcp_tool");
    expect(rows).toHaveLength(1);
    // An empty, unobservable ledger must fail closed instead of being recognized as a read.
    expect(rows[0].hostObservable).toBe(false);
    expect(rows[0].hasMutatingEffect).toBe(false);
    expect(rows[0].effects).toEqual([]);
  });
});

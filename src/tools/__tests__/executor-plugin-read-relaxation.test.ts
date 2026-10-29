// Foreground plugin relaxation requires active filesystem containment and gates writes at their effects.
// Standing denies, permission hooks, strict-mode gates, and non-plugin or headless approval lanes remain enforced.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ToolExecutor } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalGate, ApprovalDecision, ApprovalRequest, ApprovalChoice } from "../../permissions/approval-gate.js";
import {
  gateMutatingEffect,
  __resetEffectGrantsForTest,
} from "../../permissions/effect-enforcement.js";
import {
  isActiveSandboxFilesystemContained,
  isActiveSandboxFilesystemContainedForPluginEffects,
  markPluginWorkerWrapped,
  setActiveSandboxCapability,
  unmarkPluginWorkerWrapped,
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";

function makeGate(choice: ApprovalChoice): {
  gate: ApprovalGate;
  requests: Array<Omit<ApprovalRequest, "requireExplicit">>;
} {
  const requests: Array<Omit<ApprovalRequest, "requireExplicit">> = [];
  const gate = {
    requestAndWait: async (
      req: Omit<ApprovalRequest, "requireExplicit">,
    ): Promise<ApprovalDecision> => {
      requests.push(req);
      return { requestId: req.id, choice };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}

function makeTrackedTool(
  spy: { ran: boolean },
  output: string,
  spec: Omit<Parameters<typeof createDynamicTool>[0], "execute" | "jsonSchema"> & { jsonSchema?: object },
): Tool {
  return createDynamicTool({
    pathFields: [],
    jsonSchema: { type: "object", properties: {} },
    ...spec,
    execute: async () => {
      spy.ran = true;
      return { output, isError: false };
    },
  });
}

// Force a pre-execution ask in both flag states to isolate relaxation from category classification.
function makePluginNoEffectTool(
  spy: { ran: boolean },
  ids: { readonly pluginId?: string; readonly workerId?: string } = {},
): Tool {
  const pluginId = ids.pluginId ?? "p-read";
  return makeTrackedTool(spy, "noeffect-ok", {
    name: "plugin_noeffect",
    description: "A plugin tool that performs no host-mediated effect.",
    source: "plugin",
    pluginId,
    ...(ids.workerId ? { workerId: ids.workerId } : {}),
    category: "write",
    isReadOnly: () => false,
  });
}

// Mutation occurs only after the ambient effect gate allows it.
function makePluginWriteTool(
  gate: ApprovalGate,
  flagEnabled: () => boolean,
  state: { mutated: boolean },
): Tool {
  return createDynamicTool({
    name: "plugin_writer",
    description: "A plugin tool that performs a host-mediated write.",
    source: "plugin",
    pluginId: "p-write",
    category: "write",
    pathFields: [],
    isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      await gateMutatingEffect({
        pluginId: "p-write",
        methodPath: "storage.write",
        effect: "write",
        target: "a.txt",
        approvalGate: gate,
        flagEnabled,
      });
      state.mutated = true;
      return { output: "writer-ok", isError: false };
    },
  });
}

// URL egress is a mutating effect; denial must prevent the open even when pre-execution approval is relaxed.
function makePluginOpenUrlTool(
  gate: ApprovalGate,
  flagEnabled: () => boolean,
  state: { opened: boolean },
): Tool {
  return createDynamicTool({
    name: "plugin_opener",
    description: "A plugin tool that opens an external URL.",
    source: "plugin",
    pluginId: "p-open",
    category: "write",
    pathFields: [],
    isReadOnly: () => false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      await gateMutatingEffect({
        pluginId: "p-open",
        methodPath: "openExternalUrl",
        effect: "write",
        target: "https://evil.example",
        approvalGate: gate,
        flagEnabled,
      });
      state.opened = true;
      return { output: "opener-ok", isError: false };
    },
  });
}

// A host-classified read auto-allows at layer 6, bypassing the ask-relaxation block.
function makePluginReadTool(spy: { ran: boolean }): Tool {
  return makeTrackedTool(spy, "reader-ok", {
    name: "plugin_reader",
    description: "A plugin tool the host inspector classifies as a read.",
    source: "plugin",
    pluginId: "p-reader",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: { command: { type: "string" } },
    },
  });
}

function makeMcpTool(spy: { ran: boolean }): Tool {
  return makeTrackedTool(spy, "mcp-ok", {
    name: "mcp_tool",
    description: "An external MCP tool.",
    source: "mcp",
    mcpServerId: "srv-1",
    category: "network",
    isReadOnly: () => false,
  });
}

function makeBuiltinWriteTool(spy: { ran: boolean }): Tool {
  return makeTrackedTool(spy, "builtin-ok", {
    name: "builtin_write",
    description: "A builtin write tool.",
    source: "builtin",
    category: "write",
    isReadOnly: () => false,
  });
}

function makeBuiltinReadTool(spy: { ran: boolean }): Tool {
  return makeTrackedTool(spy, "builtin-read-ok", {
    name: "builtin_read",
    description: "A builtin read tool.",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: { command: { type: "string" } } },
  });
}

function makeExecutor(
  tool: Tool,
  gate: ApprovalGate,
  flagEnabled: () => boolean,
  permMgr = new PermissionManager("/tmp/nonexistent-permissions.json"),
  scriptHookManager?: import("../../hooks/script-hook-manager.js").ScriptHookManager,
  // Relaxation requires both the flag and active filesystem containment; false models degraded or absent confinement.
  sandboxFsContained: (tool: Tool) => boolean = () => true,
): { executor: ToolExecutor; permMgr: PermissionManager } {
  const registry = new ToolRegistry();
  registry.register(tool);
  const executor = new ToolExecutor(
    registry,
    undefined,
    permMgr,
    undefined,
    gate,
    scriptHookManager,
    undefined,
    flagEnabled,
    sandboxFsContained,
  );
  return { executor, permMgr };
}

// PermissionRequest denial must stop relaxed execution before pre/post hooks.
function makeDenyPermHookManager(
  calls: { permRan: boolean },
): import("../../hooks/script-hook-manager.js").ScriptHookManager {
  return {
    runPermissionRequest: async () => {
      calls.permRan = true;
      return { decision: "deny" as const, reason: "operator perm-*.sh deny", results: [] };
    },
  } as unknown as import("../../hooks/script-hook-manager.js").ScriptHookManager;
}

beforeEach(() => {
  __resetEffectGrantsForTest();
});

describe("plugin read-relaxation — FLAG OFF = byte-for-byte unchanged", () => {
  it("flag OFF + foreground + plugin tool → the FULL pre-exec ask is shown (relaxation inert)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => false);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Pre-execution denial must prevent execution while relaxation is disabled.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — FLAG ON + foreground + plugin", () => {
  it("plugin tool with NO mutating effect → NO modal at all, executes to completion", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // No mutating host effect means no effect approval.
    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("noeffect-ok");
  });

  it("plugin tool that reaches a host WRITE chokepoint → NO pre-exec modal, but the effect-gate fires at the mutation (deny → tool error, mutation NOT performed)", async () => {
    const state = { mutated: false };
    const flagEnabled = (): boolean => true;
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginWriteTool(gate, flagEnabled, state),
      gate,
      flagEnabled,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_writer", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Show only effect approval, with no duplicate tool approval.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("agent-action");
    // Effect denial must prevent mutation.
    expect(state.mutated).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("plugin tool that reaches a host WRITE chokepoint + ALLOW at the effect-gate → exactly one effect-gate modal, mutation proceeds", async () => {
    const state = { mutated: false };
    const flagEnabled = (): boolean => true;
    const { gate, requests } = makeGate("allow-once");
    const { executor } = makeExecutor(
      makePluginWriteTool(gate, flagEnabled, state),
      gate,
      flagEnabled,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_writer", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("agent-action");
    expect(state.mutated).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("writer-ok");
  });

  it("plugin tool that calls openExternalUrl (egress) → NO pre-exec modal, the effect-gate fires at the open; deny → URL NOT opened", async () => {
    const state = { opened: false };
    const flagEnabled = (): boolean => true;
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginOpenUrlTool(gate, flagEnabled, state),
      gate,
      flagEnabled,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_opener", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // URL egress must face effect approval and remain unopened on denial.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("agent-action");
    expect(state.opened).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — NOT relaxed (scope guards)", () => {
  it("flag ON + source MCP → NOT relaxed: the pre-exec ask is shown (fail-closed for non-host-observable)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makeMcpTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "mcp_tool", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag ON + source builtin → NOT relaxed: the pre-exec ask is shown", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(makeBuiltinWriteTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "builtin_write", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag ON + HEADLESS plugin tool → NOT relaxed: kept on the existing headless lane (no reviewer → blocked, tool does not execute)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    // Headless mutation without a reviewer must deny rather than relax.
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext({ headless: true }) },
    );

    // Headless calls must not inherit foreground relaxation or show a modal.
    expect(spy.ran).toBe(false);
    expect(requests).toHaveLength(0);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — explicit deny still wins", () => {
  it("flag ON + a standing DENY rule → blocked (never an ask; relaxation cannot fire)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("allow-once");
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    permMgr.setRules([{ pattern: "plugin_noeffect", action: "deny" }]);
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true, permMgr);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(spy.ran).toBe(false);
    expect(requests).toHaveLength(0);
    expect(result.is_error).toBe(true);
  });

  it("flag ON + a PRIOR user deny-always (persisted) → still blocked under relaxation", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("allow-once");
    const dir = mkdtempSync(join(tmpdir(), "ave-relax-deny-"));
    try {
      const permMgr = new PermissionManager(join(dir, "permissions.json"));
      // Persisted user deny-always decisions remain layer-1 denies.
      await permMgr.addAlwaysDeniedPersist("plugin_noeffect");
      const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true, permMgr);

      const [result] = await executor.executeAll(
        [{ id: "t1", name: "plugin_noeffect", input: {} }],
        { sessionId: "s", permissionContext: userPermissionContext() },
      );

      expect(spy.ran).toBe(false);
      expect(requests).toHaveLength(0);
      expect(result.is_error).toBe(true);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("plugin read-relaxation — operator perm-*.sh deny hook is preserved on the relaxed path", () => {
  it("flag ON + foreground + plugin + a perm hook that DENIES → tool is BLOCKED (not relaxed-allowed), no modal", async () => {
    const spy = { ran: false };
    // Allow-once would expose a skipped permission hook by letting the tool run.
    const { gate, requests } = makeGate("allow-once");
    const calls = { permRan: false };
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      makeDenyPermHookManager(calls),
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Permission-hook denial must fail closed before execution or approval.
    expect(calls.permRan).toBe(true);
    expect(spy.ran).toBe(false);
    expect(requests).toHaveLength(0);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — coupled to the OS sandbox FILESYSTEM-CONTAINING the host", () => {
  it("flag ON + sandbox FILESYSTEM-CONTAINED + foreground plugin ask → relaxed (NO modal, tool runs)", async () => {
    // Active filesystem containment enables relaxation.
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => true,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("noeffect-ok");
  });

  it("flag ON + sandbox NOT filesystem-contained + foreground plugin ask → NOT relaxed: the pre-exec ask is shown, tool NOT auto-allowed", async () => {
    // Without filesystem containment, off-hostApi writes remain uncontained and require pre-execution approval.
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Pre-execution denial must prevent execution without confinement.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag ON + a MUTATING plugin tool + sandbox NOT filesystem-contained → NOT auto-allowed: the pre-exec ask is shown, mutation NOT performed", async () => {
    // Mutating plugins must face pre-execution approval before reaching a write when filesystem confinement is absent.
    const state = { mutated: false };
    const flagEnabled = (): boolean => true;
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginWriteTool(gate, flagEnabled, state),
      gate,
      flagEnabled,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_writer", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Denial before execution must prevent reaching the mutation chokepoint.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(state.mutated).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag OFF + sandbox NOT filesystem-contained → unchanged: the pre-exec ask is shown (relaxation inert regardless of sandbox)", async () => {
    // With relaxation disabled, pre-execution approval is independent of sandbox state.
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => false,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

// Production relaxation requires the specific worker-backed execution substrate to be filesystem-contained.
describe("plugin read-relaxation — confines-aware via the active-capability SOT", () => {
  beforeEach(() => {
    __resetActiveSandboxCapabilityForTest();
  });
  // Host-shell capability is visible only when shell sandboxing was requested at boot.
  beforeEach(() => setShellSandboxRequestedAtBoot(true));
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  it("active capability filesystem-contained (mac/linux full-confine) → relaxed (NO modal, tool runs)", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      isActiveSandboxFilesystemContained,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("noeffect-ok");
  });

  it("generic active capability filesystem-contained (Windows ASRT fs+network partial) → relaxed for the generic provider", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      isActiveSandboxFilesystemContained,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("noeffect-ok");
  });

  it("production plugin provider does not relax a generic Windows capability for an ordinary plugin tool", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      isActiveSandboxFilesystemContainedForPluginEffects,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("production plugin provider relaxes only a matching wrapped worker-backed plugin tool", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    markPluginWorkerWrapped("local-indexer", "embed");
    try {
      const { executor } = makeExecutor(
        makePluginNoEffectTool(spy, { pluginId: "local-indexer", workerId: "embed" }),
        gate,
        () => true,
        new PermissionManager("/tmp/nonexistent-permissions.json"),
        undefined,
        isActiveSandboxFilesystemContainedForPluginEffects,
      );

      const [result] = await executor.executeAll(
        [{ id: "t1", name: "plugin_noeffect", input: {} }],
        { sessionId: "s", permissionContext: userPermissionContext() },
      );

      expect(requests).toHaveLength(0);
      expect(spy.ran).toBe(true);
      expect(result.is_error).toBeFalsy();
      expect(result.content).toContain("noeffect-ok");
    } finally {
      unmarkPluginWorkerWrapped("local-indexer", "embed");
    }
  });

  it("production plugin provider does not relax when workerId mismatches the wrapped worker", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    markPluginWorkerWrapped("local-indexer", "embed");
    try {
      const { executor } = makeExecutor(
        makePluginNoEffectTool(spy, { pluginId: "local-indexer", workerId: "other" }),
        gate,
        () => true,
        new PermissionManager("/tmp/nonexistent-permissions.json"),
        undefined,
        isActiveSandboxFilesystemContainedForPluginEffects,
      );

      const [result] = await executor.executeAll(
        [{ id: "t1", name: "plugin_noeffect", input: {} }],
        { sessionId: "s", permissionContext: userPermissionContext() },
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]?.category).toBe("tool");
      expect(spy.ran).toBe(false);
      expect(result.is_error).toBe(true);
    } finally {
      unmarkPluginWorkerWrapped("local-indexer", "embed");
    }
  });

  it("active capability synthetic NETWORK-ONLY (confines.filesystem === false) → NOT relaxed: pre-exec ask stands, tool NOT auto-allowed", async () => {
    // Network-only confinement cannot contain off-hostApi filesystem writes and must not enable relaxation.
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "synthetic network-only ASRT — network egress contained, no filesystem jail",
      confines: { filesystem: false, process: false, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      isActiveSandboxFilesystemContained,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("no active capability (sandbox inactive, kind none) → NOT relaxed: pre-exec ask stands", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginNoEffectTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      isActiveSandboxFilesystemContained,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

// Foreground plugin reads must also require pre-execution approval without filesystem containment.
// Layer-6 auto-allow bypasses the ask-relaxation block and needs its own containment check.
describe("plugin read auto-allow — coupled to sandbox FILESYSTEM-CONTAINMENT", () => {
  it("flag ON + host-derived plugin read + sandbox FILESYSTEM-CONTAINED → auto-allows (NO modal, tool runs) — macOS/Linux unchanged", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginReadTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => true,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_reader", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Filesystem-contained host-classified reads retain auto-allow.
    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("reader-ok");
  });

  it("flag ON + host-derived plugin read + sandbox NOT filesystem-contained → now ASKS (pre-exec modal, deny → tool NOT run) — the hardening", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginReadTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_reader", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Uncontained off-hostApi effects require pre-execution approval even for host-classified reads.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it("flag ON + host-derived plugin read + sandbox NOT fs-contained + ALLOW at the ask → tool runs (the ask is the gate, not a hard block)", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("allow-once");
    const { executor } = makeExecutor(
      makePluginReadTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_reader", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // This coupling asks the user rather than denying outright.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("reader-ok");
  });

  it("flag OFF + plugin read + sandbox NOT fs-contained → unchanged: auto-allows (NO modal) — flag-OFF byte-for-byte", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginReadTool(spy),
      gate,
      () => false,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_reader", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("reader-ok");
  });

  it("flag ON + BUILTIN read + sandbox NOT fs-contained → unchanged: auto-allows (NO modal) — builtins are host-trusted, not coupled", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makeBuiltinReadTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "builtin_read", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Builtin reads are outside plugin containment coupling.
    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("builtin-read-ok");
  });

  it("flag ON + HEADLESS plugin read + sandbox NOT fs-contained → unchanged: auto-allows (NO modal, tool runs) — coupling is foreground-only", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginReadTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      () => false,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_reader", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext({ headless: true }) },
    );

    // Headless reads retain auto-allow; a bare ask without reviewer routing would hard-deny routine reads.
    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("reader-ok");
  });
});

describe("plugin read auto-allow coupling — confines-aware via the active-capability SOT", () => {
  beforeEach(() => {
    __resetActiveSandboxCapabilityForTest();
  });
  // Host-shell capability is visible only when shell sandboxing was requested at boot.
  beforeEach(() => setShellSandboxRequestedAtBoot(true));
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  it("active capability filesystem-contained (mac/linux full-confine) → plugin read auto-allows (NO modal)", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginReadTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      isActiveSandboxFilesystemContained,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_reader", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    expect(requests).toHaveLength(0);
    expect(spy.ran).toBe(true);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("reader-ok");
  });

  it("active capability synthetic NETWORK-ONLY (confines.filesystem === false) → plugin read now ASKS (NOT silently auto-allowed)", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "synthetic network-only ASRT — network egress contained, no filesystem jail",
      confines: { filesystem: false, process: false, network: true },
    });
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const { executor } = makeExecutor(
      makePluginReadTool(spy),
      gate,
      () => true,
      new PermissionManager("/tmp/nonexistent-permissions.json"),
      undefined,
      isActiveSandboxFilesystemContained,
    );

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_reader", input: { command: "ls" } }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Network-only confinement leaves filesystem effects uncontained and must require read approval.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

describe("plugin read-relaxation — layer ≤ 2 hard gates are NOT relaxed", () => {
  it("flag ON + foreground + plugin + global strict mode (layer 2) → the pre-exec ask is STILL shown, tool NOT relaxed", async () => {
    const spy = { ran: false };
    const { gate, requests } = makeGate("deny-once");
    const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
    // Strict-mode layer-2 asks are hard gates below the relaxation floor and must never be relaxed.
    permMgr.setMode("strict");
    const { executor } = makeExecutor(makePluginNoEffectTool(spy), gate, () => true, permMgr);

    const [result] = await executor.executeAll(
      [{ id: "t1", name: "plugin_noeffect", input: {} }],
      { sessionId: "s", permissionContext: userPermissionContext() },
    );

    // Strict-mode denial must prevent execution despite relaxation.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.category).toBe("tool");
    expect(spy.ran).toBe(false);
    expect(result.is_error).toBe(true);
  });
});

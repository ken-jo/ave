import { describe, expect, it, vi } from "vitest";
import type { BootContext } from "../context.js";
import { assembleAppServices } from "../assemble-services.js";

vi.mock("../../main/auth-window-service.js", () => ({
  clearAuthPartition: vi.fn(),
  forgetTrackedPluginAuthPartitions: vi.fn(),
  getTrackedPluginAuthPartitions: vi.fn(),
}));

describe("assembleAppServices rationale shutdown", () => {
  it("aborts interactive loops (every pane chat's too) and drains teardown after a rationale shutdown failure", async () => {
    const order: string[] = [];
    const mark = (name: string) => () => {
      order.push(name);
    };
    const ctx = {
      disposeRefreshActiveLlmWildcard: mark("active-llm-wildcard"),
      runPluginShutdownHandlers: vi.fn(async () => {
        order.push("plugin-shutdown");
      }),
      disposePluginEventBridge: mark("plugin-event-bridge"),
      preferenceRefreshService: { stop: mark("preference") },
      memoryMaintenanceCoordinator: { stop: mark("memory-maintenance") },
      idleScheduler: { stop: mark("idle") },
      routinesScheduler: { stop: mark("routines") },
      dueSoonTimer: undefined,
      conversationLoop: { abortCurrentTurn: mark("main-abort") },
      sideChatConversationLoop: { abortCurrentTurn: mark("side-abort") },
      paneChatLoops: {
        all: () => [{ abortCurrentTurn: mark("pane-abort-1") }, { abortCurrentTurn: mark("pane-abort-2") }],
      },
      rationaleHostService: {
        shutdown: () => {
          order.push("rationale");
          throw new Error("rationale shutdown failed");
        },
      },
      approvalGate: { disposeAll: mark("approval") },
      askUserQuestionGate: { disposeAll: mark("ask") },
      mcpGovernance: { stopPolicyRefresh: mark("mcp-policy") },
      mcpManager: {
        disconnectAll: vi.fn(async () => {
          order.push("mcp");
        }),
      },
      bootAuditLogger: {
        close: vi.fn(async () => {
          order.push("audit-writer");
        }),
      },
      auditService: {
        stop: vi.fn(async () => {
          order.push("audit");
        }),
      },
      tracing: { shutdown: async () => { order.push("tracing"); } },
      lateBinding: { pluginToolInvokerRef: { fn: undefined } },
    } as unknown as BootContext;

    const services = assembleAppServices(ctx);
    await services.runPluginShutdownHandlers?.();
    const shutdown = services.shutdown();

    await expect(shutdown).rejects.toThrow("application service shutdown failed");
    expect(order).toEqual([
      "active-llm-wildcard",
      "plugin-shutdown",
      "plugin-event-bridge",
      "memory-maintenance",
      "preference",
      "idle",
      "routines",
      "main-abort",
      "side-abort",
      "pane-abort-1",
      "pane-abort-2",
      "rationale",
      "approval",
      "ask",
      "mcp-policy",
      "mcp",
      "audit-writer",
      "audit",
      "tracing",
    ]);
    expect(services.shutdown()).toBe(shutdown);
  });
});

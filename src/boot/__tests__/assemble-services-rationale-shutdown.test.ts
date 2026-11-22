import { describe, expect, it, vi } from "vitest";
import type { BootContext } from "../context.js";
import { assembleAppServices } from "../assemble-services.js";

vi.mock("../../main/auth-window-service.js", () => ({
  clearAuthPartition: vi.fn(),
  forgetTrackedPluginAuthPartitions: vi.fn(),
  getTrackedPluginAuthPartitions: vi.fn(),
}));

const { ledgerOrder } = vi.hoisted(() => ({ ledgerOrder: [] as string[] }));
vi.mock("../../tools/invocation-ledger.js", () => ({
  sealToolInvocations: () => ledgerOrder.push("invocations-seal"),
  joinToolInvocations: async () => { ledgerOrder.push("invocations-join"); },
  markToolInvocationAuditClosed: vi.fn(),
}));

describe("assembleAppServices rationale shutdown", () => {
  it("aborts interactive loops (every pane chat's too) and drains teardown after a rationale shutdown failure", async () => {
    const order = ledgerOrder;
    const mark = (name: string) => () => {
      order.push(name);
    };
    const ctx = {
      disposeRefreshActiveLlmWildcard: mark("active-llm-wildcard"),
      preferenceRefreshService: { stop: mark("preference") },
      memoryMaintenanceCoordinator: { stop: mark("memory-maintenance") },
      memoryCaptureService: { stop: mark("memory-capture") },
      alertsService: { stop: mark("alerts") },
      idleScheduler: { stop: mark("idle") },
      routinesScheduler: { stop: mark("routines") },
      stopWorkBoardDueSoon: undefined,
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
    const shutdown = services.shutdown();

    await expect(shutdown).rejects.toThrow("application service shutdown failed");
    expect(order).toEqual([
      "active-llm-wildcard",
      "memory-maintenance",
      "memory-capture",
      "preference",
      "idle",
      "routines",
      "alerts",
      "main-abort",
      "side-abort",
      "pane-abort-1",
      "pane-abort-2",
      "rationale",
      "invocations-seal",
      "approval",
      "ask",
      "mcp-policy",
      "mcp",
      "invocations-join",
      "audit-writer",
      "audit",
      "tracing",
    ]);
    expect(services.shutdown()).toBe(shutdown);
  });
});

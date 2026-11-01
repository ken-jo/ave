import { describe, expect, it, vi } from "vitest";
import type { ConversationLoop as LoopContext } from "../../conversation-loop.js";
import { gateCrossAgentInterceptedMetaTools } from "../query-loop.js";
import type { ToolUseBlock } from "../../../tools/executor.js";

const tailnetAuthority = Object.freeze({
  kind: "tailnet-controller" as const,
  actorId: "tailnet:controller-digest" as `tailnet:${string}`,
});

function gateSelf(
  requestAndWait = vi.fn(),
  currentAbortController: AbortController | null = null,
) {
  return {
    deps: { approvalGate: { requestAndWait } },
    auditLogger: { log: vi.fn() },
    currentAbortController,
  } as unknown as LoopContext;
}

describe("intercepted meta gate — Tailnet controller", () => {
  it("uses the local meta route for controller operations", async () => {
    const requestAndWait = vi.fn();
    const self = gateSelf(requestAndWait);
    const toolUses: ToolUseBlock[] = [
      { id: "plugin-expand", name: "request_plugin", input: { pluginId: "untrusted" } },
      { id: "tool-expand", name: "tool_search", input: { query: "shell" } },
      { id: "ordinary-read", name: "read_file", input: { path: "README.md" } },
    ];

    const result = await gateCrossAgentInterceptedMetaTools(
      self,
      toolUses,
      undefined,
      "tailnet-surface",
      "tailnet-session",
      tailnetAuthority,
    );

    expect(result.approved).toEqual(toolUses);
    expect(result.denied).toEqual([]);
    expect(requestAndWait).not.toHaveBeenCalled();
  });
});

describe("intercepted meta gate — sub-agent ask", () => {
  it("hands the turn's abort signal to the approval gate", async () => {
    const turn = new AbortController();
    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    }));
    const self = gateSelf(requestAndWait, turn);
    const toolUses: ToolUseBlock[] = [
      { id: "plugin-expand", name: "request_plugin", input: { pluginId: "helper" } },
    ];

    const result = await gateCrossAgentInterceptedMetaTools(
      self,
      toolUses,
      "sub-agent helper",
      "llm-tool-arg",
      "sub-session",
    );

    expect(result.approved).toEqual(toolUses);
    // User stop must cancel the pending approval ask rather than wait for its timeout.
    expect(requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: turn.signal }),
    );
  });
});

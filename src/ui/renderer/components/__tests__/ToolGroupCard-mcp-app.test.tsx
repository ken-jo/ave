/** MCP app payloads must mount their view in both single-tool and grouped-tool cards. */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ToolGroupCard } from "../ToolGroupCard.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

type ToolEntry = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

function makeUiPayloadTool(toolUseId: string, name: string, displayOrder = 0): ToolEntry {
  return {
    toolUseId,
    name,
    displayOrder,
    status: "done",
    input: { foo: "bar" },
    result: "ok",
    uiPayload: {
      serverId: "fake-mcp",
      resourceUri: "ui://fake-mcp/index.html",
      title: "Fake MCP App",
      slot: "chat",
    },
    durationMs: 42,
  };
}

function makePlainTool(toolUseId: string, name: string, displayOrder = 0): ToolEntry {
  return {
    toolUseId,
    name,
    displayOrder,
    status: "done",
    input: {},
    result: "ok",
    durationMs: 10,
  };
}

function makeGroup(tools: ToolEntry[]): Extract<ChatEntry, { kind: "tool_group" }> {
  return {
    kind: "tool_group",
    groupId: "g1",
    groupIds: ["g1"],
    status: "done",
    tools,
  };
}

function renderCard(group: Extract<ChatEntry, { kind: "tool_group" }>) {
  return render(
    <TooltipProvider>
      <ToolGroupCard group={group} />
    </TooltipProvider>,
  );
}

describe("ToolGroupCard × McpAppView — uiPayload mount regression guard", () => {
  beforeEach(() => {
    // `McpAppView` reads `window.ave.mcp.readUiResource` on first effect.
    // Stub it so the lazy fetch resolves to a canned HTML blob; without the
    // stub the component sits in its loading state, which is still enough
    // for the mount-presence assertion below but the stub keeps the test
    // honest by exercising the full effect chain.
    const aveStub = {
      mcp: {
        readUiResource: vi.fn().mockResolvedValue({
          proxyUrl: "ave-mcp-app://abc/proxy.html?t=tok",
          html: "<!doctype html><body>ok</body>",
        }),
      },
    };
    // Don't trample any other window.ave surfaces the renderer setup wires up.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).ave = { ...((window as any).ave ?? {}), mcp: aveStub.mcp };
  });

  afterEach(() => {
    cleanup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).ave;
  });

  // McpAppView renders a `<webview>` tag (Electron) only *after* its async
  // `readUiResource` resolves. In jsdom we don't wait for that resolution —
  // instead we assert on the synchronously-rendered title bar text, which
  // is one-per-McpAppView and proves the component reached mount. This is
  // the regression class that matters: was McpAppView reachable at all?
  function countByTitle(title: string): number {
    return Array.from(document.querySelectorAll("span"))
      .filter((el) => el.textContent === title)
      .length;
  }

  it("single tool with uiPayload mounts McpAppView (regression #256)", () => {
    renderCard(makeGroup([makeUiPayloadTool("call-1", "fake_show_ui")]));
    expect(countByTitle("Fake MCP App")).toBe(1);
  });

  it("multi-tool group with one uiPayload-bearing tool still mounts McpAppView", () => {
    renderCard(
      makeGroup([
        makePlainTool("call-1", "first_tool", 0),
        makeUiPayloadTool("call-2", "fake_show_ui", 1),
        makePlainTool("call-3", "third_tool", 2),
      ]),
    );
    expect(countByTitle("Fake MCP App")).toBe(1);
  });

  it("tool with status=running and pending uiPayload does NOT mount McpAppView", () => {
    const pendingTool: ToolEntry = {
      ...makeUiPayloadTool("call-1", "fake_show_ui"),
      status: "running",
      result: undefined,
    };
    renderCard(makeGroup([pendingTool]));
    expect(countByTitle("Fake MCP App")).toBe(0);
  });

  it("plain tool result without uiPayload mounts no McpAppView", () => {
    renderCard(makeGroup([makePlainTool("call-1", "plain_tool")]));
    expect(countByTitle("Fake MCP App")).toBe(0);
  });

  it("two tools both with uiPayload render TWO McpAppView instances", () => {
    renderCard(
      makeGroup([
        makeUiPayloadTool("call-1", "fake_show_ui_a", 0),
        makeUiPayloadTool("call-2", "fake_show_ui_b", 1),
      ]),
    );
    expect(countByTitle("Fake MCP App")).toBe(2);
  });

  it("renders nothing crashes-worthy when uiPayload field is undefined alongside other tools", () => {
    // Sanity: undefined uiPayload + done status should never throw.
    const tool: ToolEntry = {
      toolUseId: "call-1",
      name: "any_tool",
      displayOrder: 0,
      status: "done",
      result: "fine",
    };
    expect(() => renderCard(makeGroup([tool]))).not.toThrow();
    expect(screen.queryByText("Fake MCP App")).toBeNull();
  });
});

import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToolGroupCard } from "../components/ToolGroupCard.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { t } from "../../../i18n/runtime.js";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { getToolDisplayName } from "../utils/tool-display.js";

vi.mock("../../../components/ui/scroll-area.js", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

function makeTool(overrides: Partial<ToolGroupEntry["tools"][number]> = {}): ToolGroupEntry["tools"][number] {
  return {
    toolUseId: "tu-1",
    name: "read_file",
    input: {},
    status: "done",
    displayOrder: 0,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<ToolGroupEntry> = {}): ToolGroupEntry {
  return {
    kind: "tool_group",
    groupId: "grp-1",
    groupIds: ["grp-1"],
    status: "done",
    tools: [
      makeTool({
        input: { path: "/tmp/test.txt" },
        result: "file content",
      }),
    ],
    ...overrides,
  };
}

/** Multi-tool group (2 tools) — tests group card behavior */
function makeMultiGroup(overrides: Partial<ToolGroupEntry> = {}): ToolGroupEntry {
  return {
    kind: "tool_group",
    groupId: "grp-2",
    groupIds: ["grp-2"],
    status: "done",
    tools: [
      makeTool({ name: "index_search", result: "r1" }),
      makeTool({ toolUseId: "tu-2", result: "r2", displayOrder: 1 }),
    ],
    ...overrides,
  };
}

function installHtmlPreviewWindowMock() {
  const openHtmlPreview = vi.fn(async () => ({ ok: true as const, windowId: 2 }));
  Object.defineProperty(window, "aveApi", {
    configurable: true,
    value: {
      ...(window.aveApi ?? {}),
      window: {
        ...(window.aveApi?.window ?? {}),
        openHtmlPreview,
      },
    },
  });
  return openHtmlPreview;
}

describe("ToolGroupCard", () => {
  it("renders without crashing", () => {
    const { container } = render(<ToolGroupCard group={makeGroup()} />);
    expect(container).toBeTruthy();
  });

  it("single tool: renders tool name inline without group header", () => {
    const { container } = render(<ToolGroupCard group={makeGroup({ status: "done" })} />);
    expect(container.textContent).not.toContain("도구 사용 결과");
    expect(container.textContent).toContain("파일 읽기");
    expect(container.textContent).not.toContain("file content");
  });

  it("shows tool provenance labels for builtin, plugin, and MCP tools", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup({
      tools: [
        makeTool({
          result: "r1",
          source: "builtin",
        }),
        makeTool({
          toolUseId: "tu-2",
          name: "meeting_start",
          result: "r2",
          displayOrder: 1,
          source: "plugin",
          pluginId: "com.example.meeting",
        }),
        makeTool({
          toolUseId: "tu-3",
          name: "mcp_fetch",
          result: "r3",
          displayOrder: 2,
          source: "mcp",
          mcpServerId: "server-1",
        }),
      ],
    })} />);

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    expect(container.textContent).toContain("builtin");
    expect(container.textContent).toContain("plugin:com.example.meeting");
    expect(container.textContent).toContain("mcp:server-1");
  });

  it("single tool running: shows spinner inline", () => {
    const { container } = render(
      <ToolGroupCard group={makeGroup({ status: "running", tools: [makeTool({ status: "running" })] })} />,
    );
    expect(container.textContent).not.toContain("도구 사용 중");
    expect(container.textContent).toContain("파일 읽기");
  });

  it("single tool running: keeps input collapsed by default", () => {
    const { container } = render(
      <ToolGroupCard group={makeGroup({ status: "running", tools: [makeTool({ input: { path: "/tmp/live.txt" }, status: "running" })] })} />,
    );

    expect(container.textContent).toContain("파일 읽기");
    expect(container.textContent).not.toContain("/tmp/live.txt");

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("/tmp/live.txt");
  });

  it("single tool running then done: does not leave result expanded", () => {
    const running = makeGroup({
      status: "running",
      tools: [makeTool({ input: { path: "/tmp/live.txt" }, status: "running" })],
    });
    const done = makeGroup({
      status: "done",
      tools: [makeTool({ input: { path: "/tmp/live.txt" }, result: "live result" })],
    });
    const { container, rerender } = render(<ToolGroupCard group={running} />);

    rerender(<ToolGroupCard group={done} />);

    expect(container.textContent).toContain("파일 읽기");
    expect(container.textContent).not.toContain("live result");
  });

  it("single tool error: shows 실패 badge", () => {
    const group = makeGroup({ status: "error", tools: [makeTool({ result: "err", status: "error" })] });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("실패");
  });

  it("pretty-prints long JSON tool results inside a bounded custom scroll area", () => {
    const result = JSON.stringify({
      url: "https://wttr.in/Seoul?format=j1&lang=ko",
      content: JSON.stringify({
        current_condition: [{ temp_C: "23", lang_ko: [{ value: "맑음" }] }],
        weather: Array.from({ length: 6 }, (_, idx) => ({ date: `2026-05-${String(idx + 1).padStart(2, "0")}` })),
      }),
    });
    const { container } = render(<ToolGroupCard group={makeGroup({ tools: [
      makeTool({ name: "web_fetch", input: { url: "https://wttr.in/Seoul" }, result }),
    ] })} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    expect(container.textContent).toContain('"url": "https://wttr.in/Seoul?format=j1&lang=ko"');
    expect(container.textContent).toContain('"current_condition"');
    expect(container.textContent).not.toContain('\\"current_condition\\"');
    expect(container.querySelector(".h-\\[6\\.9rem\\]")).not.toBeNull();
  });

  it("pretty-prints JSON tool input and output through the shared payload block", () => {
    const result = JSON.stringify({
      ok: true,
      rows: JSON.stringify([{ id: 1, title: "보고서" }]),
    });
    const { container } = render(<ToolGroupCard group={makeGroup({ tools: [
      makeTool({
        toolUseId: "tu-json",
        name: "search_files",
        input: { query: "월간 보고", options: JSON.stringify({ limit: 3, sort: "mtime" }) },
        result,
      }),
    ] })} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    const payloads = Array.from(container.querySelectorAll("[data-testid='tool-payload']"))
      .map((node) => node.textContent ?? "");
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toContain('"options": {');
    expect(payloads[0]).toContain('"limit": 3');
    expect(payloads[1]).toContain('"rows": [');
    expect(payloads[1]).toContain('"title": "보고서"');
    expect(payloads.join("\n")).not.toContain('\\\"limit\\\"');
  });

  it("bounds visually long one-line tool results after wrapping", () => {
    const result = JSON.stringify({
      url: "https://news.google.com/rss/search?q=IT",
      content: "Google News ".repeat(90),
    });
    const { container } = render(<ToolGroupCard group={makeGroup({ tools: [
      makeTool({ name: "web_fetch", input: { url: "https://news.google.com/rss/search?q=IT" }, result }),
    ] })} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);

    expect(container.textContent).toContain("Google News");
    expect(container.querySelector(".h-\\[6\\.9rem\\]")).not.toBeNull();
  });

  it("multi-tool: shows '도구 사용 결과' header", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup({ status: "done" })} />);
    expect(container.textContent).toContain("도구 사용 결과");
    expect(container.textContent).not.toContain("r1");
    expect(container.textContent).not.toContain("r2");
  });

  it("multi-tool: shows '도구 사용 중' header when running", () => {
    const { container } = render(
      <ToolGroupCard group={makeMultiGroup({ status: "running", tools: [
        makeTool({ name: "index_search", status: "running" }),
        makeTool({ toolUseId: "tu-2", status: "running", displayOrder: 1 }),
      ] })} />,
    );
    expect(container.textContent).toContain("도구 사용 중");
  });

  it("multi-tool running: does not auto-expand the first running tool", () => {
    const { container } = render(
      <ToolGroupCard group={makeMultiGroup({ status: "running", tools: [
        makeTool({ name: "index_search", input: { query: "hidden live input" }, status: "running" }),
        makeTool({ toolUseId: "tu-2", status: "running", displayOrder: 1 }),
      ] })} />,
    );

    expect(container.textContent).toContain("도구 사용 중");
    expect(container.textContent).not.toContain("hidden live input");

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("index search");
    expect(container.textContent).not.toContain("hidden live input");
  });

  it("multi-tool: shows tool display names in header", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    expect(container.textContent).toContain("index search");
  });

  it("multi-tool: expands tool list when clicked", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    const headerBtn = container.querySelector("button") as HTMLButtonElement;
    fireEvent.click(headerBtn);
    expect(container.textContent).toContain("index search");
    expect(container.textContent).not.toContain("r1");
  });

  it("multi-tool: expands an individual completed tool only after clicking its row", () => {
    const { container } = render(<ToolGroupCard group={makeMultiGroup()} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).not.toContain("r1");

    const buttons = Array.from(container.querySelectorAll("button"));
    const firstToolButton = buttons.filter((button) => button.textContent?.includes("index search")).at(-1) as HTMLButtonElement | undefined;
    expect(firstToolButton).toBeTruthy();
    fireEvent.click(firstToolButton!);
    expect(container.textContent).toContain("r1");
  });

  it("multi-tool error: shows 오류 있음 badge", () => {
    const group = makeMultiGroup({ status: "error", tools: [
      makeTool({ name: "index_search", result: "err", status: "error" }),
      makeTool({ toolUseId: "tu-2", result: "ok", displayOrder: 1 }),
    ] });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("오류 있음");
  });

  it("single tool done: renders ⏱ duration badge with one decimal second precision", () => {
    const group = makeGroup({
      status: "done",
      tools: [
        makeTool({
          input: { path: "/tmp/test.txt" },
          result: "file content",
          durationMs: 1400,
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    const badge = container.querySelector('[data-testid="tool-duration"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("⏱ 1.4s");
  });

  it("single tool done: shows '<0.1s' for sub-100ms calls", () => {
    const group = makeGroup({
      status: "done",
      tools: [
        makeTool({
          result: "ok",
          durationMs: 50,
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.querySelector('[data-testid="tool-duration"]')?.textContent).toContain("<0.1s");
  });

  it("single tool done: shows minute formatting for >60s calls", () => {
    const group = makeGroup({
      status: "done",
      tools: [
        makeTool({
          result: "ok",
          durationMs: 72_400,
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.querySelector('[data-testid="tool-duration"]')?.textContent).toContain("⏱ 1m 12.4s");
  });

  it("single tool running: hides ⏱ duration badge while pending", () => {
    const group = makeGroup({
      status: "running",
      tools: [
        makeTool({
          status: "running",
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.querySelector('[data-testid="tool-duration"]')).toBeNull();
  });

  it("multi-tool done: renders ⏱ duration badge for each completed tool row", () => {
    const group = makeMultiGroup({
      status: "done",
      tools: [
        makeTool({ name: "index_search", result: "r1", durationMs: 300 }),
        makeTool({ toolUseId: "tu-2", result: "r2", displayOrder: 1, durationMs: 1400 }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    const badges = container.querySelectorAll('[data-testid="tool-duration"]');
    expect(badges.length).toBe(2);
    expect(badges[0]?.textContent).toContain("⏱ 0.3s");
    expect(badges[1]?.textContent).toContain("⏱ 1.4s");
  });

  it("single tool with stub result + sessionId → renders CompactedToolResult (펼치기 visible)", () => {
    const stubResult = "[tool_result stripped: tool=Read, origLen=5000]";
    vi.stubGlobal("aveApi", {
      chatGetVerbatimToolResult: vi.fn(() => new Promise(() => {})), // never resolves — just test render
    });
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-stub",
          input: { path: "/tmp/big.txt" },
          result: stubResult,
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} sessionId="session-1" />);
    // CompactedToolResult renders [펼치기] in collapsed state
    expect(container.textContent).toContain("[펼치기]");
    // Must NOT show raw stub text as-is in a ToolPayloadBlock
    expect(container.textContent).not.toContain("[tool_result stripped:");
  });

  it("single tool with host-truncated stub + sessionId → renders CompactedToolResult", () => {
    const stubResult = "[tool_result truncated by host: tool=long_output_query, toolUseId=tu-truncated, originalLines=180, originalTokens=9000, originalChars=45000, originalBytes=45000. Call read_tool_result_chunk with toolUseId=\"tu-truncated\" and offset=0.]";
    vi.stubGlobal("aveApi", {
      chatGetVerbatimToolResult: vi.fn(() => new Promise(() => {})),
    });
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-truncated",
          name: "long_output_query",
          input: { query: "긴 규정 답변" },
          result: stubResult,
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} sessionId="session-1" />);
    expect(container.textContent).toContain("[펼치기]");
    expect(container.textContent).toContain("45.0K chars");
    expect(container.textContent).not.toContain("[tool_result truncated by host");
  });

  it("single tool with stub result but NO sessionId → renders ToolPayloadBlock (raw stub shown)", () => {
    const stubResult = "[tool_result stripped: tool=Read, origLen=5000]";
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-stub",
          input: { path: "/tmp/big.txt" },
          result: stubResult,
        }),
      ],
    });
    // no sessionId prop → falls back to ToolPayloadBlock
    const { container } = render(<ToolGroupCard group={group} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("[tool_result stripped:");
    expect(container.textContent).not.toContain("[펼치기]");
  });

  it("single tool with non-stub result + sessionId → renders ToolPayloadBlock (not CompactedToolResult)", () => {
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-normal",
          input: { path: "/tmp/small.txt" },
          result: "normal file content",
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} sessionId="session-1" />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("normal file content");
    expect(container.textContent).not.toContain("[펼치기]");
  });

  // Single-tool render_html results must retain the dedicated preview launcher.
  it("single render_html: renders an HTML window launcher", async () => {
    const openHtmlPreview = installHtmlPreviewWindowMock();
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-html-1",
          name: "render_html",
          input: { html: "<p>hi</p>" },
          result: JSON.stringify({
            kind: "ave.render_html",
            title: "차트 미리보기",
            height: 320,
            html: "<p>hi</p>",
            warnings: [],
          }),
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("차트 미리보기");
    expect(container.querySelector("webview")).toBeNull();
    expect(openHtmlPreview).not.toHaveBeenCalled();

    const openButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("창 열기"));
    expect(openButton).toBeTruthy();
    fireEvent.click(openButton as HTMLButtonElement);

    await waitFor(() => expect(openHtmlPreview).toHaveBeenCalledOnce());
    expect(openHtmlPreview).toHaveBeenCalledWith(expect.objectContaining({
      html: "<p>hi</p>",
      title: "차트 미리보기",
      allowScripts: false,
    }));
  });

  it("single render_html running → done: auto-opens the HTML window once", async () => {
    const openHtmlPreview = installHtmlPreviewWindowMock();
    const running = makeGroup({
      status: "running",
      tools: [
        makeTool({
          toolUseId: "tu-html-auto",
          name: "render_html",
          input: { html: "<p>live</p>" },
          status: "running",
        }),
      ],
    });
    const done = makeGroup({
      status: "done",
      tools: [
        makeTool({
          toolUseId: "tu-html-auto",
          name: "render_html",
          input: { html: "<p>live</p>" },
          result: JSON.stringify({
            kind: "ave.render_html",
            title: "자동 미리보기",
            height: 320,
            html: "<p>live</p>",
            warnings: [],
          }),
        }),
      ],
    });
    const { rerender } = render(<ToolGroupCard group={running} />);

    expect(openHtmlPreview).not.toHaveBeenCalled();
    rerender(<ToolGroupCard group={done} />);

    await waitFor(() => expect(openHtmlPreview).toHaveBeenCalledOnce());
    expect(openHtmlPreview).toHaveBeenCalledWith(expect.objectContaining({
      html: "<p>live</p>",
      title: "자동 미리보기",
      allowScripts: false,
    }));
  });

  it("single render_html with <script>: sends JavaScript permission to the preview window", async () => {
    const openHtmlPreview = installHtmlPreviewWindowMock();
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-html-2",
          name: "render_html",
          result: JSON.stringify({
            kind: "ave.render_html",
            height: 200,
            html: "<script>console.log('hi')</script>",
            warnings: [],
          }),
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).not.toContain("JavaScript 허용");
    expect(container.textContent).toContain("JS 창에서 설정");

    const openButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("창 열기"));
    fireEvent.click(openButton as HTMLButtonElement);

    await waitFor(() => expect(openHtmlPreview).toHaveBeenCalledOnce());
    expect(openHtmlPreview).toHaveBeenCalledWith(expect.objectContaining({
      allowScripts: false,
      requiresScripts: true,
    }));
  });

  // File edit diff UI — edit_file / multi_edit / write_file render an inline
  // unified-diff card with theme-adaptive colors. Data comes from `tool.input`
  // for edit/patch (no backend change), and from `ave.write_file` JSON for
  // writes (WriteFileTool captures before-snapshot).
  it("single edit_file: renders FileEditDiff with old and new text", () => {
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-edit",
          name: "edit_file",
          input: {
            path: "src/foo.ts",
            oldText: "const x = 1;\nconst y = 2;",
            newText: "const x = 1;\nconst y = 3;",
          },
          result: JSON.stringify({ path: "src/foo.ts", replacements: 1 }),
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("src/foo.ts");
    expect(container.textContent).toContain(t("fileEditDiff.verbEdit"));
    expect(container.textContent).toContain("const y = 2;");
    expect(container.textContent).toContain("const y = 3;");
    const removed = container.querySelector('[data-diff-kind="removed"]');
    const added = container.querySelector('[data-diff-kind="added"]');
    expect(removed?.className).toContain("text-foreground");
    expect(added?.className).toContain("text-foreground");
    expect(removed?.getAttribute("style")).toContain("--diff-remove");
    expect(added?.getAttribute("style")).toContain("--diff-add");
    expect(removed?.className).not.toContain("text-destructive-foreground");
    expect(added?.className).not.toContain("text-success-foreground");
  });

  it("single multi_edit with 2 replacements: renders 2 hunks", () => {
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-patch",
          name: "multi_edit",
          input: {
            path: "src/bar.ts",
            replacements: [
              { oldText: "alpha", newText: "ALPHA" },
              { oldText: "beta", newText: "BETA" },
            ],
          },
          result: JSON.stringify({ path: "src/bar.ts", replacements: 2 }),
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("src/bar.ts");
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("ALPHA");
    expect(container.textContent).toContain("beta");
    expect(container.textContent).toContain("BETA");
    expect(container.textContent).toContain(t("fileEditDiff.nextHunk"));
  });

  it("single write_file (existing): renders before and after", () => {
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-write-existing",
          name: "write_file",
          input: { path: "src/baz.ts", content: "after\n" },
          result: JSON.stringify({
            kind: "ave.write_file",
            path: "src/baz.ts",
            bytes: 6,
            isNewFile: false,
            truncated: false,
            before: "before\n",
            after: "after\n",
          }),
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain(t("fileEditDiff.verbWrite"));
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  it("single write_file (new file): shows Create verb without before", () => {
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-write-new",
          name: "write_file",
          input: { path: "src/new.ts", content: "hello\n" },
          result: JSON.stringify({
            kind: "ave.write_file",
            path: "src/new.ts",
            bytes: 6,
            isNewFile: true,
            truncated: false,
            after: "hello\n",
          }),
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain(t("fileEditDiff.verbCreate"));
    expect(container.textContent).toContain("hello");
  });

  it("single write_file (truncated): shows truncated marker", () => {
    const group = makeGroup({
      tools: [
        makeTool({
          toolUseId: "tu-write-trunc",
          name: "write_file",
          input: { path: "src/big.ts", content: "x".repeat(10000) },
          result: JSON.stringify({
            kind: "ave.write_file",
            path: "src/big.ts",
            bytes: 10000,
            isNewFile: false,
            truncated: true,
            after: "x".repeat(100),
          }),
        }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain(t("fileEditDiff.truncatedLabel"));
  });
});

describe("ToolGroupCard — failure badges", () => {
  function makeErrorGroup(): ToolGroupEntry {
    return makeGroup({
      status: "error",
      tools: [
        makeTool({ toolUseId: "tu-err", result: "boom", status: "error" }),
      ],
    });
  }

  it("a failed single tool shows the 실패 badge", () => {
    const { container } = render(<ToolGroupCard group={makeErrorGroup()} />);
    expect(container.textContent).toContain("실패");
  });

  it("a successful tool shows 완료", () => {
    const { container } = render(<ToolGroupCard group={makeGroup({ status: "done" })} />);
    expect(container.textContent).toContain("완료");
  });

  it("a group with an error shows the 오류 있음 header badge", () => {
    const group = makeMultiGroup({
      status: "error",
      tools: [
        makeTool({ name: "index_search", result: "r1" }),
        makeTool({ toolUseId: "tu-2", result: "boom", status: "error", displayOrder: 1 }),
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("오류 있음");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ToolGroupCard — tool row header cells", () => {
  type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;
  function makeReview(toolUseId: string, extra: Partial<PermissionReviewEntry> = {}): PermissionReviewEntry {
    return {
      kind: "permission_review",
      status: "auto_approved",
      toolName: "read_file",
      source: "builtin",
      groupId: "grp-1",
      toolUseId,
      displayOrder: 0,
      verdictLevel: "low",
      ...extra,
    };
  }
  /** name → builtin → review chip → status → duration; the name button carries the source badge. */
  const HEADER_CELL_ORDER = ["tool-source", "permission-review-status-card", "tool-status", "tool-duration"];
  function headerCellOrder(header: Element): Array<string | null> {
    return Array.from(header.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid"));
  }

  it("single tool: name → builtin → review chip → status → duration on one wrapping row", () => {
    const base = makeGroup().tools[0]!;
    const group = makeGroup({ tools: [{ ...base, source: "builtin", durationMs: 2300 }] });
    const { getByTestId } = render(
      <ToolGroupCard group={group} permissionReviews={new Map([["tu-1", makeReview("tu-1")]])} />,
    );
    const header = getByTestId("tool-row-header");
    expect(header.className).toContain("flex-wrap");
    expect(headerCellOrder(header)).toEqual(HEADER_CELL_ORDER);

    const nameButton = header.querySelector("button") as HTMLButtonElement;
    expect(nameButton.textContent).toContain(getToolDisplayName("read_file"));
    expect(nameButton.contains(getByTestId("tool-source"))).toBe(true);
    const chip = getByTestId("permission-review-status-card");
    // The chip is a header cell, not a second line under the button.
    expect(chip.parentElement).toBe(header);
    expect(nameButton.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getByTestId("tool-status").textContent).toBe(t("toolGroupCard.done"));
    expect(getByTestId("tool-duration").textContent).toContain("2.3s");
  });

  it("single tool: the name button still toggles the row (click bubbles to the row surface)", () => {
    const { getByTestId, container } = render(
      <ToolGroupCard group={makeGroup()} permissionReviews={new Map([["tu-1", makeReview("tu-1")]])} />,
    );
    const nameButton = getByTestId("tool-row-header").querySelector("button") as HTMLButtonElement;
    expect(nameButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(nameButton);
    expect(nameButton.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("/tmp/test.txt");
  });

  it("grouped tools: every per-tool row uses the same cell order", () => {
    const tools = makeMultiGroup().tools.map((tool) => ({ ...tool, source: "builtin" as const, durationMs: 100 }));
    const reviews = new Map(tools.map((tool) => [tool.toolUseId, makeReview(tool.toolUseId)]));
    const { container, getAllByTestId } = render(
      <ToolGroupCard group={makeMultiGroup({ tools })} permissionReviews={reviews} />,
    );
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    const headers = getAllByTestId("tool-row-header");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.className).toContain("flex-wrap");
      expect(headerCellOrder(header)).toEqual(HEADER_CELL_ORDER);
    }
  });

  it("review chip carries the reviewer rationale as a keyboard-reachable tooltip", async () => {
    const reason = "workspace-local read, no egress";
    const { getByTestId, getByRole } = render(
      <TooltipProvider>
        <ToolGroupCard group={makeGroup()} permissionReviews={new Map([["tu-1", makeReview("tu-1", { reason })]])} />
      </TooltipProvider>,
    );
    const chip = getByTestId("permission-review-status-card");
    expect(chip.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(chip);
    await waitFor(() => expect(getByRole("tooltip").textContent).toBe(reason));
  });

  it("without a recorded rationale the chip is a plain cell — no tooltip, nothing to focus", () => {
    // No TooltipProvider on purpose: a Tooltip mounted here would throw.
    const { getByTestId, queryByRole } = render(
      <ToolGroupCard group={makeGroup()} permissionReviews={new Map([["tu-1", makeReview("tu-1")]])} />,
    );
    const chip = getByTestId("permission-review-status-card");
    expect(chip.hasAttribute("tabindex")).toBe(false);
    expect(chip.hasAttribute("data-state")).toBe(false);
    fireEvent.focus(chip);
    expect(queryByRole("tooltip")).toBeNull();
  });
});

describe("ToolGroupCard browser thumbnails", () => {
  const browserPreview = { dataUrl: "data:image/jpeg;base64,QUdFTlQ=", width: 320, height: 180 };
  const browserTool = (overrides: Partial<ToolGroupEntry["tools"][number]> = {}) =>
    makeTool({ name: "browser_snapshot", result: "outline", browserPreview, ...overrides });

  it("shows a completed browser tool's thumbnail as an image", () => {
    const { getByTestId } = render(<ToolGroupCard group={makeGroup({ tools: [browserTool()] })} />);
    const img = getByTestId("tool-browser-preview");
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe(browserPreview.dataUrl);
  });

  it("shows the latest thumbnail of a collapsed multi-tool group", () => {
    const later = { ...browserPreview, dataUrl: "data:image/jpeg;base64,TEFURVI=" };
    const { getAllByTestId } = render(<ToolGroupCard group={makeGroup({ tools: [
      browserTool({ toolUseId: "tu-1", displayOrder: 0 }),
      browserTool({ toolUseId: "tu-2", displayOrder: 1, browserPreview: later }),
    ] })} />);
    expect(getAllByTestId("tool-browser-preview").map((img) => img.getAttribute("src"))).toEqual([later.dataUrl]);
  });

  it("renders nothing for a non-JPEG payload or an unfinished tool", () => {
    for (const tool of [
      browserTool({ browserPreview: { ...browserPreview, dataUrl: "data:text/html;base64,PHNjcmlwdD4=" } }),
      browserTool({ browserPreview: { ...browserPreview, dataUrl: "javascript:alert(1)" } }),
      browserTool({ status: "running" }),
    ]) {
      const { queryByTestId, unmount } = render(<ToolGroupCard group={makeGroup({ tools: [tool] })} />);
      expect(queryByTestId("tool-browser-preview")).toBeNull();
      unmount();
    }
  });
});

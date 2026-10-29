import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { AssistantCard } from "../components/AssistantCard.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { PaneChatNavigationProvider } from "../context/PaneChatNavigationContext.js";

type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;

function makeEntry(overrides: Partial<AssistantEntry> = {}): AssistantEntry {
  return {
    kind: "assistant",
    text: "line1\nline2\nline3",
    streaming: false,
    ...overrides,
  };
}

function renderCard(entry: AssistantEntry) {
  return render(
    <TooltipProvider>
      <AssistantCard entry={entry} />
    </TooltipProvider>,
  );
}

describe("AssistantCard — slash command newline fix", () => {
  it("does not render an empty streaming placeholder before model text arrives", () => {
    const { container } = renderCard(makeEntry({ text: "", streaming: true }));
    expect(container.querySelector("[data-testid='assistant-message-body']")).toBeNull();
    expect(container.textContent).not.toContain("응답을 작성하는 중");
    expect(container.textContent).not.toMatch(/\bAve\b/);
  });

  it("renders streaming content without a pre-response Ave title", () => {
    const { container } = renderCard(makeEntry({ text: "부분 응답", streaming: true }));
    expect(container.textContent).toContain("부분 응답");
    expect(container.textContent).not.toMatch(/\bAve\b.*RESPONDING|Ave 응답/i);
  });

  it("renders Markdown for route=command entries", () => {
    const { container } = renderCard(makeEntry({ text: "표 제목은 **진하게** 표시", route: "command" }));
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body).not.toBeNull();
    expect(body!.className).toContain("whitespace-pre-wrap");
    const strong = body!.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("진하게");
  });

  it("does NOT apply whitespace-pre-wrap for regular LLM entries (uses ReactMarkdown)", () => {
    const { container } = renderCard(makeEntry());
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body).not.toBeNull();
    expect(body!.className).toContain("overflow-y-visible");
    expect(body!.className).toContain("max-h-none");
    // ReactMarkdown renders a <p> tag; whitespace-pre-wrap div should be absent
    const prewrap = body!.querySelector(".whitespace-pre-wrap");
    expect(prewrap).toBeNull();
  });

  it("renders multi-line command output through Markdown", () => {
    const text = "/help 출력:\n\n- /new — 새 대화\n- /sessions — 목록";
    const { container } = renderCard(makeEntry({ text, route: "command" }));
    expect(container.textContent).toContain("/new — 새 대화");
    expect(container.textContent).toContain("/sessions — 목록");
    expect(container.querySelector("li")).not.toBeNull();
  });

  it("preserves single newlines in plain command output", () => {
    const { container } = renderCard(makeEntry({ text: "line1\nline2\nline3", route: "command" }));
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body!.querySelectorAll("br")).toHaveLength(2);
    expect(body!.textContent).toContain("line1");
    expect(body!.textContent).toContain("line2");
    expect(body!.textContent).toContain("line3");
  });

  it("keeps Markdown rendering when search is active + route=command", () => {
    const { container } = renderCard(
      makeEntry({ text: "표 제목은 **진하게** 표시", route: "command" }),
      "표",
    );
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body!.querySelector("strong")?.textContent).toBe("진하게");
  });

  it("keeps Markdown rendering when search is active + no route", () => {
    const { container } = renderCard(
      makeEntry({ text: "결과는 **정상**입니다." }),
      "결과",
    );
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body!.querySelector("strong")?.textContent).toBe("정상");
  });

  it("renders Korean postposition-adjacent bold markers as Markdown", () => {
    const text = "먼저 **오늘 뉴스 헤드라인**을 **어떤 범위(국내/국제/IT·경제)**로 모을지 확인할게요.";
    const { container } = renderCard(makeEntry({ text }));
    const strongTexts = Array.from(container.querySelectorAll("strong")).map((el) => el.textContent);
    expect(strongTexts).toEqual(["오늘 뉴스 헤드라인", "어떤 범위(국내/국제/IT·경제)"]);
    expect(container.textContent).not.toContain("**");
  });

  it("does NOT strikethrough single-tilde ranges like 7~12℃ (singleTilde:false)", () => {
    const text = "최저 7~12℃ / 최고 14~19℃";
    const { container } = renderCard(makeEntry({ text }));
    expect(container.querySelector("del")).toBeNull();
    expect(container.querySelector("s")).toBeNull();
    expect(container.textContent).toContain("7~12℃");
    expect(container.textContent).toContain("14~19℃");
  });

  it("still renders double-tilde strikethrough ~~text~~ (GFM standard)", () => {
    const text = "this is ~~struck~~ text";
    const { container } = renderCard(makeEntry({ text }));
    const del = container.querySelector("del");
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe("struck");
  });
});

describe("AssistantCard — live vs restored systemNotice (Issue #2113)", () => {
  function cardRoot(container: HTMLElement): HTMLElement {
    const root = container.querySelector<HTMLElement>("div.group");
    expect(root).not.toBeNull();
    return root!;
  }

  it("renders a live stream-error banner with destructive styling and no restored badge", () => {
    const { container } = renderCard(
      makeEntry({ text: "응답 스트림이 끊겼습니다.", systemNotice: "stream-error" }),
    );
    const card = cardRoot(container);
    expect(card.className).toContain("border-destructive");
    expect(card.className).toContain("bg-destructive");
    expect(
      container.querySelector("[data-testid='assistant-restored-notice-badge']"),
    ).toBeNull();
  });

  it("labels a session operation refusal separately from a response stream failure", () => {
    const { container } = renderCard(makeEntry({
      text: "This chat is open in another pane.",
      systemNotice: "operation-error",
    }));
    expect(container.textContent).toContain("시스템 알림 — 요청을 완료할 수 없음");
    expect(container.textContent).not.toContain("응답 스트림 오류");
  });

  it("opens the live pane named by an operation refusal", () => {
    const openPaneChat = vi.fn();
    const { getByRole, container } = render(
      <TooltipProvider>
        <PaneChatNavigationProvider value={{
          resolvePane: (tabId) => tabId === "terminal-tab" ? { tabId: "terminal-tab", name: "터미널 1" } : undefined,
          openPaneChat,
        }}>
          <AssistantCard entry={makeEntry({ systemNotice: "operation-error", noticePaneTabId: "terminal-tab" })} />
        </PaneChatNavigationProvider>
      </TooltipProvider>,
    );
    expect(container.textContent).toContain("이 대화는 터미널 1에 열려 있습니다.");
    expect(container.textContent).not.toContain("line1");
    expect(container.textContent).not.toContain("응답 스트림 오류");
    fireEvent.click(getByRole("button", { name: "열기" }));
    expect(openPaneChat).toHaveBeenCalledExactlyOnceWith("terminal-tab");
  });

  it("offers no pane action after the bound surface has closed", () => {
    const { queryByRole } = render(
      <TooltipProvider>
        <PaneChatNavigationProvider value={{ resolvePane: () => undefined, openPaneChat: vi.fn() }}>
          <AssistantCard entry={makeEntry({ systemNotice: "operation-error", noticePaneTabId: "closed-pane-session" })} />
        </PaneChatNavigationProvider>
      </TooltipProvider>,
    );
    expect(queryByRole("button", { name: "열기" })).toBeNull();
  });

  it("softens a restored stream-error banner and shows the previous-session badge", () => {
    const { container } = renderCard(
      makeEntry({
        text: "응답 스트림이 끊겼습니다.",
        systemNotice: "stream-error",
        restored: true,
      }),
    );
    const card = cardRoot(container);
    // Restored banner must NOT reuse the live destructive treatment — that is exactly what made an old error read as a fresh
    // one on session reload.
    expect(card.className).not.toContain("destructive");
    expect(card.className).toContain("border-border");
    expect(card.className).toContain("bg-muted");
    const badge = container.querySelector(
      "[data-testid='assistant-restored-notice-badge']",
    );
    expect(badge).not.toBeNull();
    expect(badge!.textContent?.trim()).not.toBe("");
  });

  it("restored without a systemNotice renders as a plain assistant card", () => {
    const { container } = renderCard(makeEntry({ restored: true }));
    const card = cardRoot(container);
    expect(card.className).not.toContain("destructive");
    expect(card.className).not.toContain("bg-muted");
    expect(
      container.querySelector("[data-testid='assistant-restored-notice-badge']"),
    ).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AssistantCard — fenced code block header", () => {
  it("labels the fence language and copies the raw block source", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { getByTestId, findByText } = renderCard(
      makeEntry({ text: "Run this:\n\n```ts\nconst a = 1;\nconsole.log(a);\n```\n" }),
    );
    expect(getByTestId("markdown-code-language").textContent).toBe("ts");
    getByTestId("markdown-code-copy").click();
    expect(writeText).toHaveBeenCalledWith("const a = 1;\nconsole.log(a);");
    // "Copied" confirmation only after the clipboard write resolved.
    await findByText(/Copied|복사됨/);
  });

  it("falls back to a plain-text label when the fence names no language", () => {
    const { getByTestId } = renderCard(makeEntry({ text: "```\nplain\n```" }));
    expect(getByTestId("markdown-code-language").textContent).toMatch(/^(text|텍스트)$/);
  });

  it("leaves inline code without a header", () => {
    const { container } = renderCard(makeEntry({ text: "use `npm test` here" }));
    expect(container.querySelector("[data-testid='markdown-code-block']")).toBeNull();
  });
});

describe("AssistantCard — code block syntax highlighting", () => {
  const SOURCE = "const a = 1; // one\nconsole.log(\"hi\", a);";

  it("highlights a known fence once its grammar loads, keeping the header, copy and exact text", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container, getByTestId } = renderCard(makeEntry({ text: "```ts\n" + SOURCE + "\n```\n" }));
    const pre = () => container.querySelector("[data-testid='markdown-code-block'] pre") as HTMLElement;
    const before = pre().textContent;

    await waitFor(() => expect(pre().getAttribute("data-highlighted")).toBe("true"), { timeout: 5000 });
    // Same text — spans recolour only — so nothing reflows or changes on copy.
    expect(pre().textContent).toBe(before);
    expect(pre().querySelector("code")?.className).toContain("language-ts");
    expect(pre().querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(pre().querySelector(".hljs-string")?.textContent).toBe("\"hi\"");
    expect(pre().querySelector(".hljs-comment")?.textContent).toBe("// one");
    // No markup other than classed spans reached the DOM.
    expect(pre().querySelectorAll("code *:not(span)")).toHaveLength(0);
    expect(getByTestId("markdown-code-language").textContent).toBe("ts");
    getByTestId("markdown-code-copy").click();
    expect(writeText).toHaveBeenCalledWith(SOURCE);
  });

  it("leaves a very large fence as plain text", async () => {
    // Warm the grammar on a small block, so the large one is not just waiting for it.
    const small = renderCard(makeEntry({ text: "```ts\n" + SOURCE + "\n```\n" }));
    await waitFor(() => expect(small.container.querySelector("pre")?.getAttribute("data-highlighted")).toBe("true"), { timeout: 5000 });
    small.unmount();

    const big = "const x = 1;\n".repeat(9_000); // ~117 KB
    const { container } = renderCard(makeEntry({ text: "```ts\n" + big + "```\n" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pre = container.querySelector("[data-testid='markdown-code-block'] pre") as HTMLElement;
    expect(pre.getAttribute("data-highlighted")).not.toBe("true");
    expect(pre.querySelector(".hljs-keyword")).toBeNull();
  });

  it("leaves an unknown or missing language as plain text", async () => {
    const { container } = renderCard(makeEntry({ text: "```brainfuck\n+++.\n```\n\n```\nplain\n```" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pres = container.querySelectorAll("[data-testid='markdown-code-block'] pre");
    expect(pres).toHaveLength(2);
    for (const pre of pres) {
      expect(pre.getAttribute("data-highlighted")).toBeNull();
      expect(pre.querySelector("span")).toBeNull();
    }
  });
});

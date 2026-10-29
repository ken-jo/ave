// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarPreviewCard, SidebarPreviewProvider, SidebarPreviewTrigger } from "../SidebarPreview.js";

const conversation = { kind: "conversation" as const, title: "Build review", message: "Updated the build target and verified its output.", modifiedAt: Date.now(), running: true };
function entries(loadPreview?: () => Promise<typeof conversation>) {
  return render(<SidebarPreviewProvider><aside>
    <SidebarPreviewTrigger preview={conversation} loadPreview={loadPreview}><button>Conversation</button></SidebarPreviewTrigger>
    <SidebarPreviewTrigger preview={{ kind: "terminal", title: "Terminal 1 · zsh", command: "make build" }}><button>Terminal</button></SidebarPreviewTrigger>
  </aside></SidebarPreviewProvider>);
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("sidebar preview cards", () => {
  it("renders a browser frame and domain without rendering page text", () => {
    render(<SidebarPreviewCard id="frame" preview={{ kind: "browser", title: "Build guide", url: "https://example.test/guide", imageDataUrl: "data:image/png;base64,AA==" }} />);
    expect(screen.getByRole("tooltip").textContent).toBe("Build guideexample.test");
    expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });
  it("renders a local file card without an image when no frame exists", () => {
    render(<SidebarPreviewCard id="local" preview={{ kind: "browser", title: "Guide", url: "file:///workspace/guide.html" }} />);
    expect(screen.getByRole("tooltip").textContent).toMatch(/Local file|로컬 파일/);
    expect(document.querySelector("img")).toBeNull();
  });
  it("renders conversation summary, relative activity and running state in one card", () => {
    render(<SidebarPreviewCard id="conversation" preview={conversation} />);
    expect(screen.getByRole("tooltip").textContent).toContain(conversation.message);
    expect(screen.getByRole("tooltip").textContent).toMatch(/Agent responding|에이전트 응답/);
    expect(screen.getByText(conversation.message).className).toContain("line-clamp-2");
    expect(document.querySelector("img")).toBeNull();
  });
  it("renders only the command and title for a terminal, and title alone without a command", () => {
    const { rerender } = render(<SidebarPreviewCard id="terminal" preview={{ kind: "terminal", title: "Terminal 1 · zsh", command: "make build" }} />);
    expect(screen.getByRole("tooltip").textContent).toBe("❯ make buildTerminal 1 · zsh");
    rerender(<SidebarPreviewCard id="terminal" preview={{ kind: "terminal", title: "Terminal 1 · zsh" }} />);
    expect(screen.getByRole("tooltip").textContent).toBe("Terminal 1 · zsh");
  });
  it("waits 500ms, then switches immediately across adjacent entries", () => {
    vi.useFakeTimers(); entries();
    fireEvent.pointerEnter(screen.getByText("Conversation"));
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("tooltip").textContent).toContain("Build review");
    fireEvent.pointerLeave(screen.getByText("Conversation"));
    fireEvent.pointerEnter(screen.getByText("Terminal"));
    expect(screen.getByRole("tooltip").textContent).toContain("make build");
  });
  it("shows focus immediately and associates the summary with the entry", () => {
    entries();
    const entry = screen.getByText("Conversation");
    fireEvent.focus(entry);
    expect(entry.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
    fireEvent.blur(entry);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(entry.hasAttribute("aria-describedby")).toBe(false);
  });
  it.each(["click", "scroll", "leave", "escape"])("hides on %s and cancels pending hover", (action) => {
    vi.useFakeTimers(); entries();
    const entry = screen.getByText("Conversation");
    fireEvent.focus(entry);
    if (action === "click") fireEvent.click(entry);
    if (action === "scroll") fireEvent.scroll(window);
    if (action === "leave") fireEvent.pointerLeave(entry);
    if (action === "escape") fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(entry);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("loads only after reveal and ignores a late response after moving to another entry", async () => {
    vi.useFakeTimers();
    let resolve!: (value: typeof conversation) => void;
    const load = vi.fn(() => new Promise<typeof conversation>((done) => { resolve = done; }));
    entries(load);
    fireEvent.pointerEnter(screen.getByText("Conversation"));
    expect(load).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.pointerEnter(screen.getByText("Terminal"));
    await act(async () => resolve({ ...conversation, title: "Late title" }));
    expect(screen.getByRole("tooltip").textContent).toContain("make build");
    expect(screen.queryByText("Late title")).toBeNull();
  });
});

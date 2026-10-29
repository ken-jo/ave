// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalFileReviewSnapshot, TerminalReviewFile } from "../../../../shared/terminal-file-review.js";
import type { TerminalApi } from "../../../../shared/terminal-session.js";
import { terminalSessionFixture } from "../../../../__tests__/support/terminal-session-fixtures.js";
import { loadLocaleMessages, setLocale, t } from "../../../../i18n/index.js";
import { TerminalChangeAnnotations } from "../TerminalChangeAnnotations.js";
import { TerminalChangesView } from "../TerminalChangesView.js";
import { TerminalFileReviewBadge } from "../TerminalFileReviewBadge.js";
import { forgetTerminalFileReview, useTerminalFileReviewState } from "../../preview/terminal-file-review.js";
import type { TerminalBlockAnchors } from "../terminal-block-anchors.js";
import { makeMockAveApi, makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import type { AveApi } from "../../types.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";

const session = terminalSessionFixture("terminal:review", "manual");

function reviewed(path: string, before: string, after: string): TerminalReviewFile["review"] {
  return { path, bytes: after.length, lineCount: 1, added: 1, removed: 1, operation: "modify", countsKnown: true, referenceable: false,
    hunks: [{ id: `${path}-hunk`, oldText: before, newText: after, oldStartLine: 1, newStartLine: 1, startLine: 1, endLine: 1 }] };
}

function evidence(): TerminalFileReviewSnapshot {
  return { cwd: "/repo", latestBlockId: 1, files: [
    { path: "/repo/run.sh", sessionIds: ["conversation"], lastUsed: { command: "bash run.sh", when: 1000 }, review: reviewed("/repo/run.sh", "echo before\n", "echo after\n") },
    { path: "/repo/unused.sh", sessionIds: ["conversation"], lastUsed: { command: "make build", when: 900 } },
  ], warnings: [{ blockId: 1, command: "bash run.sh", files: ["/repo/run.sh"] }] };
}

function reviewApi(snapshot = evidence()) {
  return { listFileReviews: vi.fn(async () => ({ ok: true as const, snapshot })) };
}

const anchorContainers: HTMLElement[] = [];

/** Command rows the terminal knows, with the columns each row leaves free after its command text. */
function fakeAnchors(blockIds: readonly number[] = [1, 2, 3, 4], columns = 60): TerminalBlockAnchors & { attach: ReturnType<typeof vi.fn> } {
  const slots = new Map<number, { container: HTMLElement; columns: number }>();
  return {
    attach: vi.fn((blockId: number) => {
      if (!blockIds.includes(blockId)) return null;
      let slot = slots.get(blockId);
      if (!slot) {
        const container = document.createElement("div");
        container.dataset.blockId = String(blockId);
        document.body.appendChild(container);
        anchorContainers.push(container);
        slot = { container, columns };
        slots.set(blockId, slot);
      }
      return slot;
    }),
    subscribe: () => () => {},
    version: () => 0,
  };
}

function view(terminalApi: ReturnType<typeof reviewApi>, revision: number, anchors: TerminalBlockAnchors | null) {
  return <><TerminalFileReviewBadge tabId={session.tabId} /><TerminalChangeAnnotations terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={revision} anchors={anchors} /></>;
}

function renderWithBadge(terminalApi: ReturnType<typeof reviewApi>, anchors: TerminalBlockAnchors | null = fakeAnchors()) {
  const rendered = render(view(terminalApi, 0, anchors));
  return { ...rendered, rerenderAt: (revision: number) => rendered.rerender(view(terminalApi, revision, anchors)) };
}

function RevealProbe() {
  const reveal = useTerminalFileReviewState(session.tabId)?.reveal;
  return <output data-testid="reveal">{reveal ? `${reveal.token}:${reveal.path ?? "first"}` : ""}</output>;
}

const annotationFor = (blockId: number) => document.querySelector<HTMLElement>(`[data-block-id="${blockId}"] [data-testid="terminal-file-warning"]`);
const changesApi = () => makeMockAveApi().api as unknown as AveApi;

let initialWindowAve: unknown;
beforeEach(async () => {
  await loadLocaleMessages("ko");
  setLocale("ko");
  initialWindowAve = window.ave;
  (window as unknown as { ave: unknown }).ave = makeMockAveNamespace().ns;
});
afterEach(() => {
  // Unmount before restoring window.ave: the file tree's effects read it.
  cleanup();
  forgetTerminalFileReview(session.tabId);
  setLocale("ko");
  vi.useRealTimers();
  vi.restoreAllMocks();
  (window as unknown as { ave: unknown }).ave = initialWindowAve;
  for (const container of anchorContainers.splice(0)) container.remove();
});

describe("TerminalChangeAnnotations", () => {
  it("annotates the matched command's row inline with only [view changes], and counts the files on the badge", async () => {
    renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    const annotation = annotationFor(1)!;
    expect(annotation).toHaveTextContent("# ⚠ 에이전트가 수정한 파일 사용: run.sh");
    expect(annotation).toHaveAttribute("data-active", "true");
    expect(annotation).toHaveAttribute("data-form", "full");
    expect(within(annotation).getAllByRole("button").map((button) => button.textContent)).toEqual(["[변경 보기]"]);
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the changes view on the clicked command's file from [view changes], and on the first file from the badge", async () => {
    render(<>{view(reviewApi(), 0, fakeAnchors())}<RevealProbe /></>);
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    fireEvent.click(within(annotationFor(1)!).getByRole("button", { name: "[변경 보기]" }));
    expect(screen.getByTestId("reveal").textContent).toMatch(/^\d+:\/repo\/run\.sh$/u);
    const first = screen.getByTestId("reveal").textContent;
    fireEvent.click(screen.getByTestId("terminal-tab-file-review-badge"));
    expect(screen.getByTestId("reveal").textContent).toMatch(/^\d+:first$/u);
    expect(screen.getByTestId("reveal").textContent).not.toBe(first);
  });

  it("draws no panel of its own inside the terminal: the only element it adds is the annotation in its command anchor", async () => {
    const { container } = renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    expect(screen.getAllByTestId("terminal-file-warning")).toEqual([annotationFor(1)]);
    expect(within(container).queryByTestId("terminal-file-warning")).toBeNull();
    fireEvent.click(screen.getByTestId("terminal-tab-file-review-badge"));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: /검토/u })).toBeNull();
  });

  it("renders the changed-file badge exactly once", async () => {
    renderWithBadge(reviewApi());
    await screen.findByTestId("terminal-tab-file-review-badge");
    expect(screen.getAllByText(/에이전트 변경/)).toHaveLength(1);
  });

  it("counts the files this terminal's commands used and never lowers the count on a user action", async () => {
    const one = { ...evidence(), files: evidence().files.slice(0, 1) };
    const terminalApi = reviewApi(one);
    const { rerenderAt } = renderWithBadge(terminalApi);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 1"));
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: evidence() });
    rerenderAt(1);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2"));
    fireEvent.click(within(annotationFor(1)!).getByRole("button", { name: "[변경 보기]" }));
    rerenderAt(2);
    await waitFor(() => expect(terminalApi.listFileReviews.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2");
  });

  it("never annotates unresolved indirection or a command without a matched changed file", async () => {
    const snapshot = { ...evidence(), warnings: [
      { blockId: 3, command: "$RUN_SCRIPT", files: [], unresolved: true },
      { blockId: 4, command: "clear", files: [] },
    ], latestBlockId: 4 } as unknown as TerminalFileReviewSnapshot;
    renderWithBadge(reviewApi(snapshot));
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2"));
    expect(screen.queryByTestId("terminal-file-warning")).toBeNull();
  });

  it("keeps exactly one actionable annotation, on the latest of two matching commands", async () => {
    const snapshot = evidence();
    snapshot.warnings.push({ blockId: 2, command: "make build", files: ["/repo/unused.sh"] });
    renderWithBadge(reviewApi({ ...snapshot, latestBlockId: 2 }));
    await waitFor(() => expect(annotationFor(2)).not.toBeNull());
    expect(screen.getAllByTestId("terminal-file-warning").filter((element) => element.dataset.active === "true")).toEqual([annotationFor(2)]);
    expect(annotationFor(2)).toHaveTextContent("에이전트가 수정한 파일 사용: unused.sh");
    expect(annotationFor(1)).toHaveTextContent("에이전트가 수정한 파일 사용: run.sh");
    expect(within(annotationFor(1)!).queryByRole("button")).toBeNull();
  });

  it("keeps [view changes] on the latest matching command while later commands that used no changed file run", async () => {
    const terminalApi = reviewApi();
    const { rerenderAt } = renderWithBadge(terminalApi);
    await waitFor(() => expect(annotationFor(1)).toHaveAttribute("data-active", "true"));
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: { ...evidence(), latestBlockId: 3 } });
    rerenderAt(1);
    await waitFor(() => expect(terminalApi.listFileReviews.mock.calls.length).toBeGreaterThan(1));
    await act(async () => {});
    expect(annotationFor(1)).toHaveAttribute("data-active", "true");
    expect(within(annotationFor(1)!).getByRole("button", { name: "[변경 보기]" })).toBeTruthy();
  });

  it.each([
    [14, "compact", "⚠[변경 보기]", ["[변경 보기]"]],
    [6, "glyph", "⚠", ["⚠"]],
  ])("shrinks to what fits after a long command (%i free columns: %s), never over the command", async (columns, form, text, buttons) => {
    renderWithBadge(reviewApi(), fakeAnchors([1], columns));
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    expect(annotationFor(1)).toHaveAttribute("data-form", form);
    expect(annotationFor(1)!.textContent).toBe(text);
    expect(within(annotationFor(1)!).getAllByRole("button").map((button) => button.textContent)).toEqual(buttons);
    expect(annotationFor(1)).toHaveAttribute("title", expect.stringContaining("에이전트가 수정한 파일 사용: run.sh"));
  });

  it("draws nothing for a block whose command row is not in the terminal or has no free columns", async () => {
    const anchors = fakeAnchors([]);
    renderWithBadge(reviewApi(), anchors);
    await waitFor(() => expect(anchors.attach).toHaveBeenCalledWith(1));
    expect(screen.queryByTestId("terminal-file-warning")).toBeNull();
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2");
  });

  it("names two files and summarizes the rest as +N", async () => {
    const snapshot = evidence();
    snapshot.files.push({ path: "/repo/scripts/build.sh", sessionIds: ["conversation"], lastUsed: null });
    snapshot.warnings.splice(0, 1, { blockId: 1, command: "make build", files: ["/repo/run.sh", "/repo/unused.sh", "/repo/scripts/build.sh"] });
    renderWithBadge(reviewApi(snapshot), fakeAnchors([1, 2, 3, 4], 80));
    await waitFor(() => expect(annotationFor(1)).toHaveTextContent("에이전트가 수정한 파일 사용: run.sh, unused.sh +1"));
  });

  it("renders the annotation and badge in English", async () => {
    setLocale("en");
    renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).toHaveTextContent("# ⚠ Uses files the agent changed: run.sh"));
    expect(within(annotationFor(1)!).getByRole("button", { name: "[View changes]" })).toBeTruthy();
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("Agent changed 2");
  });

  it("never reads or renders evidence on isolated terminal surfaces", async () => {
    const terminalApi = reviewApi();
    const { container } = render(<TerminalChangeAnnotations terminalApi={terminalApi as unknown as TerminalApi} session={terminalSessionFixture("isolated", "agent")} revision={0} anchors={fakeAnchors()} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(terminalApi.listFileReviews).not.toHaveBeenCalled();
  });

  it("reports a failed refresh on the badge without clearing prior evidence", async () => {
    const terminalApi = reviewApi();
    const { rerenderAt } = renderWithBadge(terminalApi);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2"));
    terminalApi.listFileReviews.mockRejectedValue(new Error("unavailable"));
    rerenderAt(1);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveAttribute("title", "변경 파일 정보를 새로 고치지 못했습니다."));
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2");
  });

  it("updates an inactive tab badge and releases its observer when the shell closes", async () => {
    vi.useFakeTimers();
    const terminalApi = reviewApi({ ...evidence(), files: [], warnings: [] });
    let rendered: ReturnType<typeof render>;
    await act(async () => {
      rendered = renderWithBadge(terminalApi);
    });
    rendered!.rerender(<TerminalFileReviewBadge tabId={session.tabId} />);
    expect(screen.queryByTestId("terminal-tab-file-review-badge")).toBeNull();
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: evidence() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2");
    terminalApi.listFileReviews.mockResolvedValue({ ok: false, error: "stale-terminal-session" } as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByTestId("terminal-tab-file-review-badge")).toBeNull();
    const calls = terminalApi.listFileReviews.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(terminalApi.listFileReviews).toHaveBeenCalledTimes(calls);
  });
});

describe("TerminalChangesView", () => {
  it("lists the terminal's agent-changed files in the chat's change UI and opens the clicked file's review", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    const readFile = vi.fn();
    (window as unknown as { ave: { preview: unknown } }).ave.preview = { ...window.ave.preview, readFile };
    render(<TooltipProvider>{view(reviewApi(), 0, fakeAnchors())}<TerminalChangesView api={changesApi()} tabId={session.tabId} visible /></TooltipProvider>);
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    const changes = screen.getByTestId("terminal-changes-view");
    expect(within(changes).getByTestId("terminal-changes-caption")).toHaveTextContent("에이전트가 이 세션에서 바꾼 파일 · 최근 사용: bash run.sh");
    expect(within(changes).getByTestId("chat-side-panel-file-filter-changed")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(annotationFor(1)!).getByRole("button", { name: "[변경 보기]" }));
    const detail = await within(changes).findByTestId("turn-change-detail");
    expect(detail).toHaveTextContent("run.sh");
    expect(detail).toHaveTextContent("echo after");
    // The detection limits are an info tooltip beside the caption, not a paragraph under the diff.
    expect(within(changes).getByTestId("terminal-changes-advisory")).toHaveAccessibleName(t("terminalFileReview.advisory"));
    expect(changes.textContent).not.toContain(t("terminalFileReview.advisory"));
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens straight to the clicked file's diff in a narrow work panel, where the tree and the diff take turns", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    render(<TooltipProvider>{view(reviewApi(), 0, fakeAnchors())}<TerminalChangesView api={changesApi()} tabId={session.tabId} visible /></TooltipProvider>);
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    const changes = screen.getByTestId("terminal-changes-view");
    expect(within(changes).getByTestId("chat-side-panel-file-browser")).toHaveAttribute("data-file-layout", "single");
    fireEvent.click(within(annotationFor(1)!).getByRole("button", { name: "[변경 보기]" }));
    await waitFor(() => expect(within(changes).getByTestId("chat-side-panel-file-detail")).not.toHaveClass("hidden"));
    expect(within(changes).getByTestId("chat-side-panel-file-tree")).toHaveClass("hidden");
    expect(within(changes).getByTestId("turn-change-detail")).toHaveTextContent("echo after");
  });

  it("never reads a file whose change has no review: it says the diff is unavailable", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    const readFile = vi.fn();
    (window as unknown as { ave: { preview: unknown } }).ave.preview = { ...window.ave.preview, readFile };
    const snapshot = { ...evidence(), warnings: [{ blockId: 1, command: "make build", files: ["/repo/unused.sh"] }] };
    render(<TooltipProvider>{view(reviewApi(snapshot), 0, fakeAnchors())}<TerminalChangesView api={changesApi()} tabId={session.tabId} visible /></TooltipProvider>);
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    fireEvent.click(within(annotationFor(1)!).getByRole("button", { name: "[변경 보기]" }));
    const changes = screen.getByTestId("terminal-changes-view");
    expect(await within(changes).findByText(t("terminalFileReview.diffUnavailable"))).toBeTruthy();
    expect(within(changes).queryByTestId("turn-change-detail")).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });
});

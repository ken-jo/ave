// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalFileReviewSnapshot } from "../../../../shared/terminal-file-review.js";
import type { TerminalApi } from "../../../../shared/terminal-session.js";
import { terminalSessionFixture } from "../../../../__tests__/support/terminal-session-fixtures.js";
import { loadLocaleMessages, setLocale, t } from "../../../../i18n/index.js";
import { TerminalFileReview } from "../TerminalFileReview.js";
import { TerminalFileReviewBadge } from "../TerminalFileReviewBadge.js";
import { forgetTerminalFileReview } from "../../preview/terminal-file-review.js";
import type { TerminalBlockAnchors } from "../terminal-block-anchors.js";

const session = terminalSessionFixture("terminal:review", "manual");

function evidence(): TerminalFileReviewSnapshot {
  return { cwd: "/repo", latestBlockId: 1, files: [
    { path: "/repo/run.sh", sessionIds: ["conversation"], lastUsed: { command: "bash run.sh", when: 1000 }, diff: { before: "echo before\n", after: "echo after\n" } },
    { path: "/repo/unused.sh", sessionIds: ["conversation"], lastUsed: null },
  ], warnings: [{ blockId: 1, command: "bash run.sh", files: ["/repo/run.sh"] }] };
}

function reviewApi(snapshot = evidence()) {
  return { listFileReviews: vi.fn(async () => ({ ok: true as const, snapshot })) };
}

const anchorContainers: HTMLElement[] = [];

/** Command rows the terminal knows; each attach returns that block's decoration container. */
function fakeAnchors(blockIds: readonly number[] = [1, 2, 3, 4]): TerminalBlockAnchors & { attach: ReturnType<typeof vi.fn> } {
  const containers = new Map<number, HTMLElement>();
  return {
    attach: vi.fn((blockId: number) => {
      if (!blockIds.includes(blockId)) return null;
      let container = containers.get(blockId);
      if (!container) {
        container = document.createElement("div");
        container.dataset.blockId = String(blockId);
        document.body.appendChild(container);
        anchorContainers.push(container);
        containers.set(blockId, container);
      }
      return container;
    }),
    subscribe: () => () => {},
    version: () => 0,
  };
}

function view(terminalApi: ReturnType<typeof reviewApi>, revision: number, anchors: TerminalBlockAnchors | null) {
  return <><TerminalFileReviewBadge tabId={session.tabId} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={revision} anchors={anchors} /></>;
}

function renderWithBadge(terminalApi: ReturnType<typeof reviewApi>, anchors: TerminalBlockAnchors | null = fakeAnchors()) {
  const rendered = render(view(terminalApi, 0, anchors));
  return { ...rendered, rerenderAt: (revision: number) => rendered.rerender(view(terminalApi, revision, anchors)) };
}

const annotationFor = (blockId: number) => document.querySelector<HTMLElement>(`[data-block-id="${blockId}"] [data-testid="terminal-file-warning"]`);

beforeEach(async () => { await loadLocaleMessages("ko"); setLocale("ko"); });
afterEach(() => {
  forgetTerminalFileReview(session.tabId);
  setLocale("ko");
  vi.useRealTimers();
  for (const container of anchorContainers.splice(0)) container.remove();
});

describe("TerminalFileReview", () => {
  it("annotates the matched command's row inline with only [view changes] and opens the panel from the header badge", async () => {
    renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    const annotation = annotationFor(1)!;
    expect(annotation).toHaveTextContent("# ⚠ 에이전트가 수정한 파일 사용: run.sh");
    expect(annotation).toHaveAttribute("data-active", "true");
    expect(within(annotation).getAllByRole("button").map((button) => button.textContent)).toEqual(["[변경 보기]"]);
    const badge = screen.getByTestId("terminal-tab-file-review-badge");
    expect(badge).toHaveTextContent("에이전트 변경 2");
    fireEvent.click(badge);
    expect(screen.getByRole("complementary")).toHaveAccessibleName("에이전트가 바꾼 파일 · 2");
    expect(screen.getAllByTestId("terminal-file-review-row")).toHaveLength(2);
    expect(screen.getByText(/실행 시 사용됨 · bash run.sh/)).toBeTruthy();
    expect(screen.getByText("아직 실행에 쓰이지 않음")).toBeTruthy();
    expect(screen.getByText(t("terminalFileReview.advisory"))).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no review control anywhere: the annotation has [view changes], each panel row only [open diff]", async () => {
    renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    fireEvent.click(screen.getByTestId("terminal-tab-file-review-badge"));
    const panel = await screen.findByTestId("terminal-file-review-panel");
    for (const row of within(panel).getAllByTestId("terminal-file-review-row")) {
      expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual(["diff 열기"]);
    }
    expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["변경 파일 패널 닫기", "diff 열기", "diff 열기"]);
    expect(screen.queryByRole("button", { name: /검토/u })).toBeNull();
  });

  it("renders no floating overlay: the only warning is the annotation inside its command anchor", async () => {
    const { container } = renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    expect(screen.getAllByTestId("terminal-file-warning")).toEqual([annotationFor(1)]);
    expect(within(container).queryByTestId("terminal-file-warning")).toBeNull();
  });

  it("renders the changed-file badge exactly once, in the header", async () => {
    renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    await screen.findByTestId("terminal-tab-file-review-badge");
    expect(screen.getAllByText(/에이전트 변경/)).toHaveLength(1);
  });

  it("counts the current set of agent-changed files and never lowers it on its own", async () => {
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

  it("keeps exactly one actionable annotation, on the latest of two consecutive matching commands", async () => {
    const snapshot = evidence();
    snapshot.warnings.push({ blockId: 2, command: "make build", files: ["/repo/unused.sh"] });
    renderWithBadge(reviewApi({ ...snapshot, latestBlockId: 2 }));
    await waitFor(() => expect(annotationFor(2)).not.toBeNull());
    expect(screen.getAllByTestId("terminal-file-warning").filter((element) => element.dataset.active === "true")).toEqual([annotationFor(2)]);
    expect(annotationFor(2)).toHaveTextContent("에이전트가 수정한 파일 사용: unused.sh");
    expect(annotationFor(1)).toHaveTextContent("에이전트가 수정한 파일 사용: run.sh");
    expect(within(annotationFor(1)!).queryByRole("button")).toBeNull();
  });

  it("collapses the annotation to plain history once a later command runs", async () => {
    const terminalApi = reviewApi();
    const { rerenderAt } = renderWithBadge(terminalApi);
    await waitFor(() => expect(annotationFor(1)).toHaveAttribute("data-active", "true"));
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: { ...evidence(), latestBlockId: 3 } });
    rerenderAt(1);
    await waitFor(() => expect(annotationFor(1)).toHaveAttribute("data-active", "false"));
    expect(annotationFor(1)).toHaveTextContent("# ⚠ 에이전트가 수정한 파일 사용: run.sh");
    expect(within(annotationFor(1)!).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2");
  });

  it("draws nothing for a block whose command row is not in the terminal", async () => {
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
    renderWithBadge(reviewApi(snapshot));
    await waitFor(() => expect(annotationFor(1)).toHaveTextContent("에이전트가 수정한 파일 사용: run.sh, unused.sh +1"));
  });

  it("opens the real recorded diff and labels unavailable text diffs", async () => {
    renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).not.toBeNull());
    fireEvent.click(within(annotationFor(1)!).getByRole("button", { name: "[변경 보기]" }));
    const diff = screen.getByTestId("terminal-file-review-diff");
    expect(diff).toHaveTextContent("before");
    expect(diff).toHaveTextContent("after");
    fireEvent.click(within(screen.getAllByTestId("terminal-file-review-row")[1]!).getByRole("button", { name: "diff 열기" }));
    expect(screen.getByTestId("terminal-file-review-diff")).toHaveTextContent("이 파일의 텍스트 diff를 사용할 수 없습니다.");
  });

  it("renders the annotation, badge and best-effort footnote in English", async () => {
    setLocale("en");
    renderWithBadge(reviewApi());
    await waitFor(() => expect(annotationFor(1)).toHaveTextContent("# ⚠ Uses files the agent changed: run.sh"));
    expect(within(annotationFor(1)!).getByRole("button", { name: "[View changes]" })).toBeTruthy();
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("Agent changed 2");
    fireEvent.click(screen.getByTestId("terminal-tab-file-review-badge"));
    expect(screen.getByRole("complementary")).toHaveAccessibleName("Files changed by the agent · 2");
    expect(screen.getByText(/^Detection is best-effort/)).toBeTruthy();
  });

  it("never reads or renders evidence on isolated terminal surfaces", async () => {
    const terminalApi = reviewApi();
    const { container } = render(<TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={terminalSessionFixture("isolated", "agent")} revision={0} anchors={fakeAnchors()} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(terminalApi.listFileReviews).not.toHaveBeenCalled();
  });

  it("reports a failed refresh on the header badge without clearing prior evidence", async () => {
    const terminalApi = reviewApi();
    const { rerenderAt } = renderWithBadge(terminalApi);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2"));
    terminalApi.listFileReviews.mockRejectedValue(new Error("unavailable"));
    rerenderAt(1);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveAttribute("title", "변경 파일 정보를 새로 고치지 못했습니다."));
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("에이전트 변경 2");
    fireEvent.click(screen.getByTestId("terminal-tab-file-review-badge"));
    expect(await screen.findByRole("status")).toHaveTextContent("변경 파일 정보를 새로 고치지 못했습니다.");
  });

  it("opens the same panel from the terminal tab header badge", async () => {
    const terminalApi = reviewApi();
    const onOpen = vi.fn();
    render(<><TerminalFileReviewBadge tabId={session.tabId} onOpen={onOpen} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={0} anchors={null} /></>);
    const badge = await screen.findByTestId("terminal-tab-file-review-badge");
    expect(badge).toHaveTextContent("에이전트 변경 2");
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("terminal-file-review-panel")).toBeTruthy();
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

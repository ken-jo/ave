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

const session = terminalSessionFixture("terminal:review", "manual");

function evidence(): TerminalFileReviewSnapshot {
  return { cwd: "/repo", latestBlockId: 1, files: [
    { path: "/repo/run.sh", hash: "a".repeat(64), sessionIds: ["conversation"], reviewed: false, lastUsed: { command: "bash run.sh", when: 1000 }, diff: { before: "echo before\n", after: "echo after\n" } },
    { path: "/repo/unused.sh", hash: "b".repeat(64), sessionIds: ["conversation"], reviewed: false, lastUsed: null },
  ], warnings: [{ blockId: 1, command: "bash run.sh", files: ["/repo/run.sh"] }] };
}

function reviewApi(snapshot = evidence()) {
  const terminalApi = {
    listFileReviews: vi.fn(async () => ({ ok: true as const, snapshot })),
    reviewFiles: vi.fn(async (_session: unknown, files: { path: string; hash: string }[]) => {
      snapshot = { ...snapshot, files: snapshot.files.map((file) => ({ ...file, reviewed: file.reviewed || files.some((reviewed) => reviewed.path === file.path && reviewed.hash === file.hash) })) };
      return { ok: true as const };
    }),
  };
  return terminalApi;
}

function renderWithBadge(terminalApi: ReturnType<typeof reviewApi>, revision = 0) {
  return render(<><TerminalFileReviewBadge tabId={session.tabId} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={revision} /></>);
}

beforeEach(async () => { await loadLocaleMessages("ko"); setLocale("ko"); });
afterEach(() => { forgetTerminalFileReview(session.tabId); setLocale("ko"); vi.useRealTimers(); });

describe("TerminalFileReview", () => {
  it("shows one thin non-blocking banner and opens the panel from the header badge", async () => {
    const terminalApi = reviewApi();
    renderWithBadge(terminalApi);
    const banner = await screen.findByTestId("terminal-file-warning");
    expect(banner).toHaveTextContent("에이전트가 수정한 파일 사용: run.sh");
    expect(banner).toHaveClass("absolute", "h-8");
    const badge = screen.getByTestId("terminal-tab-file-review-badge");
    expect(badge).toHaveTextContent("검토 대기 2");
    fireEvent.click(badge);
    expect(screen.getByRole("complementary")).toHaveAccessibleName("에이전트가 바꾼 파일 · 2");
    expect(screen.getAllByTestId("terminal-file-review-row")).toHaveLength(2);
    expect(screen.getByText(/실행 시 사용됨 · bash run.sh/)).toBeTruthy();
    expect(screen.getByText("아직 실행에 쓰이지 않음")).toBeTruthy();
    expect(screen.getByText(t("terminalFileReview.advisory"))).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(terminalApi.reviewFiles).not.toHaveBeenCalled();
  });

  it("renders the pending badge exactly once, in the header", async () => {
    renderWithBadge(reviewApi());
    await screen.findByTestId("terminal-file-warning");
    await screen.findByTestId("terminal-tab-file-review-badge");
    expect(screen.getAllByText(/검토 대기/)).toHaveLength(1);
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 2");
  });

  it("never banners unresolved indirection or a command without a matched changed file", async () => {
    const snapshot = { ...evidence(), warnings: [
      { blockId: 3, command: "$RUN_SCRIPT", files: [], unresolved: true },
      { blockId: 4, command: "clear", files: [] },
    ], latestBlockId: 4 } as unknown as TerminalFileReviewSnapshot;
    const terminalApi = reviewApi(snapshot);
    renderWithBadge(terminalApi);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 2"));
    expect(screen.queryByTestId("terminal-file-warning")).toBeNull();
  });

  it("shows exactly one banner, for the latest of two consecutive matching commands", async () => {
    const snapshot = evidence();
    snapshot.warnings.push({ blockId: 2, command: "make build", files: ["/repo/unused.sh"] });
    renderWithBadge(reviewApi({ ...snapshot, latestBlockId: 2 }));
    await waitFor(() => expect(screen.getAllByTestId("terminal-file-warning")).toHaveLength(1));
    expect(screen.getByTestId("terminal-file-warning")).toHaveTextContent("에이전트가 수정한 파일 사용: unused.sh");
    expect(screen.getByTestId("terminal-file-warning")).not.toHaveTextContent("run.sh");
  });

  it("drops the banner once a later command without a match runs, keeping the files pending", async () => {
    const terminalApi = reviewApi();
    const view = renderWithBadge(terminalApi);
    await screen.findByTestId("terminal-file-warning");
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: { ...evidence(), latestBlockId: 3 } });
    view.rerender(<><TerminalFileReviewBadge tabId={session.tabId} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={1} /></>);
    await waitFor(() => expect(screen.queryByTestId("terminal-file-warning")).toBeNull());
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 2");
  });

  it("names two files and summarizes the rest as +N", async () => {
    const snapshot = evidence();
    snapshot.files.push({ path: "/repo/scripts/build.sh", hash: "c".repeat(64), sessionIds: ["conversation"], reviewed: false, lastUsed: null });
    snapshot.warnings.splice(0, 1, { blockId: 1, command: "make build", files: ["/repo/run.sh", "/repo/unused.sh", "/repo/scripts/build.sh"] });
    renderWithBadge(reviewApi(snapshot));
    expect(await screen.findByTestId("terminal-file-warning")).toHaveTextContent("에이전트가 수정한 파일 사용: run.sh, unused.sh +1");
  });

  it("dismisses the banner until the next positive match and keeps the files pending", async () => {
    const terminalApi = reviewApi();
    const view = renderWithBadge(terminalApi);
    await screen.findByTestId("terminal-file-warning");
    fireEvent.click(screen.getByRole("button", { name: "경고 닫기" }));
    view.rerender(<><TerminalFileReviewBadge tabId={session.tabId} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={1} /></>);
    await waitFor(() => expect(terminalApi.listFileReviews.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByTestId("terminal-file-warning")).toBeNull();
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 2");
    const next = evidence();
    next.warnings.push({ blockId: 2, command: "./run.sh", files: ["/repo/run.sh"] });
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: { ...next, latestBlockId: 2 } });
    view.rerender(<><TerminalFileReviewBadge tabId={session.tabId} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={2} /></>);
    expect(await screen.findByTestId("terminal-file-warning")).toHaveTextContent("run.sh");
    expect(terminalApi.reviewFiles).not.toHaveBeenCalled();
  });

  it("reviews the observed warning hashes without reviewing unrelated files", async () => {
    const terminalApi = reviewApi();
    renderWithBadge(terminalApi);
    const banner = await screen.findByTestId("terminal-file-warning");
    fireEvent.click(within(banner).getByRole("button", { name: "검토 완료" }));
    await waitFor(() => expect(terminalApi.reviewFiles).toHaveBeenCalledWith(session, [{ path: "/repo/run.sh", hash: "a".repeat(64) }]));
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 1"));
    expect(screen.queryByTestId("terminal-file-warning")).toBeNull();
  });

  it("reviews a single file then all remaining files from the panel", async () => {
    const terminalApi = reviewApi();
    renderWithBadge(terminalApi);
    fireEvent.click(await screen.findByTestId("terminal-tab-file-review-badge"));
    const rows = await screen.findAllByTestId("terminal-file-review-row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "검토 완료" }));
    await waitFor(() => expect(terminalApi.reviewFiles).toHaveBeenCalledWith(session, [{ path: "/repo/unused.sh", hash: "b".repeat(64) }]));
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 1"));
    fireEvent.click(screen.getByRole("button", { name: "모두 검토 완료" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-tab-file-review-badge")).toBeNull());
    expect(terminalApi.reviewFiles).toHaveBeenLastCalledWith(session, [{ path: "/repo/run.sh", hash: "a".repeat(64) }]);
  });

  it("opens the real recorded diff and labels unavailable text diffs", async () => {
    const terminalApi = reviewApi();
    renderWithBadge(terminalApi);
    fireEvent.click(await screen.findByRole("button", { name: "변경 보기" }));
    const diff = screen.getByTestId("terminal-file-review-diff");
    expect(diff).toHaveTextContent("before");
    expect(diff).toHaveTextContent("after");
    fireEvent.click(within(screen.getAllByTestId("terminal-file-review-row")[1]!).getByRole("button", { name: "diff 열기" }));
    expect(screen.getByTestId("terminal-file-review-diff")).toHaveTextContent("이 파일의 텍스트 diff를 사용할 수 없습니다.");
  });

  it("refreshes pending state when the content hash changes again", async () => {
    const snapshot = evidence();
    snapshot.files.splice(0, snapshot.files.length, ...snapshot.files.map((file) => ({ ...file, reviewed: true })));
    const terminalApi = reviewApi(snapshot);
    const view = renderWithBadge(terminalApi);
    await waitFor(() => expect(terminalApi.listFileReviews).toHaveBeenCalled());
    expect(screen.queryByTestId("terminal-tab-file-review-badge")).toBeNull();
    expect(screen.queryByTestId("terminal-file-warning")).toBeNull();
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: { ...snapshot, files: [{ ...snapshot.files[0]!, hash: "c".repeat(64), reviewed: false }] } });
    view.rerender(<><TerminalFileReviewBadge tabId={session.tabId} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={1} /></>);
    expect(await screen.findByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 1");
  });

  it("renders the banner and best-effort footnote in English", async () => {
    setLocale("en");
    renderWithBadge(reviewApi());
    expect(await screen.findByTestId("terminal-file-warning")).toHaveTextContent("Uses files the agent changed: run.sh");
    expect(screen.getByRole("button", { name: "View changes" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("terminal-tab-file-review-badge"));
    expect(screen.getByRole("complementary")).toHaveAccessibleName("Files changed by the agent · 2");
    expect(screen.getByText(/^Detection is best-effort/)).toBeTruthy();
  });

  it("never reads or renders evidence on isolated terminal surfaces", async () => {
    const terminalApi = reviewApi();
    const { container } = render(<TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={terminalSessionFixture("isolated", "agent")} revision={0} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(terminalApi.listFileReviews).not.toHaveBeenCalled();
  });

  it("reports a failed refresh without clearing prior review evidence", async () => {
    const snapshot = evidence();
    snapshot.warnings.splice(0);
    const terminalApi = reviewApi(snapshot);
    const view = renderWithBadge(terminalApi);
    await waitFor(() => expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 2"));
    terminalApi.listFileReviews.mockRejectedValue(new Error("unavailable"));
    view.rerender(<><TerminalFileReviewBadge tabId={session.tabId} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={1} /></>);
    expect(await screen.findByRole("status")).toHaveTextContent("파일 검토 정보를 새로 고치지 못했습니다.");
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 2");
  });

  it("opens the same panel from the terminal tab header badge", async () => {
    const terminalApi = reviewApi();
    const onOpen = vi.fn();
    render(<><TerminalFileReviewBadge tabId={session.tabId} onOpen={onOpen} /><TerminalFileReview terminalApi={terminalApi as unknown as TerminalApi} session={session} revision={0} /></>);
    const badge = await screen.findByTestId("terminal-tab-file-review-badge");
    expect(badge).toHaveTextContent("검토 대기 2");
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("terminal-file-review-panel")).toBeTruthy();
  });

  it("keeps unavailable content pending without allowing it to be reviewed", async () => {
    const snapshot = evidence();
    snapshot.files.splice(0, snapshot.files.length, { ...snapshot.files[0]!, hash: "missing", diff: undefined });
    const terminalApi = reviewApi(snapshot);
    renderWithBadge(terminalApi);
    fireEvent.click(await screen.findByTestId("terminal-tab-file-review-badge"));
    const panel = await screen.findByTestId("terminal-file-review-panel");
    expect(within(panel).getByRole("button", { name: "검토 완료" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "모두 검토 완료" })).toBeDisabled();
    expect(screen.getByText(t("terminalFileReview.contentUnavailable"))).toBeTruthy();
    expect(terminalApi.reviewFiles).not.toHaveBeenCalled();
  });

  it("updates an inactive tab badge and releases its observer when the shell closes", async () => {
    vi.useFakeTimers();
    const snapshot = evidence();
    snapshot.files.splice(0, snapshot.files.length, ...snapshot.files.map((file) => ({ ...file, reviewed: true })));
    const terminalApi = reviewApi(snapshot);
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = renderWithBadge(terminalApi);
    });
    view!.rerender(<TerminalFileReviewBadge tabId={session.tabId} />);
    expect(screen.queryByTestId("terminal-tab-file-review-badge")).toBeNull();
    terminalApi.listFileReviews.mockResolvedValue({ ok: true, snapshot: evidence() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByTestId("terminal-tab-file-review-badge")).toHaveTextContent("검토 대기 2");
    terminalApi.listFileReviews.mockResolvedValue({ ok: false, error: "stale-terminal-session" } as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByTestId("terminal-tab-file-review-badge")).toBeNull();
    const calls = terminalApi.listFileReviews.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(terminalApi.listFileReviews).toHaveBeenCalledTimes(calls);
  });
});

import "../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TurnChangeReview } from "../components/TurnChangeReview.js";
import { setLocale } from "../../../i18n/runtime.js";
import type { TurnChangeReview as Review, TurnReviewResult } from "../../../shared/turn-change-review.js";

function review(sessionId = "session-one"): Review {
  return {
    sessionId, turnId: "latest-turn", version: "version-one",
    files: [{ path: "/project/source.ts", hunks: [
      { id: "first-hunk", oldText: "before\n", newText: "after\n", oldStartLine: 4, newStartLine: 4, decision: "pending" },
      { id: "second-hunk", oldText: "old tail", newText: "new tail", oldStartLine: 9, newStartLine: 9, decision: "accepted" },
    ] }],
  };
}

function reviewApi(initial = review()) {
  return {
    chatGetTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: true, review: initial })),
    chatDecideTurnHunk: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: true, review: initial })),
  };
}

beforeEach(() => { setLocale("en"); });

describe("latest turn change review", () => {
  it("loads lazily and provides named native controls with final decisions disabled", async () => {
    const api = reviewApi();
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    const toggle = screen.getByRole("button", { name: "Review latest turn changes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(api.chatGetTurnReview).not.toHaveBeenCalled();
    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeVisible();
    expect(api.chatGetTurnReview).toHaveBeenCalledWith("session-one");
    expect(screen.getByRole("button", { name: "Accept hunk 2 in /project/source.ts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject hunk 2 in /project/source.ts" })).toBeDisabled();
    expect(screen.getByText("Accepted", { exact: true })).toBeVisible();
  });

  it("sends only turn identity and a decision, then reloads persistent decisions and preserves focus", async () => {
    const initial = review();
    const decided = review();
    decided.version = "version-two";
    decided.files[0]!.hunks[0]!.decision = "rejected";
    const api = reviewApi(initial);
    api.chatDecideTurnHunk.mockResolvedValue({ ok: true, review: decided });
    api.chatGetTurnReview.mockResolvedValueOnce({ ok: true, review: initial }).mockResolvedValue({ ok: true, review: decided });
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    const reject = await screen.findByRole("button", { name: "Reject hunk 1 in /project/source.ts" });
    reject.focus();
    fireEvent.click(reject);
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
    expect(api.chatDecideTurnHunk).toHaveBeenCalledWith({ sessionId: "session-one", turnId: "latest-turn", version: "version-one", hunkId: "first-hunk", decision: "reject" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Reject hunk 1 in /project/source.ts" })).toBeDisabled());
    expect(screen.getByRole("status")).toHaveTextContent("Hunk rejected.");
    expect(screen.getByRole("status")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Rejected", { exact: true })).toBeVisible();
  });

  it("refuses a conflict clearly and never offers a force action", async () => {
    const api = reviewApi();
    api.chatDecideTurnHunk.mockResolvedValue({ ok: false, error: "turn-review-conflict", conflictingFiles: ["/project/source.ts"] });
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject hunk 1 in /project/source.ts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file changed since this turn. Nothing was reverted. Reload the review to check the current state.");
    expect(screen.getByRole("alert")).toHaveTextContent("Hunk 1 in /project/source.ts");
    expect(screen.queryByRole("button", { name: /force/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject hunk 1 in /project/source.ts" })).toBeNull();
  });

  it("discards an old session fetch and immediately hides the old session review", async () => {
    let finish!: (result: TurnReviewResult) => void;
    const api = reviewApi();
    api.chatGetTurnReview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    api.chatGetTurnReview.mockResolvedValue({ ok: true, review: { ...review("session-two"), files: [] } });
    const { rerender } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1));
    rerender(<TurnChangeReview api={api} sessionId="session-two" streaming={false} />);
    await screen.findByText("No tracked file changes in the latest turn.");
    await act(async () => { finish({ ok: true, review: review() }); });
    expect(screen.queryByText("/project/source.ts")).toBeNull();
    expect(api.chatDecideTurnHunk).not.toHaveBeenCalled();
  });

  it("blocks review while streaming and reloads only the settled latest turn", async () => {
    const api = reviewApi();
    const { rerender } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={true} />);
    expect(screen.getByRole("button", { name: "Review latest turn changes" })).toBeDisabled();
    expect(api.chatGetTurnReview).not.toHaveBeenCalled();
    rerender(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    rerender(<TurnChangeReview api={api} sessionId="session-one" streaming={true} />);
    expect(screen.queryByRole("button", { name: "Accept hunk 1 in /project/source.ts" })).toBeNull();
    api.chatGetTurnReview.mockResolvedValue({ ok: true, review: { ...review(), turnId: "newest-empty-turn", files: [] } });
    rerender(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    await screen.findByText("No tracked file changes in the latest turn.");
    expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2);
  });

  it("discards an old decision response after the session changes", async () => {
    let finish!: (result: TurnReviewResult) => void;
    const api = reviewApi();
    api.chatDecideTurnHunk.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" }));
    api.chatGetTurnReview.mockResolvedValue({ ok: true, review: { ...review("session-two"), files: [] } });
    rerender(<TurnChangeReview api={api} sessionId="session-two" streaming={false} />);
    await screen.findByText("No tracked file changes in the latest turn.");
    await act(async () => { finish({ ok: true, review: review() }); });
    expect(screen.queryByText("/project/source.ts")).toBeNull();
    expect(screen.getByRole("status")).not.toHaveTextContent("Hunk accepted.");
  });

  it("renders persisted accepted and rejected decisions on a fresh mount", async () => {
    const saved = review();
    saved.files[0]!.hunks[0]!.decision = "rejected";
    const api = reviewApi(saved);
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    expect(await screen.findByText("Rejected", { exact: true })).toBeVisible();
    expect(screen.getByText("Accepted", { exact: true })).toBeVisible();
    for (const button of screen.getAllByRole("button", { name: /^(Accept|Reject) hunk/ })) expect(button).toBeDisabled();
  });

  it("does not expose thrown transport text and can reload after failure", async () => {
    const api = reviewApi();
    api.chatGetTurnReview.mockRejectedValueOnce(new Error("private host details"));
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not confirm the turn review outcome. Reload the review and inspect the file before trying again.");
    expect(screen.queryByText("private host details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload review" }));
    await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a successful decision visible if its follow-up refresh fails", async () => {
    const initial = review();
    const decided = review();
    decided.files[0]!.hunks[0]!.decision = "rejected";
    const api = reviewApi(initial);
    api.chatDecideTurnHunk.mockResolvedValue({ ok: true, review: decided });
    api.chatGetTurnReview.mockResolvedValueOnce({ ok: true, review: initial }).mockResolvedValue({ ok: false, error: "turn-review-conflict" });
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject hunk 1 in /project/source.ts" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("status")).toHaveTextContent("Hunk rejected.");
    expect(screen.getByText("Rejected", { exact: true })).toBeVisible();
    expect(screen.getByRole("alert")).not.toHaveTextContent("Nothing was reverted");
    expect(screen.getByRole("button", { name: "Reject hunk 1 in /project/source.ts" })).toBeDisabled();
  });

  it("drops a late response when streaming starts and refuses another decision", async () => {
    let finish!: (result: TurnReviewResult) => void;
    const api = reviewApi();
    api.chatDecideTurnHunk.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    const accept = await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(api.chatDecideTurnHunk).toHaveBeenCalledTimes(1);
    rerender(<TurnChangeReview api={api} sessionId="session-one" streaming={true} />);
    await act(async () => { finish({ ok: true, review: review() }); });
    expect(screen.queryByText("/project/source.ts")).toBeNull();
    expect(screen.getByRole("status")).not.toHaveTextContent("Hunk accepted.");
    expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a response after the scoped API changes", async () => {
    let finish!: (result: TurnReviewResult) => void;
    const firstApi = reviewApi();
    firstApi.chatGetTurnReview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const nextApi = reviewApi({ ...review(), files: [] });
    const { rerender } = render(<TurnChangeReview api={firstApi} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    rerender(<TurnChangeReview api={nextApi} sessionId="session-one" streaming={false} />);
    await screen.findByText("No tracked file changes in the latest turn.");
    await act(async () => { finish({ ok: true, review: review() }); });
    expect(screen.queryByText("/project/source.ts")).toBeNull();
  });

  it("uses the stored old and new line numbers without a trailing newline display row", async () => {
    const api = reviewApi();
    const { container } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    const rows = container.querySelectorAll("[data-diff-kind]");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("4−before");
    expect(rows[1]).toHaveTextContent("4+after");
    expect(rows[2]).toHaveTextContent("9−old tail");
    expect(rows[3]).toHaveTextContent("9+new tail");
  });

  it("counts three newline-terminated review hunks as three added and removed lines", async () => {
    const threeHunks = review();
    threeHunks.files[0]!.hunks = Array.from({ length: 3 }, (_, index) => ({
      ...threeHunks.files[0]!.hunks[0]!, id: `line-${index}`, oldText: `old ${index}\n`, newText: `new ${index}\n`,
    }));
    const api = reviewApi(threeHunks);
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    expect(screen.getByLabelText("Added 3 lines")).toHaveTextContent("+3");
    expect(screen.getByLabelText("Removed 3 lines")).toHaveTextContent("−3");
    expect(screen.queryByLabelText("Added 6 lines")).toBeNull();
    expect(screen.queryByLabelText("Removed 6 lines")).toBeNull();
  });

  it("bounds a large whole-hunk preview while keeping its decision controls", async () => {
    const large = review();
    large.files[0]!.hunks = [{
      ...large.files[0]!.hunks[0]!,
      oldText: "old line\n".repeat(100_000),
      newText: "new line\n".repeat(100_000),
    }];
    const api = reviewApi(large);
    const { container } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    expect(container.querySelectorAll("[data-diff-kind]").length).toBeLessThanOrEqual(200);
    expect(screen.getByText("Preview shortened. Accept or reject applies to the entire hunk.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reject hunk 1 in /project/source.ts" })).toBeEnabled();
  });

  it("paginates hunks across files and preserves the original hunk labels", async () => {
    const many = review();
    many.files[0]!.hunks = Array.from({ length: 7 }, (_, index) => ({
      ...many.files[0]!.hunks[0]!, id: `hunk-${index}`, decision: "pending" as const,
    }));
    many.files.push({ path: "/project/tail.ts", hunks: [{ ...many.files[0]!.hunks[0]!, id: "tail-hunk" }] });
    const api = reviewApi(many);
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" });
    expect(screen.getAllByRole("button", { name: /^Accept hunk/ })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Accept hunk 6 in /project/source.ts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next hunks" }));
    expect(screen.getByRole("button", { name: "Accept hunk 6 in /project/source.ts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept hunk 1 in /project/tail.ts" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Accept hunk/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Next hunks" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous hunks" }));
    expect(screen.getByRole("button", { name: "Accept hunk 1 in /project/source.ts" })).toBeVisible();
  });

  it("bounds single-line text by characters without changing the decision request", async () => {
    const large = review();
    large.files[0]!.hunks = [{ ...large.files[0]!.hunks[0]!, oldText: "o".repeat(100_000), newText: "n".repeat(100_000) }];
    const api = reviewApi(large);
    const { container } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept hunk 1 in /project/source.ts" }));
    await waitFor(() => expect(api.chatDecideTurnHunk).toHaveBeenCalledTimes(1));
    for (const row of container.querySelectorAll("[data-diff-kind]")) expect(row.textContent!.length).toBeLessThan(8300);
    expect(api.chatDecideTurnHunk).toHaveBeenCalledWith({ sessionId: "session-one", turnId: "latest-turn", version: "version-one", hunkId: "first-hunk", decision: "accept" });
  });
});

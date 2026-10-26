import "../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TurnChangeReview } from "../components/TurnChangeReview.js";
import { setLocale } from "../../../i18n/runtime.js";
import type { TurnChangeReview as Review, TurnReviewResult } from "../../../shared/turn-change-review.js";

function review(sessionId = "session-one"): Review {
  return {
    sessionId, turnId: "latest-turn",
    files: [{ path: "src/source.ts", bytes: 80, lineCount: 12, referenceable: true, hunks: [
      { id: "first-hunk", oldText: "before\n", newText: "after\n", oldStartLine: 4, newStartLine: 4, startLine: 4, endLine: 4 },
      { id: "second-hunk", oldText: "old tail", newText: "new tail", oldStartLine: 9, newStartLine: 9, startLine: 9, endLine: 9 },
    ] }],
  };
}
function reviewApi(initial = review()) {
  return { chatGetTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: true, review: initial })) };
}
function openReview() { fireEvent.click(screen.getByRole("button", { name: "Review latest turn changes" })); }
beforeEach(() => { setLocale("en"); });

describe("latest turn change review", () => {
  it("loads lazily with a collapsed readonly surface and no decision controls", async () => {
    const api = reviewApi();
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    expect(screen.getByRole("button", { name: "Review latest turn changes" })).toHaveAttribute("aria-expanded", "false");
    expect(api.chatGetTurnReview).not.toHaveBeenCalled();
    openReview();
    await screen.findByText("src/source.ts");
    expect(api.chatGetTurnReview).toHaveBeenCalledWith("session-one");
    expect(screen.queryByRole("button", { name: /accept|reject/i })).toBeNull();
    expect(screen.getByTestId("turn-review-files")).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("region")).toHaveClass("max-h-[min(15rem,32vh)]");
  });

  it("references the whole file from its header and exact current lines from a focused hunk", async () => {
    const onReference = vi.fn();
    render(<TurnChangeReview api={reviewApi()} sessionId="session-one" streaming={false} onReference={onReference} />);
    openReview();
    const file = await screen.findByRole("button", { name: "Reference src/source.ts, lines 1–12" });
    fireEvent.click(file);
    expect(onReference).toHaveBeenLastCalledWith({ path: "src/source.ts", startLine: 1, endLine: 12, turnId: "latest-turn" });
    const hunk = screen.getByRole("button", { name: "Reference hunk 2 in src/source.ts, lines 9–9" });
    hunk.focus();
    fireEvent.keyDown(hunk, { key: "Enter" });
    expect(onReference).toHaveBeenLastCalledWith({ path: "src/source.ts", startLine: 9, endLine: 9, turnId: "latest-turn", hunkId: "second-hunk" });
    expect(document.querySelector("button button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse src/source.ts" }));
    expect(screen.queryByText("after")).toBeNull();
    expect(onReference).toHaveBeenCalledTimes(2);
  });

  it("disables references when there is no current file location", async () => {
    const deleted = review();
    deleted.files[0]!.referenceable = false;
    deleted.files[0]!.lineCount = 0;
    const onReference = vi.fn();
    render(<TurnChangeReview api={reviewApi(deleted)} sessionId="session-one" streaming={false} onReference={onReference} />);
    openReview();
    await screen.findByText("src/source.ts");
    expect(screen.getByRole("button", { name: "Reference src/source.ts, lines 1–0" })).toBeDisabled();
    for (const hunk of screen.getAllByRole("button", { name: /^Reference hunk/ })) expect(hunk).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("This file has no current location to reference.")).toBeVisible();
    expect(onReference).not.toHaveBeenCalled();
  });

  it("discards a fetch after its session or scoped API changes", async () => {
    let finish!: (result: TurnReviewResult) => void;
    const api = reviewApi();
    api.chatGetTurnReview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    openReview();
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1));
    rerender(<TurnChangeReview api={reviewApi({ ...review("session-two"), files: [] })} sessionId="session-two" streaming={false} />);
    await screen.findByText("No tracked file changes in the latest turn.");
    await act(async () => { finish({ ok: true, review: review() }); });
    expect(screen.queryByText("src/source.ts")).toBeNull();
  });

  it("blocks review while streaming and reloads only the settled latest turn", async () => {
    const api = reviewApi();
    const { rerender } = render(<TurnChangeReview api={api} sessionId="session-one" streaming={true} />);
    expect(screen.getByRole("button", { name: "Review latest turn changes" })).toBeDisabled();
    expect(api.chatGetTurnReview).not.toHaveBeenCalled();
    rerender(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    openReview();
    await screen.findByText("src/source.ts");
    rerender(<TurnChangeReview api={api} sessionId="session-one" streaming={true} />);
    expect(screen.queryByText("src/source.ts")).toBeNull();
    api.chatGetTurnReview.mockResolvedValue({ ok: true, review: { ...review(), turnId: "empty-turn", files: [] } });
    rerender(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    await screen.findByText("No tracked file changes in the latest turn.");
  });

  it("hides transport details and permits a reload", async () => {
    const api = reviewApi();
    api.chatGetTurnReview.mockRejectedValueOnce(new Error("private host details"));
    render(<TurnChangeReview api={api} sessionId="session-one" streaming={false} />);
    openReview();
    await screen.findByRole("alert");
    expect(screen.queryByText("private host details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload review" }));
    await screen.findByText("src/source.ts");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses exact old and current line numbers without trailing newline artifacts", async () => {
    const { container } = render(<TurnChangeReview api={reviewApi()} sessionId="session-one" streaming={false} />);
    openReview();
    await screen.findByText("src/source.ts");
    const rows = container.querySelectorAll("[data-diff-kind]");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("4−before");
    expect(rows[1]).toHaveTextContent("4+after");
    expect(screen.getByLabelText("Added 2 lines")).toHaveTextContent("+2");
  });

  it("bounds long previews and paginates hunks while retaining exact reference metadata", async () => {
    const many = review();
    many.files[0]!.hunks = Array.from({ length: 7 }, (_, index) => ({ ...many.files[0]!.hunks[0]!, id: `hunk-${index}`, oldText: "old\n".repeat(100_000), newText: "n".repeat(100_000) }));
    const onReference = vi.fn();
    const { container } = render(<TurnChangeReview api={reviewApi(many)} sessionId="session-one" streaming={false} onReference={onReference} />);
    openReview();
    await screen.findByText("src/source.ts");
    expect(screen.getAllByRole("button", { name: /^Reference hunk/ })).toHaveLength(5);
    expect(container.querySelectorAll("[data-diff-kind]").length).toBeLessThanOrEqual(505);
    for (const row of container.querySelectorAll("[data-diff-kind]")) expect(row.textContent!.length).toBeLessThan(8300);
    fireEvent.click(screen.getByRole("button", { name: "Next hunks" }));
    fireEvent.click(screen.getByRole("button", { name: "Reference hunk 7 in src/source.ts, lines 4–4" }));
    expect(onReference).toHaveBeenCalledWith({ path: "src/source.ts", startLine: 4, endLine: 4, turnId: "latest-turn", hunkId: "hunk-6" });
  });
});

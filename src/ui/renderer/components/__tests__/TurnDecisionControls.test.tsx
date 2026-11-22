// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TurnReviewFile, TurnReviewHunk } from "../../../../shared/turn-change-review.js";
import { TurnChangeDetail } from "../TurnChangeDetail.js";
import { LatestTurnSummary } from "../LatestTurnSummary.js";
import { deriveWorkspaceChanges, type WorkspaceChanges } from "../../preview/workspace-changes.js";
import { setLocale } from "../../../../i18n/runtime.js";

/** Keep and undo for a hunk, a file and the turn act on one press, with no confirmation step. */
beforeEach(() => { setLocale("en"); });

const hunk = (id: string, kept = false): TurnReviewHunk => ({
  id, oldText: `old ${id}\n`, newText: `new ${id}\n`, oldStartLine: 3, newStartLine: 3, startLine: 3, endLine: 3, kept,
});

function file(overrides: Partial<TurnReviewFile> = {}): TurnReviewFile {
  return {
    path: "src/source.ts", bytes: 30, lineCount: 4, referenceable: true, decidable: true,
    added: 2, removed: 2, operation: "modify", countsKnown: true,
    hunks: [hunk("a".repeat(64)), hunk("b".repeat(64))],
    ...overrides,
  };
}

function changes(files: TurnReviewFile[], extra: Partial<WorkspaceChanges> = {}): WorkspaceChanges {
  return {
    ...deriveWorkspaceChanges({ files: [], targets: [], workspaceRoot: "/work", review: { sessionId: "s", turnId: "t", workspaceRoot: "/work", files } }),
    ...extra,
  };
}

describe("hunk and file decisions in the change detail", () => {
  it("keeps or undoes exactly the pressed hunk", () => {
    const onDecide = vi.fn();
    render(<TurnChangeDetail file={file()} turnId="turn-1" onDecide={onDecide} />);
    const hunks = screen.getAllByTestId("turn-review-hunk");
    expect(hunks).toHaveLength(2);
    fireEvent.click(within(hunks[1]).getByRole("button", { name: "Undo change 2 in src/source.ts" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "undo", scope: "hunk", path: "src/source.ts", hunkId: "b".repeat(64) });
    fireEvent.click(within(hunks[0]).getByRole("button", { name: "Keep change 1 in src/source.ts" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "keep", scope: "hunk", path: "src/source.ts", hunkId: "a".repeat(64) });
    // One press, one decision: nothing asks "are you sure".
    expect(onDecide).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps or undoes the whole file from the header", () => {
    const onDecide = vi.fn();
    render(<TurnChangeDetail file={file()} turnId="turn-1" onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep changes to src/source.ts" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "keep", scope: "file", path: "src/source.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Undo changes to src/source.ts" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "undo", scope: "file", path: "src/source.ts" });
  });

  it("shows a kept hunk as kept and still lets it be undone", () => {
    render(<TurnChangeDetail file={file({ hunks: [hunk("a".repeat(64), true), hunk("b".repeat(64))] })} turnId="turn-1" onDecide={vi.fn()} />);
    const [kept, pending] = screen.getAllByTestId("turn-review-hunk");
    expect(kept).toHaveAttribute("data-kept", "true");
    expect(within(kept).getByTestId("turn-decision-kept")).toHaveTextContent("Kept");
    expect(within(kept).queryByTestId("turn-decision-keep")).toBeNull();
    expect(within(kept).getByTestId("turn-decision-undo")).toBeEnabled();
    expect(within(pending).getByTestId("turn-decision-keep")).toBeEnabled();
  });

  it("disables the controls while a decision is applied or the file no longer holds the turn's result", () => {
    const { rerender } = render(<TurnChangeDetail file={file()} turnId="turn-1" onDecide={vi.fn()} deciding />);
    for (const button of screen.getAllByTestId("turn-decision-undo")) expect(button).toBeDisabled();
    rerender(<TurnChangeDetail file={file({ decidable: false })} turnId="turn-1" onDecide={vi.fn()} />);
    for (const button of screen.getAllByTestId("turn-decision-keep")) expect(button).toBeDisabled();
  });

  it("offers no decision where the review is read-only and says why a decision was refused", () => {
    const { rerender } = render(<TurnChangeDetail file={file()} turnId="turn-1" />);
    expect(screen.queryByTestId("turn-decision")).toBeNull();
    rerender(<TurnChangeDetail file={file()} turnId="turn-1" onDecide={vi.fn()} decisionError="turn-review-write-denied" />);
    expect(screen.getByTestId("turn-decision-error")).toHaveTextContent("Ave is not allowed to write this file");
    // An undo that stopped part-way does not read like a refusal that changed nothing.
    rerender(<TurnChangeDetail file={file()} turnId="turn-1" onDecide={vi.fn()} decisionError="turn-review-partial" />);
    expect(screen.getByTestId("turn-decision-error")).toHaveTextContent("Only some files were undone.");
    // An undo that changed every file but could not read the review afterwards says the files were undone.
    rerender(<TurnChangeDetail file={file()} turnId="turn-1" onDecide={vi.fn()} decisionError="turn-review-applied" />);
    expect(screen.getByTestId("turn-decision-error")).toHaveTextContent("The change was undone, but the list of changes could not be read again.");
  });
});

describe("turn and file decisions in the latest-turn summary", () => {
  it("keeps or undoes the whole turn from the summary header", () => {
    const onDecide = vi.fn();
    render(<LatestTurnSummary changes={changes([file(), file({ path: "src/other.ts" })], { onDecide })} onReveal={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo all of this turn's changes" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "undo", scope: "turn" });
    fireEvent.click(screen.getByRole("button", { name: "Keep all of this turn's changes" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "keep", scope: "turn" });
  });

  it("keeps or undoes one file from its row", () => {
    const onDecide = vi.fn();
    render(<LatestTurnSummary changes={changes([file(), file({ path: "src/other.ts" })], { onDecide })} onReveal={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo changes to src/other.ts" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "undo", scope: "file", path: "src/other.ts" });
  });

  it("marks the turn kept once every hunk is kept and disables the turn controls when a file is stale", () => {
    const allKept = file({ hunks: [hunk("a".repeat(64), true)] });
    const { rerender } = render(<LatestTurnSummary changes={changes([allKept], { onDecide: vi.fn() })} onReveal={vi.fn()} />);
    const turn = screen.getAllByTestId("turn-decision").filter((node) => node.getAttribute("data-scope") === "turn");
    expect(turn).toHaveLength(1);
    expect(turn[0]).toHaveAttribute("data-kept", "true");
    rerender(<LatestTurnSummary changes={changes([file(), file({ path: "src/other.ts", decidable: false })], { onDecide: vi.fn() })} onReveal={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Undo all of this turn's changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo changes to src/source.ts" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Undo changes to src/other.ts" })).toBeDisabled();
  });
});

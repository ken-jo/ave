// @vitest-environment jsdom
import { notifyWorkspaceFilesChanged, subscribeWorkspaceFilesChanged } from "../../utils/workspace-files-signal.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceChanges } from "../use-workspace-changes.js";
import type { TurnReviewResult } from "../../../../shared/turn-change-review.js";
const review = (sessionId: string, turnId = "turn"): TurnReviewResult => ({ ok: true, review: { sessionId, turnId,
  files: [{ path: "source.txt", bytes: 5, lineCount: 1, added: 1, removed: 1, operation: "modify", countsKnown: true, referenceable: true, decidable: true, hunks: [] }],
} });
const files: import("../../preview/preview-targets.js").WorkspaceFileItem[] = [];
const targets: import("../../preview/preview-targets.js").ChatPreviewTarget[] = [];
describe("shared workspace changes", () => {
  it("loads once for both consumers, clears during streaming and reloads the settled turn", async () => {
    const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)), chatDecideTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: false, error: "turn-review-unavailable" })) };
    const { result, rerender } = renderHook(({ streaming }) => useWorkspaceChanges({ api, sessionId: "session", streaming, turnKey: "turn", files, targets }), { initialProps: { streaming: false } });
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1);
    rerender({ streaming: true });
    expect(result.current.latestFiles).toHaveLength(0);
    rerender({ streaming: false });
    await waitFor(() => {
      expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2);
      expect(result.current.latestFiles).toHaveLength(1);
    });
  });
  it("ignores a replaced session's late response and hides unavailable or failed captures", async () => {
    let finish!: (result: TurnReviewResult) => void;
    const api = { chatGetTurnReview: vi.fn(async (_session: string): Promise<TurnReviewResult> => new Promise((resolve) => { finish = resolve; })), chatDecideTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: false, error: "turn-review-unavailable" })) };
    const { result, rerender } = renderHook(({ sessionId }) => useWorkspaceChanges({ api, sessionId, streaming: false, turnKey: "turn", files, targets }), { initialProps: { sessionId: "old" } });
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1));
    const oldFinish = finish;
    rerender({ sessionId: "new" });
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
    await act(async () => { oldFinish(review("old")); finish({ ok: false, error: "turn-review-unavailable" }); });
    expect(result.current.latestFiles).toEqual([]);
  });
  it("does not expose a stale API or turn snapshot while the next request is pending", async () => {
    const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)), chatDecideTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: false, error: "turn-review-unavailable" })) };
    const { result, rerender } = renderHook(({ turnKey }) => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey, files, targets }), { initialProps: { turnKey: "first" } });
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    api.chatGetTurnReview.mockImplementationOnce(async () => new Promise(() => {}));
    rerender({ turnKey: "second" });
    expect(result.current.latestFiles).toEqual([]);
  });
});

it("waits for refreshed data after same-turn regeneration instead of reviving the old snapshot", async () => {
  let resolveRefresh!: (result: TurnReviewResult) => void;
  const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)), chatDecideTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: false, error: "turn-review-unavailable" })) };
  const { result, rerender } = renderHook(({ streaming }) => useWorkspaceChanges({ api, sessionId: "session", streaming, turnKey: "same-turn", files, targets }), { initialProps: { streaming: false } });
  await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
  rerender({ streaming: true });
  api.chatGetTurnReview.mockImplementationOnce(async () => new Promise((resolve) => { resolveRefresh = resolve; }));
  rerender({ streaming: false });
  expect(result.current.latestFiles).toHaveLength(0);
  await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
  await act(async () => { resolveRefresh(review("session", "same-turn")); });
  expect(result.current.latestFiles).toHaveLength(1);
});

it("refreshes current details without replacing recorded totals or overlapping reads", async () => {
  let finish!: (result: TurnReviewResult) => void;
  const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)), chatDecideTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: false, error: "turn-review-unavailable" })) };
  const { result } = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "same-turn", files, targets }));
  await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
  api.chatGetTurnReview.mockImplementationOnce(async () => new Promise((resolve) => { finish = resolve; }));
  act(() => { result.current.onRefresh?.(); result.current.onRefresh?.(); });
  await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
  expect(result.current.added).toBe(1);
  expect(result.current.latestFiles[0]?.review?.referenceable).toBe(false);
  await act(async () => { finish(review("session")); });
  await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(result.current.latestFiles[0]?.review?.referenceable).toBe(true));
});

describe("workspace change decisions", () => {
  it("replaces the review with the one a decision returns, without asking again", async () => {
    const decided: TurnReviewResult = { ok: true, review: { sessionId: "session", turnId: "turn", files: [] } };
    const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)), chatDecideTurnReview: vi.fn(async () => decided) };
    const { result } = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "turn", files, targets }));
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    await act(async () => { result.current.onDecide({ action: "undo", scope: "turn" }); });
    // The decision names the turn whose review was on screen.
    expect(api.chatDecideTurnReview).toHaveBeenCalledWith("session", { action: "undo", scope: "turn", turnId: "turn" });
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(0));
    expect(result.current.decisionError).toBeNull();
    expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1);
  });
  it("tells every file surface after an undo rewrote files, without asking for its own review again", async () => {
    const decided: TurnReviewResult = { ok: true, review: { sessionId: "session", turnId: "turn", files: [] } };
    const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)), chatDecideTurnReview: vi.fn(async () => decided) };
    const heard = vi.fn();
    const unsubscribe = subscribeWorkspaceFilesChanged(heard);
    const { result } = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "turn", files, targets }));
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    await act(async () => { result.current.onDecide({ action: "keep", scope: "turn" }); });
    // Keep writes nothing, so no file surface is disturbed.
    expect(heard).not.toHaveBeenCalled();
    await act(async () => { result.current.onDecide({ action: "undo", scope: "turn" }); });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it("asks for the review again when files changed elsewhere, such as a text saved in the folder view", async () => {
    const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)), chatDecideTurnReview: vi.fn() };
    const { result, unmount } = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "turn", files, targets }));
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1);
    await act(async () => { notifyWorkspaceFilesChanged("manual"); });
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
    unmount();
    await act(async () => { notifyWorkspaceFilesChanged("manual"); });
    expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2);
  });
  it("reports a refused decision and asks for the current review again", async () => {
    const api = {
      chatGetTurnReview: vi.fn(async (session: string) => review(session)),
      chatDecideTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: false, error: "turn-review-stale" })),
    };
    const { result } = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "turn", files, targets }));
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    await act(async () => { result.current.onDecide({ action: "keep", scope: "file", path: "source.txt" }); });
    await waitFor(() => expect(result.current.decisionError).toBe("turn-review-stale"));
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
    expect(result.current.latestFiles).toHaveLength(1);
  });
  it("tells every file surface after any settled undo, also one that answered with an error after changing files", async () => {
    const api = {
      chatGetTurnReview: vi.fn(async (session: string) => review(session)),
      chatDecideTurnReview: vi.fn(async (): Promise<TurnReviewResult> => ({ ok: false, error: "turn-review-stale" })),
    };
    // Two surfaces that show files at once: an open file and a folder list.
    const openFile = vi.fn();
    const folderList = vi.fn();
    const unsubscribes = [subscribeWorkspaceFilesChanged(openFile), subscribeWorkspaceFilesChanged(folderList)];
    const { result } = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "turn", files, targets }));
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    // Keep writes nothing: no surface is disturbed, whatever it answers.
    await act(async () => { result.current.onDecide({ action: "keep", scope: "turn" }); });
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
    expect(openFile).not.toHaveBeenCalled();
    // An undo answered with an error may still have changed files (the review read after it can fail, or it can stop
    // part-way), and a lost answer says nothing either way: each tells both surfaces once.
    const outcomes: Array<() => Promise<TurnReviewResult>> = [
      async () => ({ ok: false, error: "turn-review-stale" }),
      async () => ({ ok: false, error: "turn-review-applied" }),
      async () => ({ ok: false, error: "turn-review-partial" }),
      async () => { throw new Error("lost"); },
    ];
    for (const [index, outcome] of outcomes.entries()) {
      api.chatDecideTurnReview.mockImplementationOnce(outcome);
      await act(async () => { result.current.onDecide({ action: "undo", scope: "turn" }); });
      await waitFor(() => expect(result.current.deciding).toBe(false));
      expect(openFile).toHaveBeenCalledTimes(index + 1);
      expect(folderList).toHaveBeenCalledTimes(index + 1);
    }
    expect(result.current.decisionError).toBe("turn-review-failed");
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
  it("tells the other file surfaces after an undo whose view was replaced or closed while it was on its way", async () => {
    const finishes: Array<{ resolve: (result: TurnReviewResult) => void; reject: (error: Error) => void }> = [];
    const api = {
      chatGetTurnReview: vi.fn(async (session: string) => review(session)),
      chatDecideTurnReview: vi.fn((): Promise<TurnReviewResult> => new Promise((resolve, reject) => { finishes.push({ resolve, reject }); })),
    };
    const openFile = vi.fn();
    const unsubscribe = subscribeWorkspaceFilesChanged(openFile);
    // The view switches to another conversation while its undo is on its way, and the undo then answers that it happened.
    const switched = renderHook(({ sessionId }) => useWorkspaceChanges({ api, sessionId, streaming: false, turnKey: "turn", files, targets }), { initialProps: { sessionId: "session" } });
    await waitFor(() => expect(switched.result.current.latestFiles).toHaveLength(1));
    await act(async () => { switched.result.current.onDecide({ action: "undo", scope: "turn" }); });
    switched.rerender({ sessionId: "other" });
    await act(async () => { finishes[0]?.resolve({ ok: false, error: "turn-review-applied" }); });
    expect(openFile).toHaveBeenCalledTimes(1);
    switched.unmount();
    // A view closed while its undo is on its way, whose answer never comes back.
    const closed = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "turn", files, targets }));
    await waitFor(() => expect(closed.result.current.latestFiles).toHaveLength(1));
    await act(async () => { closed.result.current.onDecide({ action: "undo", scope: "turn" }); });
    closed.unmount();
    await act(async () => { finishes[1]?.reject(new Error("lost")); });
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(finishes).toHaveLength(2);
    unsubscribe();
  });
  it("sends one decision at a time", async () => {
    let finish!: (result: TurnReviewResult) => void;
    const api = {
      chatGetTurnReview: vi.fn(async (session: string) => review(session)),
      chatDecideTurnReview: vi.fn((): Promise<TurnReviewResult> => new Promise((resolve) => { finish = resolve; })),
    };
    const { result } = renderHook(() => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey: "turn", files, targets }));
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    act(() => { result.current.onDecide({ action: "undo", scope: "turn" }); result.current.onDecide({ action: "undo", scope: "turn" }); });
    expect(api.chatDecideTurnReview).toHaveBeenCalledTimes(1);
    expect(result.current.deciding).toBe(true);
    await act(async () => { finish(review("session")); });
    expect(result.current.deciding).toBe(false);
  });
});

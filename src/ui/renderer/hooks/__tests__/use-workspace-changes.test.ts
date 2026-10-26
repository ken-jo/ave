// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceChanges } from "../use-workspace-changes.js";
import type { TurnReviewResult } from "../../../../shared/turn-change-review.js";
const review = (sessionId: string, turnId = "turn"): TurnReviewResult => ({ ok: true, review: { sessionId, turnId,
  files: [{ path: "source.txt", bytes: 5, lineCount: 1, added: 1, removed: 1, operation: "modify", countsKnown: true, referenceable: true, hunks: [] }],
} });
const files: import("../../preview/preview-targets.js").WorkspaceFileItem[] = [];
const targets: import("../../preview/preview-targets.js").ChatPreviewTarget[] = [];
describe("shared workspace changes", () => {
  it("loads once for both consumers, clears during streaming and reloads the settled turn", async () => {
    const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)) };
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
    const api = { chatGetTurnReview: vi.fn(async (_session: string): Promise<TurnReviewResult> => new Promise((resolve) => { finish = resolve; })) };
    const { result, rerender } = renderHook(({ sessionId }) => useWorkspaceChanges({ api, sessionId, streaming: false, turnKey: "turn", files, targets }), { initialProps: { sessionId: "old" } });
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(1));
    const oldFinish = finish;
    rerender({ sessionId: "new" });
    await waitFor(() => expect(api.chatGetTurnReview).toHaveBeenCalledTimes(2));
    await act(async () => { oldFinish(review("old")); finish({ ok: false, error: "turn-review-unavailable" }); });
    expect(result.current.latestFiles).toEqual([]);
  });
  it("does not expose a stale API or turn snapshot while the next request is pending", async () => {
    const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)) };
    const { result, rerender } = renderHook(({ turnKey }) => useWorkspaceChanges({ api, sessionId: "session", streaming: false, turnKey, files, targets }), { initialProps: { turnKey: "first" } });
    await waitFor(() => expect(result.current.latestFiles).toHaveLength(1));
    api.chatGetTurnReview.mockImplementationOnce(async () => new Promise(() => {}));
    rerender({ turnKey: "second" });
    expect(result.current.latestFiles).toEqual([]);
  });
});

it("waits for refreshed data after same-turn regeneration instead of reviving the old snapshot", async () => {
  let resolveRefresh!: (result: TurnReviewResult) => void;
  const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)) };
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
  const api = { chatGetTurnReview: vi.fn(async (session: string) => review(session)) };
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

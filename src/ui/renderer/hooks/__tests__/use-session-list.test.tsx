// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { A2ATaskState } from "../../../../shared/a2a.js";
import type { AgentSpawnEvent } from "../../../../shared/subagent-events.js";
import type { SessionListResult, SessionListRow } from "../../../../shared/session-lookup.js";
import type { AveApi } from "../../types.js";
import { sessionRow } from "../../../../../test/renderer/mock-ave-api.js";
import { deferred } from "../../../../../test/renderer/helpers.js";
import { nestSessionEntries, treeEntries } from "../../components/sidebar/project-tree-model.js";
import { useSessionList } from "../use-sessions.js";

afterEach(cleanup);

it.each([false, true])("refreshes a replacement API after the previous query settled=%s", async (settled) => {
  const previous = deferred<SessionListResult>();
  const next = deferred<SessionListResult>();
  const previousApi = { chatSessions: vi.fn(() => previous.promise) } as unknown as AveApi;
  const nextApi = { chatSessions: vi.fn(() => next.promise) } as unknown as AveApi;
  const { result, rerender } = renderHook(({ api }) => useSessionList(api), { initialProps: { api: previousApi } });
  const refresh = result.current.refreshSessions();
  if (settled) await act(async () => { previous.resolve(PAGE); await refresh; });
  rerender({ api: nextApi });
  expect(nextApi.chatSessions).toHaveBeenCalledOnce();
  expect(result.current.sessions).toEqual([]);
  await act(async () => { previous.resolve(PAGE); await refresh; });
  expect(result.current.sessions).toEqual([]);
  const latest = page([{ ...child, title: "Replacement", running: false }]);
  await act(async () => { next.resolve(latest); await next.promise; });
  expect(result.current.sessions).toBe(latest.sidebar.rows);
});
const parent = sessionRow({ id: "aaaaaaaa-1111-4111-8111-111111111111", title: "Parent", modifiedAt: "2026-11-01T00:00:00Z" });
const child = sessionRow({ id: "sub-aaaaaaaa-bbbbbbbb-1111-4111-8111-111111111111", title: "Research", modifiedAt: "2026-11-09T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: parent.id, running: true });
const EVENT: AgentSpawnEvent = { type: "activity", spawnId: "spawn", parentSessionId: parent.id, childSessionId: child.id, taskState: A2ATaskState.WORKING };
function page(rows: SessionListRow[], hiddenRoots: Record<string, number> = {}) {
  return { current: parent.id, sessions: [], related: [], sidebar: { rows, hiddenRoots } } satisfies SessionListResult;
}
const PAGE = page([child, parent]);
function harness(chatSessions = vi.fn().mockResolvedValue(PAGE)) {
  let emit: (event: AgentSpawnEvent) => void = () => {};
  const unsubscribe = vi.fn();
  // The legacy transport method catches accidental snapshot reads.
  const agentSpawnSnapshot = vi.fn();
  const api = { chatSessions, agentSpawnSnapshot, onAgentSpawnEvent: (handler: typeof emit) => { emit = handler; return unsubscribe; } } as unknown as AveApi;
  return { ...renderHook(() => useSessionList(api)), chatSessions, agentSpawnSnapshot, unsubscribe, emit: (event: AgentSpawnEvent) => emit(event) };
}

it("applies running responses while activity keeps a six-query refresh queue busy", async () => {
  const responses = Array.from({ length: 6 }, () => deferred<SessionListResult>());
  const chatSessions = vi.fn();
  for (const response of responses) chatSessions.mockReturnValueOnce(response.promise);
  const { result, emit } = harness(chatSessions);
  const refresh = result.current.refreshSessions();
  const applied: string[] = [];
  for (const [index, response] of responses.slice(0, -1).entries()) {
    act(() => emit(EVENT));
    const running = page([{ ...child, title: `Running ${index + 1}` }, parent]);
    await act(async () => { response.resolve(running); await response.promise; });
    const current = result.current.sessions.find((row) => row.id === child.id);
    if (current?.running) applied.push(current.title);
    expect(chatSessions).toHaveBeenCalledTimes(index + 2);
  }
  const quiet = responses.at(-1);
  if (!quiet) throw new Error("missing-final-response");
  const completed = page([{ ...child, running: false }, parent]);
  await act(async () => { quiet.resolve(completed); await refresh; });
  expect(applied).toEqual(["Running 1", "Running 2", "Running 3", "Running 4", "Running 5"]);
  expect(result.current.sessions).toBe(completed.sidebar.rows);
  expect(chatSessions).toHaveBeenCalledTimes(6);
});

it("coalesces every event type into one in-flight query and one pending query", async () => {
  const first = deferred<SessionListResult>();
  const second = deferred<SessionListResult>();
  const chatSessions = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, emit, unmount, unsubscribe, agentSpawnSnapshot } = harness(chatSessions);
  const refresh = result.current.refreshSessions();
  act(() => {
    for (let index = 0; index < 100; index += 1) {
      for (const type of ["start", "activity", "done", "error"] as const) emit({ ...EVENT, type, childSessionId: undefined });
    }
  });
  expect(chatSessions).toHaveBeenCalledTimes(1);
  await act(async () => { first.resolve(page([parent])); await first.promise; });
  expect(chatSessions).toHaveBeenCalledTimes(2);
  expect(result.current.sessions).toEqual([parent]);
  await act(async () => { second.resolve(PAGE); await refresh; });
  expect(result.current.sessions).toBe(PAGE.sidebar.rows);
  expect(agentSpawnSnapshot).not.toHaveBeenCalled();
  expect(chatSessions.mock.calls.every(([query]) => !Object.hasOwn(query, "id"))).toBe(true);
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("replaces a deleted parent and keeps its surviving children reachable as roots", async () => {
  const other = { ...child, id: "sub-aaaaaaaa-cccccccc-1111-4111-8111-111111111111" };
  const latest = page([other, child], { "": 3 });
  const { result } = harness(vi.fn().mockResolvedValueOnce(PAGE).mockResolvedValue(latest));
  await act(() => result.current.refreshSessions());
  await act(() => result.current.refreshSessions());
  expect(result.current.sessions).toBe(latest.sidebar.rows);
  expect(result.current.hiddenRoots).toBe(latest.sidebar.hiddenRoots);
  expect(result.current.sessions.some((row) => row.id === parent.id)).toBe(false);
  expect(nestSessionEntries(treeEntries({ sessions: result.current.sessions, surfaces: [], isPinned: () => false, surfaceAt: () => 0 })))
    .toMatchObject([{ session: other, children: [] }, { session: child, children: [] }]);
});

it("applies issued expansion responses while newer parent options are pending", async () => {
  const stale = deferred<SessionListResult>();
  const newest = deferred<SessionListResult>();
  const latest = page([{ ...child, title: "Current child" }, { ...parent, title: "Current parent" }]);
  const chatSessions = vi.fn().mockResolvedValueOnce(PAGE).mockReturnValueOnce(stale.promise).mockReturnValueOnce(newest.promise);
  const { result } = harness(chatSessions);
  await act(() => result.current.refreshSessions());
  act(() => result.current.configureSessions({ rootLimit: 20, expandedParentIds: [parent.id] }));
  act(() => result.current.configureSessions({ rootLimit: 20, expandedParentIds: [parent.id], rootLimits: { "": 40 } }));
  await act(async () => { stale.resolve(page([])); await stale.promise; });
  expect(result.current.sessions).toEqual([]);
  expect(chatSessions).toHaveBeenCalledTimes(3);
  const refresh = result.current.refreshSessions;
  await act(async () => { newest.resolve(latest); await newest.promise; });
  expect(result.current.sessions).toBe(latest.sidebar.rows);
  expect(chatSessions.mock.calls[2]?.[0]?.sidebar).toEqual({ rootLimit: 20, expandedParentIds: [parent.id], rootLimits: { "": 40 } });
  act(() => result.current.configureSessions({ rootLimit: 20, expandedParentIds: [parent.id], rootLimits: { "": 40 } }));
  expect(chatSessions).toHaveBeenCalledTimes(3);
  expect(result.current.refreshSessions).toBe(refresh);
});

it("preserves the latest projection on a failed query and retries on reconnect", async () => {
  const latest = page([{ ...child, running: false, attention: true }, parent]);
  const chatSessions = vi.fn().mockResolvedValueOnce(PAGE).mockRejectedValueOnce(new Error("read-failed")).mockResolvedValue(latest);
  const { result, agentSpawnSnapshot } = harness(chatSessions);
  await act(() => result.current.refreshSessions());
  await act(() => result.current.refreshSessions());
  expect(result.current.sessions).toBe(PAGE.sidebar.rows);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(result.current.sessions).toBe(latest.sidebar.rows);
  expect(agentSpawnSnapshot).not.toHaveBeenCalled();
});

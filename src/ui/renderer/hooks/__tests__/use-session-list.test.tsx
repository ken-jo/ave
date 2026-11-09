// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { A2ATaskState } from "../../../../shared/a2a.js";
import type { AgentSpawnEvent } from "../../../../shared/subagent-events.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { AveApi } from "../../types.js";
import { sessionRow } from "../../../../../test/renderer/mock-ave-api.js";
import { deferred } from "../../../../../test/renderer/helpers.js";
import type { SessionListQuery, SessionListResult } from "../../../../shared/session-lookup.js";
import { useSessionList } from "../use-sessions.js";

afterEach(cleanup);


const PARENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const CHILD_ID = "sub-aaaaaaaa-bbbbbbbb-1111-4111-8111-111111111111";
const START_EVENT: AgentSpawnEvent<ChatEntry> = {
  type: "start", spawnId: "spawn", parentSessionId: PARENT_ID,
  taskState: A2ATaskState.SUBMITTED, title: "Research",
};
const ACTIVITY_EVENT: AgentSpawnEvent<ChatEntry> = {
  ...START_EVENT, type: "activity", childSessionId: CHILD_ID, taskState: A2ATaskState.WORKING,
};
const parent = sessionRow({ id: PARENT_ID, title: "Parent", modifiedAt: "2026-11-01T00:00:00Z" });
const child = sessionRow({ id: CHILD_ID, title: "Research", modifiedAt: "2026-11-09T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: PARENT_ID, running: false });

it("inserts a running child on activity after a production start without a child id, deduplicating in-flight reads", async () => {
  let listener: (event: AgentSpawnEvent<ChatEntry>) => void = () => { throw new Error("missing-spawn-listener"); };
  const point = deferred<SessionListResult>();
  const unsubscribe = vi.fn();
  const chatSessions = vi.fn((query?: SessionListQuery) => query?.id ? point.promise : Promise.resolve({ current: PARENT_ID, sessions: [] }));
  const api = { chatSessions, onAgentSpawnEvent: (handler: typeof listener) => { listener = handler; return unsubscribe; } } as unknown as AveApi;
  const { result, unmount } = renderHook(() => useSessionList(api));
  await act(() => result.current.refreshSessions());
  expect(START_EVENT).not.toHaveProperty("childSessionId");
  act(() => listener(START_EVENT));
  act(() => { for (let index = 0; index < 100; index += 1) listener(ACTIVITY_EVENT); });
  expect(chatSessions.mock.calls.filter(([query]) => query?.id === CHILD_ID)).toHaveLength(1);
  expect(chatSessions.mock.calls.filter(([query]) => !query?.id)).toHaveLength(1);
  await act(async () => { point.resolve({ current: PARENT_ID, sessions: [child], parents: [parent] }); await point.promise; });
  await waitFor(() => expect(result.current.sessions.find((row) => row.id === CHILD_ID)?.running).toBe(true));
  const previous = result.current.sessions;
  act(() => listener(ACTIVITY_EVENT));
  expect(result.current.sessions).toBe(previous);
  expect(chatSessions).toHaveBeenCalledTimes(2);
  await act(() => result.current.refreshSessions());
  expect(result.current.sessions.map((row) => row.id).sort()).toEqual([PARENT_ID, CHILD_ID].sort());
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("retains a terminal event that arrives before its single-row request resolves", async () => {
  let listener: (event: AgentSpawnEvent<ChatEntry>) => void = () => { throw new Error("missing-spawn-listener"); };
  const point = deferred<SessionListResult>();
  const chatSessions = vi.fn((query?: SessionListQuery) => query?.id ? point.promise : Promise.resolve({ current: PARENT_ID, sessions: [] }));
  const api = { chatSessions, onAgentSpawnEvent: (handler: typeof listener) => { listener = handler; return () => {}; } } as unknown as AveApi;
  const { result } = renderHook(() => useSessionList(api));
  await act(() => result.current.refreshSessions());
  act(() => listener(START_EVENT));
  act(() => listener(ACTIVITY_EVENT));
  expect(chatSessions).toHaveBeenCalledWith(expect.objectContaining({ id: CHILD_ID }));
  await act(async () => { listener({ ...ACTIVITY_EVENT, type: "done", taskState: A2ATaskState.COMPLETED }); });
  await act(async () => { point.resolve({ current: PARENT_ID, sessions: [{ ...child, running: true }], parents: [parent] }); await point.promise; });
  await waitFor(() => expect(result.current.sessions.find((row) => row.id === CHILD_ID)?.running).toBe(false));
});

it("keeps the newest page when an earlier refresh resolves after it", async () => {
  const earlier = deferred<SessionListResult>();
  const latest = deferred<SessionListResult>();
  const chatSessions = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise);
  const api = { chatSessions } as unknown as AveApi;
  const { result } = renderHook(() => useSessionList(api));
  const first = result.current.refreshSessions();
  const second = result.current.refreshSessions();
  await act(async () => { latest.resolve({ current: PARENT_ID, sessions: [parent] }); await second; });
  await act(async () => { earlier.resolve({ current: PARENT_ID, sessions: [] }); await first; });
  expect(result.current.sessions).toEqual([parent]);
});

it("merges recovered parents and later primary rows by id across row pages", async () => {
  const parent = sessionRow({ id: "parent", title: "Parent", modifiedAt: "2026-11-01T00:00:00Z" });
  const child = sessionRow({ id: "child", title: "Child", modifiedAt: "2026-11-09T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: parent.id });
  const chatSessions = vi.fn().mockResolvedValueOnce({ sessions: [child], parents: [parent] }).mockResolvedValueOnce({ sessions: [{ ...parent, title: "Updated parent" }], parents: [] });
  const { result } = renderHook(() => useSessionList({ chatSessions } as unknown as AveApi));
  await act(() => result.current.refreshSessions());
  expect(result.current.sessions.map((row) => row.id)).toEqual([parent.id, child.id]);
  const cursor = { before: child.modifiedAt, beforeId: child.id };
  await act(() => result.current.loadSessionsPage(cursor));
  expect(chatSessions).toHaveBeenLastCalledWith(expect.objectContaining(cursor));
  expect(result.current.sessions).toHaveLength(2);
  expect(result.current.sessions.find((row) => row.id === parent.id)?.title).toBe("Updated parent");
});

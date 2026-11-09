// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { A2ATaskState } from "../../../../shared/a2a.js";
import type { AgentSpawnEvent, SessionActivity, SessionActivitySnapshot } from "../../../../shared/subagent-events.js";
import type { AveApi } from "../../types.js";
import { sessionRow } from "../../../../../test/renderer/mock-ave-api.js";
import { deferred } from "../../../../../test/renderer/helpers.js";
import type { SessionListResult } from "../../../../shared/session-lookup.js";
import { nestSessionEntries, sessionBranchExpanded, treeEntries } from "../../components/sidebar/project-tree-model.js";
import { useSessionList } from "../use-sessions.js";

afterEach(cleanup);
const PARENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const CHILD_ID = "sub-aaaaaaaa-bbbbbbbb-1111-4111-8111-111111111111";
const parent = sessionRow({ id: PARENT_ID, title: "Parent", modifiedAt: "2026-11-01T00:00:00Z" });
const child = sessionRow({ id: CHILD_ID, title: "Research", modifiedAt: "2026-11-09T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: PARENT_ID });
const PAGE = { current: PARENT_ID, sessions: [child], related: [parent] };
const START: AgentSpawnEvent = { type: "start", spawnId: "spawn", parentSessionId: PARENT_ID, title: "Research", taskState: A2ATaskState.SUBMITTED };
const ACTIVE: SessionActivity = { sessionId: CHILD_ID, sequence: 2, running: true, attention: false };
const EVENT: AgentSpawnEvent = { ...START, type: "activity", childSessionId: CHILD_ID, taskState: A2ATaskState.WORKING, activity: ACTIVE };
function harness(chatSessions = vi.fn().mockResolvedValue(PAGE), agentSpawnSnapshot = vi.fn().mockResolvedValue({ sequence: 0, sessions: [] })) {
  let emit: (event: AgentSpawnEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const api = { chatSessions, agentSpawnSnapshot, onAgentSpawnEvent: (handler: typeof emit) => { emit = handler; return unsubscribe; } } as unknown as AveApi;
  return { ...renderHook(() => useSessionList(api)), chatSessions, agentSpawnSnapshot, unsubscribe, emit: (event: AgentSpawnEvent) => emit(event) };
}
function branches(rows: typeof PAGE.sessions) {
  return nestSessionEntries(treeEntries({ sessions: rows, surfaces: [], isPinned: () => false, surfaceAt: () => 0 }));
}

it("coalesces missing-child activity into one in-flight list and one pending list, retaining its existing parent", async () => {
  const first = deferred<SessionListResult>();
  const second = deferred<SessionListResult>();
  const chatSessions = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, emit, unmount, unsubscribe } = harness(chatSessions);
  const refresh = result.current.refreshSessions();
  act(() => { emit(START); for (let i = 0; i < 100; i += 1) emit(EVENT); });
  expect(START).not.toHaveProperty("childSessionId");
  expect(chatSessions).toHaveBeenCalledTimes(1);
  expect(result.current.sessions).toEqual([]);
  await act(async () => { first.resolve({ current: PARENT_ID, sessions: [] }); await first.promise; });
  expect(chatSessions).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve(PAGE); await refresh; });
  expect(result.current.sessions).toEqual([child, parent]);
  expect(branches(result.current.sessions)).toMatchObject([{ session: parent, children: [{ session: child }] }]);
  act(() => { for (let i = 0; i < 100; i += 1) emit(EVENT); });
  expect(chatSessions).toHaveBeenCalledTimes(2);
  expect(chatSessions.mock.calls.every(([query]) => !Object.hasOwn(query, "id"))).toBe(true);
  unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it("keeps newer running activity and an expanded unselected parent after a delayed stopped list snapshot", async () => {
  const page = deferred<SessionListResult>();
  const chatSessions = vi.fn().mockResolvedValueOnce(PAGE).mockReturnValueOnce(page.promise);
  const { result, emit } = harness(chatSessions);
  await act(() => result.current.refreshSessions());
  const refresh = result.current.refreshSessions();
  act(() => emit(EVENT));
  await act(async () => { const stoppedChild = { ...child, running: false }; page.resolve({ ...PAGE, sessions: [stoppedChild] }); await refresh; });
  expect(result.current.activity.get(CHILD_ID)).toEqual(ACTIVE);
  const [branch] = branches(result.current.sessions);
  if (branch?.kind !== "session") throw new Error("missing-parent");
  expect(sessionBranchExpanded(branch, "elsewhere", (id) => result.current.activity.get(id)?.running === true, false)).toBe(true);
  expect(chatSessions).toHaveBeenCalledTimes(2);
});

it("accepts only newer per-session activity from the initial snapshot, reconnect and stream", async () => {
  const snapshot = deferred<SessionActivitySnapshot>();
  const snapshotCall = vi.fn().mockReturnValueOnce(snapshot.promise).mockResolvedValue({ sequence: 4, sessions: [{ ...ACTIVE, sequence: 4, running: false, attention: true }] });
  const { result, emit } = harness(undefined, snapshotCall);
  await act(() => result.current.refreshSessions());
  act(() => emit(EVENT));
  await act(async () => { snapshot.resolve({ sequence: 1, sessions: [{ ...ACTIVE, sequence: 1, running: false }] }); await snapshot.promise; });
  expect(result.current.activity.get(CHILD_ID)).toEqual(ACTIVE);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(snapshotCall).toHaveBeenCalledTimes(2);
  act(() => emit({ ...EVENT, activity: { ...ACTIVE, sequence: 3 } }));
  expect(result.current.activity.get(CHILD_ID)).toEqual({ ...ACTIVE, sequence: 4, running: false, attention: true });
  act(() => emit({ ...EVENT, activity: { ...ACTIVE, sequence: 5 } }));
  expect(result.current.activity.get(CHILD_ID)?.running).toBe(true);
});

it("takes child and parent titles and project metadata only from each latest list response", async () => {
  const page = deferred<SessionListResult>();
  const current = { ...PAGE, sessions: [{ ...child, title: "Current child", projectRoot: "/current" }], related: [{ ...parent, title: "Current parent", projectRoot: "/current" }] };
  const chatSessions = vi.fn().mockResolvedValue(current).mockResolvedValueOnce({ current: PARENT_ID, sessions: [] }).mockReturnValueOnce(page.promise);
  const { result, emit } = harness(chatSessions);
  await act(() => result.current.refreshSessions());
  act(() => emit(EVENT));
  await act(async () => { emit({ ...EVENT, title: "Stale child" }); page.resolve(current); await page.promise; });
  await waitFor(() => expect(chatSessions).toHaveBeenCalledTimes(3));
  expect(result.current.sessions).toEqual([...current.sessions, ...current.related]);
});

it("drops a deleted shared parent while both running children remain reachable at top level", async () => {
  const other = { ...child, id: "sub-aaaaaaaa-cccccccc-1111-4111-8111-111111111111" };
  const chatSessions = vi.fn().mockResolvedValueOnce({ ...PAGE, related: [other, parent] }).mockResolvedValueOnce({ current: PARENT_ID, sessions: [child], related: [other] });
  const { result, emit } = harness(chatSessions);
  await act(() => result.current.refreshSessions());
  act(() => { emit(EVENT); emit({ ...EVENT, childSessionId: other.id, activity: { ...ACTIVE, sessionId: other.id } }); });
  await act(() => result.current.refreshSessions());
  expect(result.current.sessions).toEqual([other, child]);
  expect(branches(result.current.sessions)).toMatchObject([{ session: other, children: [] }, { session: child, children: [] }]);
});

it("reconciles omitted terminal states on reconnect without losing newer stream activity or resurrecting old frames", async () => {
  const snapshot = deferred<SessionActivitySnapshot>();
  const snapshotCall = vi.fn().mockResolvedValueOnce({ sequence: 0, sessions: [] }).mockReturnValueOnce(snapshot.promise).mockResolvedValue({ sequence: 6, sessions: [] });
  const chatSessions = vi.fn().mockResolvedValueOnce({ current: PARENT_ID, sessions: [] }).mockResolvedValue(PAGE);
  const { result, emit } = harness(chatSessions, snapshotCall);
  await act(() => result.current.refreshSessions());
  act(() => { emit(EVENT); window.dispatchEvent(new Event("online")); emit({ ...EVENT, activity: { ...ACTIVE, sequence: 5 } }); });
  await act(async () => { snapshot.resolve({ sequence: 4, sessions: [] }); await snapshot.promise; });
  expect(result.current.activity.get(CHILD_ID)?.running).toBe(true);
  expect(result.current.sessions).toEqual([child, parent]);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  act(() => emit({ ...EVENT, activity: { ...ACTIVE, sequence: 5 } }));
  expect(result.current.activity.get(CHILD_ID)).toEqual({ ...ACTIVE, sequence: 6, running: false });
});

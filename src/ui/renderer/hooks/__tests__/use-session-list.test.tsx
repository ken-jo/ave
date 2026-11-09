// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { A2ATaskState } from "../../../../shared/a2a.js";
import type { AgentSpawnEvent } from "../../../../shared/subagent-events.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { AveApi } from "../../types.js";
import { sessionRow } from "../../../../../test/renderer/mock-ave-api.js";
import { useSessionList } from "../use-sessions.js";

afterEach(cleanup);

it("requests the child family and refreshes lifecycle changes without relisting for activity", async () => {
  let listener: (event: AgentSpawnEvent<ChatEntry>) => void = () => { throw new Error("missing-spawn-listener"); };
  const unsubscribe = vi.fn();
  const child = sessionRow({ id: "child", title: "Research", modifiedAt: "2026-11-10T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: "parent", running: true });
  const chatSessions = vi.fn().mockResolvedValueOnce({ sessions: [] }).mockResolvedValue({ sessions: [child] });
  const api = { chatSessions, onAgentSpawnEvent: (handler: typeof listener) => { listener = handler; return unsubscribe; } } as unknown as AveApi;
  const { result, unmount } = renderHook(() => useSessionList(api));
  await act(() => result.current.refreshSessions());
  expect(chatSessions.mock.calls.at(0)?.[0].families).toContain("subagent");
  const activity: AgentSpawnEvent<ChatEntry> = { type: "activity", spawnId: "spawn", parentSessionId: "parent", childSessionId: "child", taskState: A2ATaskState.WORKING };
  act(() => listener({ ...activity, type: "start", taskState: A2ATaskState.SUBMITTED }));
  await waitFor(() => expect(result.current.sessions[0]).toMatchObject({ id: "child", originSessionId: "parent", running: true }));
  const previous = result.current.sessions;
  act(() => listener(activity));
  expect(result.current.sessions).toBe(previous);
  expect(chatSessions).toHaveBeenCalledTimes(2);
  chatSessions.mockResolvedValue({ sessions: [{ ...child, running: false }] });
  act(() => listener({ ...activity, type: "done", taskState: A2ATaskState.COMPLETED }));
  await waitFor(() => expect(result.current.sessions[0]?.running).toBe(false));
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("ignores every activity frame for a child outside the current root page until an explicit refresh", async () => {
  let listener: (event: AgentSpawnEvent<ChatEntry>) => void = () => { throw new Error("missing-spawn-listener"); };
  const chatSessions = vi.fn().mockResolvedValue({ sessions: [] });
  const api = { chatSessions, onAgentSpawnEvent: (handler: typeof listener) => { listener = handler; return () => {}; } } as unknown as AveApi;
  const { result } = renderHook(() => useSessionList(api));
  await act(() => result.current.refreshSessions());
  const activity: AgentSpawnEvent<ChatEntry> = { type: "activity", spawnId: "off-page-spawn", parentSessionId: "off-page-parent", childSessionId: "off-page-child", taskState: A2ATaskState.WORKING };
  await act(async () => {
    for (let index = 0; index < 100; index += 1) listener(activity);
  });
  expect(chatSessions).toHaveBeenCalledTimes(1);
  const child = sessionRow({ id: "off-page-child", title: "Research", modifiedAt: "2026-11-10T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: "off-page-parent", running: true });
  chatSessions.mockResolvedValue({ sessions: [child] });
  await act(() => result.current.refreshSessions());
  expect(result.current.sessions).toEqual([child]);
  expect(chatSessions).toHaveBeenCalledTimes(2);
});

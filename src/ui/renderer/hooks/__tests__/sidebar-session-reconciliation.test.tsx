// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { I18nProvider } from "../../../../i18n/react.js";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { A2ATaskState } from "../../../../shared/a2a.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { SessionListResult } from "../../../../shared/session-lookup.js";
import type { AgentSpawnEvent } from "../../../../shared/subagent-events.js";
import { deferred } from "../../../../../test/renderer/helpers.js";
import { sessionRow } from "../../../../../test/renderer/mock-ave-api.js";
import { SidebarPreviewProvider } from "../../components/SidebarPreview.js";
import { ProjectTree, type ConversationRowActions } from "../../components/sidebar/ProjectTree.js";
import type { AveApi } from "../../types.js";
import { useSessionList } from "../use-sessions.js";

const initialLocale = getLocale();
afterEach(() => { cleanup(); setLocale(initialLocale); });
const PROJECT: ProjectIdentity = { projectRoot: "/projects/reconciliation", projectName: "Reconciliation" };
const parent = sessionRow({ id: "aaaaaaaa-1111-4111-8111-111111111111", title: "Old parent", modifiedAt: "2026-11-01T00:00:00Z", ...PROJECT });
const child = sessionRow({ id: "sub-aaaaaaaa-bbbbbbbb-1111-4111-8111-111111111111", title: "Running child", modifiedAt: "2026-11-09T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: parent.id, running: true, ...PROJECT });
const PAGE = { current: "elsewhere", sessions: [], sidebar: { rows: [child, parent], hiddenRoots: {} } } satisfies SessionListResult;
const EMPTY_PAGE: SessionListResult = { current: "elsewhere", sessions: [], sidebar: { rows: [], hiddenRoots: {} } };
const ACTIVITY: AgentSpawnEvent = { type: "activity", spawnId: "spawn", parentSessionId: parent.id, childSessionId: child.id, taskState: A2ATaskState.WORKING };
function mountSessionList(chatSessions = vi.fn().mockResolvedValue(EMPTY_PAGE), agentSpawnSnapshot = vi.fn()) {
  let listener: (event: AgentSpawnEvent) => void = () => { throw new Error("missing-activity-listener"); };
  // The legacy transport method catches accidental snapshot reads.
  const api = { chatSessions, agentSpawnSnapshot, onAgentSpawnEvent: (handler: typeof listener) => { listener = handler; return () => {}; } } as unknown as AveApi;
  return { ...renderHook(() => useSessionList(api)), emit: (event: AgentSpawnEvent) => listener(event) };
}

it("replaces the stopped projection and restores the resumed child's ancestry from its next response", async () => {
  const stoppedPage = deferred<SessionListResult>();
  const resumedPage = deferred<SessionListResult>();
  const chatSessions = vi.fn().mockResolvedValueOnce(PAGE).mockReturnValueOnce(stoppedPage.promise).mockReturnValueOnce(resumedPage.promise);
  const { result, emit } = mountSessionList(chatSessions);
  await act(() => result.current.refreshSessions());
  const refresh = result.current.refreshSessions();
  act(() => emit(ACTIVITY));
  expect(chatSessions).toHaveBeenCalledTimes(2);
  await act(async () => { stoppedPage.resolve(EMPTY_PAGE); await stoppedPage.promise; });
  expect(result.current.sessions).toEqual([]);
  expect(chatSessions).toHaveBeenCalledTimes(3);
  await act(async () => { resumedPage.resolve(PAGE); await refresh; });
  expect(result.current.sessions.find((row) => row.id === child.id)?.running).toBe(true);
  expect(result.current.sessions.map((row) => row.id)).toEqual([child.id, parent.id]);
});

it("does not revive an unseen running child from a delayed legacy snapshot or frame", async () => {
  const initial = deferred<unknown>();
  const legacyActivity = { sessionId: child.id, sequence: 10, running: true, attention: false };
  const agentSpawnSnapshot = vi.fn().mockReturnValue(initial.promise);
  const chatSessions = vi.fn().mockResolvedValue(EMPTY_PAGE);
  const { result, emit } = mountSessionList(chatSessions, agentSpawnSnapshot);
  await act(() => result.current.refreshSessions());
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await act(async () => {
    initial.resolve({ sequence: 10, sessions: [legacyActivity] });
    await initial.promise;
    emit(Object.assign({}, ACTIVITY, { activity: legacyActivity }));
  });
  expect(agentSpawnSnapshot).not.toHaveBeenCalled();
  expect(chatSessions).toHaveBeenCalledTimes(3);
  expect(result.current.sessions).toEqual([]);
});

it("keeps a main-projected running branch visible in selected-project and all-projects trees", () => {
  const unrelated = Array.from({ length: 21 }, (_, index) => sessionRow({
    id: `${(index + 1).toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`, title: `Unrelated ${index + 1}`,
    modifiedAt: new Date(Date.parse("2026-11-09T00:00:00Z") - index * 60_000).toISOString(), ...PROJECT,
  }));
  const conversationActions: ConversationRowActions = {
    isArchived: () => false, isUnread: () => false, isResponding: (id) => id === child.id,
    onRename: vi.fn(), onSetArchived: vi.fn(), onSetUnread: vi.fn(), onShare: vi.fn(), onCopy: vi.fn(), onDelete: vi.fn(),
  };
  for (const selectedProject of [PROJECT, undefined]) {
    const rendered = render(<I18nProvider locale="en" setLocale={() => {}}><TooltipProvider><SidebarPreviewProvider>
      <ProjectTree selectedProject={selectedProject} projects={[PROJECT]}
        projectName={(project) => project.projectName} isProjectExpanded={() => true} onSetProjectExpanded={vi.fn()}
        addFlow={{ pendingWarning: null, addProject: vi.fn(async () => {}), confirmAddProject: vi.fn(async () => {}), cancelPendingFolder: vi.fn() }}
        sessions={[parent, ...unrelated, child]} hiddenRoots={{}} surfaces={[]} bindingsLoaded currentSessionId="elsewhere"
        conversationSurfaceVisible conversationActions={conversationActions} onRemoveProject={vi.fn()} suggestionsPendingCount={0} />
    </SidebarPreviewProvider></TooltipProvider></I18nProvider>);
    try {
      expect(rendered.container.querySelectorAll('[data-tree-key^="session:"]')).toHaveLength(unrelated.length + 2);
      expect([parent.id, child.id].filter((id) => rendered.queryByTestId(`sidebar-row-session-${id}`) !== null)).toEqual([parent.id, child.id]);
      expect(rendered.getByTestId(`sidebar-row-session-${parent.id}`)).toHaveAttribute("aria-expanded", "true");
      expect(rendered.getByTestId(`sidebar-row-session-${child.id}`)).toHaveAttribute("data-responding", "true");
    } finally { rendered.unmount(); }
  }
});

it("renders an archived ancestor returned as context above its running child", () => {
  const archivedParent = { ...parent, archivedAt: "2026-11-10T00:00:00Z", context: true };
  const conversationActions: ConversationRowActions = {
    isArchived: (id) => id === parent.id, isUnread: () => false, isResponding: (id) => id === child.id,
    onRename: vi.fn(), onSetArchived: vi.fn(), onSetUnread: vi.fn(), onShare: vi.fn(), onCopy: vi.fn(), onDelete: vi.fn(),
  };
  const rendered = render(<I18nProvider locale="en" setLocale={() => {}}><TooltipProvider><SidebarPreviewProvider>
    <ProjectTree selectedProject={PROJECT} projects={[PROJECT]}
      projectName={(project) => project.projectName} isProjectExpanded={() => true} onSetProjectExpanded={vi.fn()}
      addFlow={{ pendingWarning: null, addProject: vi.fn(async () => {}), confirmAddProject: vi.fn(async () => {}), cancelPendingFolder: vi.fn() }}
      sessions={[archivedParent, child]} hiddenRoots={{}} hasArchived surfaces={[]} bindingsLoaded currentSessionId="elsewhere"
      conversationSurfaceVisible conversationActions={conversationActions} onRemoveProject={vi.fn()} suggestionsPendingCount={0} />
  </SidebarPreviewProvider></TooltipProvider></I18nProvider>);
  const parentRow = rendered.getByTestId(`sidebar-row-session-${parent.id}`);
  const childRow = rendered.getByTestId(`sidebar-row-session-${child.id}`);
  expect(parentRow).toHaveAttribute("data-archived", "true");
  expect(parentRow).toHaveAttribute("data-session-context", "true");
  expect(parentRow).toHaveAttribute("aria-expanded", "true");
  expect(Number(childRow.getAttribute("aria-level"))).toBe(Number(parentRow.getAttribute("aria-level")) + 1);
  expect(childRow).toHaveAttribute("data-responding", "true");
});

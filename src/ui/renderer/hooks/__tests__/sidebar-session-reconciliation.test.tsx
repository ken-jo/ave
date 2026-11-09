// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { I18nProvider } from "../../../../i18n/react.js";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { A2ATaskState } from "../../../../shared/a2a.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { SessionListResult } from "../../../../shared/session-lookup.js";
import type { AgentSpawnEvent, SessionActivity, SessionActivitySnapshot } from "../../../../shared/subagent-events.js";
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
const child = sessionRow({ id: "sub-aaaaaaaa-bbbbbbbb-1111-4111-8111-111111111111", title: "Running child", modifiedAt: "2026-11-09T00:00:00Z", family: "subagent", sessionKind: "subagent", originSessionId: parent.id, ...PROJECT });
const PAGE: SessionListResult = { current: "elsewhere", sessions: [child], related: [parent] };
const EMPTY_PAGE: SessionListResult = { current: "elsewhere", sessions: [], related: [] };
const ACTIVE: SessionActivity = { sessionId: child.id, sequence: 10, running: true, attention: false };
const ACTIVITY: AgentSpawnEvent = { type: "activity", spawnId: "spawn", parentSessionId: parent.id, childSessionId: child.id, taskState: A2ATaskState.WORKING, activity: ACTIVE };

function mountSessionList(
  chatSessions = vi.fn().mockResolvedValue(EMPTY_PAGE),
  agentSpawnSnapshot = vi.fn().mockResolvedValue({ sequence: 0, sessions: [] }),
) {
  let listener: (event: AgentSpawnEvent) => void = () => { throw new Error("missing-activity-listener"); };
  const api = {
    chatSessions, agentSpawnSnapshot,
    onAgentSpawnEvent: (handler: typeof listener) => { listener = handler; return () => {}; },
  } as unknown as AveApi;
  return { ...renderHook(() => useSessionList(api)), emit: (event: AgentSpawnEvent) => listener(event) };
}

it("keeps a resumed child reachable when an older in-flight list omits its stopped row", async () => {
  const stoppedPage = deferred<SessionListResult>();
  const chatSessions = vi.fn().mockResolvedValue(PAGE).mockResolvedValueOnce(PAGE).mockReturnValueOnce(stoppedPage.promise);
  const stopped = vi.fn().mockResolvedValue({ sequence: 9, sessions: [{ ...ACTIVE, sequence: 9, running: false }] });
  const { result, emit } = mountSessionList(chatSessions, stopped);
  await act(() => result.current.refreshSessions());
  expect(result.current.activity.get(child.id)?.running).toBe(false);
  expect(result.current.sessions.map((row) => row.id)).toContain(child.id);
  const refresh = result.current.refreshSessions();
  act(() => emit(ACTIVITY));
  expect(result.current.activity.get(child.id)?.running).toBe(true);
  expect(chatSessions).toHaveBeenCalledTimes(2);
  await act(async () => { stoppedPage.resolve(EMPTY_PAGE); await refresh; });
  expect(result.current.activity.get(child.id)?.running).toBe(true);
  expect(result.current.sessions.map((row) => row.id)).toContain(child.id);
});

it("does not revive running activity for an unseen id after a newer snapshot omitted it", async () => {
  for (const source of ["initial snapshot", "stream frame"] as const) {
    const initial = deferred<SessionActivitySnapshot>();
    const agentSpawnSnapshot = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValueOnce({ sequence: 200, sessions: [] });
    const { result, emit, unmount } = mountSessionList(undefined, agentSpawnSnapshot);
    try {
      expect(agentSpawnSnapshot).toHaveBeenCalledTimes(1);
      await act(async () => { window.dispatchEvent(new Event("online")); });
      expect(agentSpawnSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.activity.has(child.id)).toBe(false);
      await act(async () => {
        if (source === "initial snapshot") {
          initial.resolve({ sequence: 10, sessions: [ACTIVE] });
          await initial.promise;
        } else emit(ACTIVITY);
      });
      expect.soft(result.current.activity.get(child.id)?.running ?? false, `delayed ${source} after watermark 200`).toBe(false);
    } finally { unmount(); }
  }
});

it("keeps a running child branch on the first page in selected-project and all-projects trees", () => {
  const unrelated = Array.from({ length: 21 }, (_, index) => sessionRow({
    id: `${(index + 1).toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`, title: `Unrelated ${index + 1}`,
    modifiedAt: new Date(Date.parse("2026-11-09T00:00:00Z") - index * 60_000).toISOString(), ...PROJECT,
  }));
  const conversationActions: ConversationRowActions = {
    isArchived: () => false, isUnread: () => false, isResponding: (id) => id === child.id,
    onRename: vi.fn(), onSetArchived: vi.fn(), onSetUnread: vi.fn(), onShare: vi.fn(), onCopy: vi.fn(), onDelete: vi.fn(),
  };
  for (const [view, limit] of [["selected project", 20], ["all projects", 6]] as const) {
    const rendered = render(<I18nProvider locale="en" setLocale={() => {}}><TooltipProvider><SidebarPreviewProvider>
      <ProjectTree selectedProject={view === "selected project" ? PROJECT : undefined} projects={[PROJECT]}
        projectName={(project) => project.projectName} isProjectExpanded={() => true} onSetProjectExpanded={vi.fn()}
        addFlow={{ pendingWarning: null, addProject: vi.fn(async () => {}), confirmAddProject: vi.fn(async () => {}), cancelPendingFolder: vi.fn() }}
        sessions={[parent, ...unrelated, child]} surfaces={[]} bindingsLoaded currentSessionId="elsewhere"
        conversationSurfaceVisible conversationActions={conversationActions} onRemoveProject={vi.fn()} suggestionsPendingCount={0} />
    </SidebarPreviewProvider></TooltipProvider></I18nProvider>);
    try {
      expect(rendered.container.querySelectorAll('[data-tree-key^="session:"]')).toHaveLength(limit);
      const visibleBranch = [parent.id, child.id].filter((id) => rendered.queryByTestId(`sidebar-row-session-${id}`) !== null);
      expect.soft(visibleBranch, `${view} first page (${limit} roots)`).toEqual([parent.id, child.id]);
      // The same real tree reveals the expanded branch after manual pagination.
      for (let shown = limit; shown < unrelated.length + 1; shown += limit) {
        const more = rendered.container.querySelector<HTMLButtonElement>('[data-testid^="sidebar-tree-more-"]');
        if (!more) throw new Error("missing-pagination-control");
        fireEvent.click(more);
      }
      expect(rendered.getByTestId(`sidebar-row-session-${parent.id}`)).toHaveAttribute("aria-expanded", "true");
      expect(rendered.getByTestId(`sidebar-row-session-${child.id}`)).toHaveAttribute("data-responding", "true");
    } finally { rendered.unmount(); }
  }
});

// @vitest-environment jsdom
/** The work board's 확인 필요 stack: proposals and routine attention from `ave:work-approvals:list`. Adding a proposal creates an ordinary
 * work item, and "추가하고 계획" runs that item's id through the host's plan/approve/execute flow; plugin text is never executable. */
import "../../../../../test/renderer/setup.js";
import { withApprovalSurface } from "../../../../../test/renderer/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type {
  RoutineAttentionApprovalView,
  WorkApprovalView,
  WorkProposalApprovalView,
} from "../../../../shared/work-approvals-types.js";

const PROJECT = { projectRoot: "/work/checkout", projectName: "checkout" };

function proposal(overrides: Partial<WorkProposalApprovalView> = {}): WorkProposalApprovalView {
  return {
    kind: "proposal",
    key: "proposal:indexer:stale-index:0123456789abcdef",
    scope: { type: "unscoped" },
    title: "Re-index the reports folder",
    arrivedAt: "2026-06-15T12:00:00.000Z",
    proposalId: "indexer:stale-index:0123456789abcdef",
    summary: "18 files changed since the last scan.",
    pluginLabel: "Indexer",
    priority: "high",
    expiresAt: "2026-06-22T12:00:00.000Z",
    state: "Last scanned 12 days ago; 18 files newer than the index.",
    evidence: [{ label: "Newest change", detail: "quarterly-summary.docx" }],
    blockers: [{ reason: "The share is disconnected", resolution: "Reconnect the share" }],
    ...overrides,
  };
}

function routine(overrides: Partial<RoutineAttentionApprovalView> = {}): RoutineAttentionApprovalView {
  return {
    kind: "routine-attention",
    key: "routine:r-1",
    scope: { type: "global" },
    title: "Weekday tests",
    arrivedAt: "2026-06-16T09:00:00.000Z",
    routineId: "r-1",
    reasons: ["plugins-missing"],
    missingPluginIds: ["mail"],
    ...overrides,
  };
}

function stubApi(items: WorkApprovalView[] = [proposal()], overrides: Partial<AveApi> = {}) {
  let changed: (() => void) | null = null;
  const list = vi.fn(async () => ({ ok: true as const, items, total: items.length }));
  const accept = vi.fn(async () => ({
    status: "accepted" as const,
    itemId: 7,
    item: {
      id: 7,
      title: "x",
      status: "planned" as const,
      status_resolved: "planned" as const,
      priority: "high" as const,
      created_at: "2026-06-15T12:00:00.000Z",
      updated_at: "2026-06-15T12:00:00.000Z",
    },
  }));
  const dismiss = vi.fn(async () => ({ status: "dismissed" as const, proposalId: "p" }));
  const run = vi.fn(async (_itemId: number) => ({ status: "completed" as const }));
  const noop = () => () => {};
  const api = {
    listWorkBoard: async () => ({ status: "ok" as const, items: [] }),
    listWorkApprovals: list,
    onWorkApprovalsChanged: (handler: () => void) => { changed = handler; return () => { changed = null; }; },
    acceptWorkProposal: accept,
    dismissWorkProposal: dismiss,
    runWorkBoardItem: run,
    onWorkBoardItemChanged: noop,
    onWorkBoardRunProgress: noop,
    onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop,
    onWorkBoardRunFailed: noop,
    ...overrides,
  } as unknown as AveApi;
  return { api, list, accept, dismiss, run, fireChanged: () => changed?.() };
}

describe("Work Board — 확인 필요 stack", () => {
  afterEach(() => cleanup());

  it("asks for this project's items and shows the oldest as the card, with its source named", async () => {
    const { api, list } = stubApi([routine(), proposal()]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));

    const head = await screen.findByTestId("work-approval-head");
    expect(list).toHaveBeenCalledWith({ projectRoot: PROJECT.projectRoot });
    expect(within(head).getByTestId("work-approval-title").textContent).toBe("Re-index the reports folder");
    expect(within(head).getByTestId("work-approval-source").textContent).toContain("Indexer");
    expect(within(head).getByTestId("work-approval-position").textContent).toBe("1 / 2");
    expect(screen.getAllByTestId("work-approval-row")).toHaveLength(1);
    expect(screen.getByTestId("work-approvals-tool-note")).toBeTruthy();
  });

  it("names a briefing proposal as the briefing's, not a plugin's", async () => {
    const { api } = stubApi([proposal({ proposalId: "ave.briefing:follow-up:abc", pluginLabel: "Briefing" })]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    expect((await screen.findByTestId("work-approval-source")).textContent).not.toContain("Briefing");
  });

  it("expands into state, evidence and blockers", async () => {
    const { api } = stubApi();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    fireEvent.click(await screen.findByTestId("work-approval-proposal-expand"));
    expect(screen.getByTestId("work-approval-proposal-state").textContent).toContain("Last scanned");
    expect(screen.getByTestId("work-approval-proposal-evidence").textContent).toContain("quarterly-summary.docx");
    expect(screen.getByTestId("work-approval-proposal-blockers").textContent).toContain("Reconnect the share");
  });

  it("add and plan accepts into this project, then runs the new item's id", async () => {
    const { api, accept, run } = stubApi();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    fireEvent.click(await screen.findByTestId("work-approval-proposal-add-plan"));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(accept).toHaveBeenCalledWith("indexer:stale-index:0123456789abcdef", PROJECT.projectRoot);
    expect(run.mock.calls[0]?.[0]).toBe(7);
  });

  it("add accepts without running", async () => {
    const { api, accept, run } = stubApi();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    fireEvent.click(await screen.findByTestId("work-approval-proposal-add"));
    await waitFor(() => expect(accept).toHaveBeenCalled());
    expect(run).not.toHaveBeenCalled();
  });

  it("close dismisses without creating anything", async () => {
    const { api, accept, dismiss, run } = stubApi();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    fireEvent.click(await screen.findByTestId("work-approval-proposal-dismiss"));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("indexer:stale-index:0123456789abcdef"));
    expect(accept).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("says why when the store refuses an accept, and runs nothing", async () => {
    const { api, run } = stubApi([proposal()], {
      acceptWorkProposal: vi.fn(async () => ({ status: "invalid" as const, reason: "item limit reached" })),
    } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    fireEvent.click(await screen.findByTestId("work-approval-proposal-add-plan"));
    expect((await screen.findByTestId("work-approval-action-error")).textContent).toContain("item limit reached");
    expect(run).not.toHaveBeenCalled();
  });

  it("names a missing proposal in words, not by its status code", async () => {
    const { api } = stubApi([proposal()], {
      dismissWorkProposal: vi.fn(async () => ({ status: "not_found" as const, proposalId: "p" })),
    } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    fireEvent.click(await screen.findByTestId("work-approval-proposal-dismiss"));
    const error = await screen.findByTestId("work-approval-action-error");
    expect(error.textContent).toContain("더 이상 없습니다");
    expect(error.textContent).not.toContain("not_found");
  });

  it("routine attention names the missing plugins and opens the schedule on that routine", async () => {
    const onOpenRoutine = vi.fn();
    const { api } = stubApi([routine()]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} onOpenRoutine={onOpenRoutine} />));
    expect((await screen.findByTestId("work-approval-routine-reason")).textContent).toContain("mail");
    expect(screen.getByTestId("work-approval-shared")).toBeTruthy();
    fireEvent.click(screen.getByTestId("work-approval-routine-open"));
    expect(onOpenRoutine).toHaveBeenCalledWith("r-1");
  });

  it("shows a busy skeleton until the first result, then the empty state", async () => {
    let resolve!: (value: unknown) => void;
    const { api } = stubApi([], {
      listWorkApprovals: vi.fn(() => new Promise((r) => { resolve = r; })),
    } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    expect(screen.getByTestId("work-approvals-loading").getAttribute("aria-busy")).toBe("true");
    await act(async () => resolve({ ok: true, items: [], total: 0 }));
    expect(await screen.findByTestId("work-approvals-empty")).toBeTruthy();
  });

  it("shows the source error instead of an empty list", async () => {
    const { api } = stubApi([], {
      listWorkApprovals: vi.fn(async () => ({ ok: false, error: "work-approvals-source-unavailable", source: "proposal" })),
    } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    expect(await screen.findByTestId("work-approvals-error")).toBeTruthy();
    expect(screen.queryByTestId("work-approvals-empty")).toBeNull();
  });

  it("re-lists when main says a source changed", async () => {
    const { api, list, fireChanged } = stubApi();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    await screen.findByTestId("work-approval-head");
    const before = list.mock.calls.length;
    await act(async () => fireChanged());
    await waitFor(() => expect(list.mock.calls.length).toBe(before + 1));
  });

  it("offers kind filters only for a long list", async () => {
    const many = [
      ...Array.from({ length: 4 }, (_, i) => proposal({ key: `proposal:p${i}`, proposalId: `indexer:k:p${i}`, arrivedAt: `2026-06-1${i}T00:00:00.000Z` })),
      routine({ key: "routine:a", routineId: "a" }),
      routine({ key: "routine:b", routineId: "b", arrivedAt: "2026-06-19T00:00:00.000Z" }),
    ];
    const { api } = stubApi(many);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    fireEvent.click(await screen.findByTestId("work-approvals-filter-routine-attention"));
    expect(screen.getByTestId("work-approval-head").getAttribute("data-approval-key")).toBe("routine:a");
    expect(screen.getAllByTestId("work-approval-row")).toHaveLength(1);

    cleanup();
    const few = stubApi([proposal(), routine()]);
    render(withApprovalSurface(<WorkBoardPanel api={few.api} project={PROJECT} />));
    await screen.findByTestId("work-approval-head");
    expect(screen.queryByTestId("work-approvals-filters")).toBeNull();
  });

  it("moves focus with the arrow keys, expands a row with Enter, and decides only on a button press", async () => {
    const { api, accept, dismiss } = stubApi([proposal(), routine()]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    const head = await screen.findByTestId("work-approval-head");
    head.focus();
    fireEvent.keyDown(head, { key: "ArrowDown" });
    const row = screen.getByTestId("work-approval-row");
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("work-approval-head").getAttribute("data-approval-key")).toBe("routine:r-1"));
    fireEvent.keyDown(screen.getByTestId("work-approval-head"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("work-approval-head").getAttribute("data-approval-key")).toBe(proposal().key));
    expect(accept).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("brings a popover target to the card once, then reports it consumed", async () => {
    const onApprovalFocusConsumed = vi.fn();
    const { api } = stubApi([proposal(), routine()]);
    render(withApprovalSurface(
      <WorkBoardPanel api={api} project={PROJECT} approvalFocusKey="routine:r-1" onApprovalFocusConsumed={onApprovalFocusConsumed} />,
    ));
    await waitFor(() => expect(screen.getByTestId("work-approval-head").getAttribute("data-approval-key")).toBe("routine:r-1"));
    expect(onApprovalFocusConsumed).toHaveBeenCalledTimes(1);
  });
});

describe("Work Board — narrow width", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("switches to tabs below 900px and opens 확인 필요 first while it has items", async () => {
    let callback: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { callback = cb; }
      observe() {}
      disconnect() {}
    });
    const { api } = stubApi([proposal()]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    await screen.findByTestId("work-approval-head");
    await act(async () => callback?.([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver));

    expect(screen.getByTestId("work-board-tab-approvals").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("work-board-tab-approvals").textContent).toContain("1");
    expect(screen.queryByTestId("work-board-column-planned")).toBeNull();
    fireEvent.click(screen.getByTestId("work-board-tab-overview"));
    // The overview shows one status lane at a time below 900px (livestep case 14); 진행 중 first.
    expect(screen.getByTestId("work-board-status-tabs")).toBeTruthy();
    expect(screen.getByTestId("work-board-column-in-progress")).toBeTruthy();
    fireEvent.click(screen.getByTestId("work-board-tab-planned"));
    expect(screen.getByTestId("work-board-column-planned")).toBeTruthy();
    expect((screen.getByTestId("work-board-approvals-region") as HTMLElement).hidden).toBe(true);
  });

  it("counts the tab and opens it when the panel turns narrow before the first list response", async () => {
    let callback: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { callback = cb; }
      observe() {}
      disconnect() {}
    });
    let resolve!: (value: unknown) => void;
    const { api } = stubApi([proposal()], {
      listWorkApprovals: vi.fn(() => new Promise((r) => { resolve = r; })),
    } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));
    // Narrow before the list answers: overview first, with the stack still subscribed behind it.
    await act(async () => callback?.([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(screen.getByTestId("work-board-tab-overview").getAttribute("aria-selected")).toBe("true");

    await act(async () => resolve({ ok: true, items: [proposal()], total: 1 }));
    expect(screen.getByTestId("work-board-tab-approvals").textContent).toContain("1");
    expect(screen.getByTestId("work-board-tab-approvals").getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByTestId("work-approval-head")).toBeTruthy();
  });

  it("orders the tabs [개요 | 확인 필요 N]", async () => {
    let callback: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { callback = cb; }
      observe() {}
      disconnect() {}
    });
    const { api } = stubApi([proposal()]);
    render(<WorkBoardPanel api={api} project={PROJECT} />);
    await screen.findByTestId("work-approval-head");
    await act(async () => callback?.([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver));
    const tabs = within(screen.getByTestId("work-board-tabs")).getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"));
    expect(tabs).toEqual(["work-board-tab-overview", "work-board-tab-approvals"]);
  });

  it("stores no tab choice for a focus request in the wide layout, so a later shrink with nothing to review opens overview", async () => {
    let callback: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { callback = cb; }
      observe() {}
      disconnect() {}
    });
    const items: WorkApprovalView[] = [proposal()];
    const { api, fireChanged } = stubApi(items);
    const { rerender } = render(<WorkBoardPanel api={api} project={PROJECT} />);
    await screen.findByTestId("work-approval-head");
    await act(async () => callback?.([{ contentRect: { width: 1200 } } as ResizeObserverEntry], {} as ResizeObserver));
    rerender(<WorkBoardPanel api={api} project={PROJECT} approvalFocusKey={proposal().key} />);
    rerender(<WorkBoardPanel api={api} project={PROJECT} approvalFocusKey={null} />);
    // The item is handled elsewhere, then the window shrinks.
    items.splice(0, items.length);
    await act(async () => fireChanged());
    await waitFor(() => expect(screen.queryByTestId("work-approval-head")).toBeNull());
    await act(async () => callback?.([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(screen.getByTestId("work-board-tab-overview").getAttribute("aria-selected")).toBe("true");
  });

  it("switches to 확인 필요 for a popover focus request made while the overview tab is open", async () => {
    let callback: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(cb: ResizeObserverCallback) { callback = cb; }
      observe() {}
      disconnect() {}
    });
    const items = [proposal(), routine()];
    const { api } = stubApi(items);
    const onApprovalFocusConsumed = vi.fn();
    const { rerender } = render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} onApprovalFocusConsumed={onApprovalFocusConsumed} />));
    await screen.findByTestId("work-approval-head");
    await act(async () => callback?.([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver));
    fireEvent.click(screen.getByTestId("work-board-tab-overview"));
    expect((screen.getByTestId("work-board-approvals-region") as HTMLElement).hidden).toBe(true);

    rerender(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} approvalFocusKey="routine:r-1" onApprovalFocusConsumed={onApprovalFocusConsumed} />));
    await waitFor(() => expect(screen.getByTestId("work-board-tab-approvals").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(onApprovalFocusConsumed).toHaveBeenCalledTimes(1));
    expect(within(screen.getByTestId("work-approval-head")).getByTestId("work-approval-title").textContent).toBe("Weekday tests");
  });
});

// Carried over from the retired proposals-band suite: the board's count and column layout do not depend on that band.
describe("Work Board — count and columns beside the 확인 필요 stack", () => {
  afterEach(() => cleanup());

  it("shows the item count without a quota", async () => {
    const item = {
      id: 1,
      title: "first",
      status: "planned" as const,
      status_resolved: "planned" as const,
      priority: "medium" as const,
      created_at: "2026-06-15T12:00:00.000Z",
      updated_at: "2026-06-15T12:00:00.000Z",
    };
    const { api } = stubApi([proposal()], {
      listWorkBoard: async () => ({ status: "ok" as const, items: [item, { ...item, id: 2, title: "second" }] }),
    } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));

    await waitFor(() => expect(screen.getByTestId("work-board-item-count").textContent).toBe("2개"));
  });

  // jsdom does no layout, so this pins the classes that decide it; the heights themselves were measured in the running app.
  it("gives the columns a floor and lets them fill, instead of absorbing the stack's height", async () => {
    const { api } = stubApi();
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));

    await screen.findByTestId("work-approval-head");
    const columns = screen.getByTestId("work-board-columns");
    // The column count follows the board's width, not the window's, so a split tile stacks like a narrow window.
    expect(columns.parentElement?.classList.contains("@container")).toBe(true);
    const grid = columns.className.split(/\s+/);
    expect(grid.some((c) => c.startsWith("sm:"))).toBe(false);
    // min-h-0 here let the grid take the whole deficit and squash the columns to their headers.
    expect(grid).not.toContain("min-h-0");
    expect(grid).toEqual(expect.arrayContaining(["flex-1", "auto-rows-[20rem]", "@2xl:min-h-[20rem]", "@2xl:grid-cols-3"]));

    for (const id of ["work-board-column-planned", "work-board-column-in-progress", "work-board-column-completed"]) {
      const column = screen.getByTestId(id);
      expect(column.parentElement).toBe(screen.getByTestId("work-board-columns"));
      // The list scrolls inside the height the grid gives it; a floor of its own would be clipped by the section.
      const list = screen.getByTestId(`${id}-list`);
      expect(column.contains(list)).toBe(true);
      expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-0", "flex-1"]));
    }
  });
});

describe("Work Board — failed routine runs in 확인 필요", () => {
  afterEach(() => cleanup());

  const failed = routine({
    reasons: ["run-failed"],
    missingPluginIds: undefined,
    failure: { kind: "error", firedAt: "2026-06-16T09:00:00.000Z", at: "2026-06-16T09:01:00.000Z", reason: "provider down" },
  });

  it("names the failure and acknowledges exactly the fire it shows", async () => {
    const acknowledge = vi.fn(async () => ({ ok: true as const }));
    const { api } = stubApi([failed], { acknowledgeRoutineFailure: acknowledge } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));

    const head = await screen.findByTestId("work-approval-head");
    expect(within(head).getByTestId("work-approval-kind").textContent).toBe("루틴 실패");
    expect(within(head).getByTestId("work-approval-routine-reason").textContent).toContain("provider down");
    fireEvent.click(within(head).getByTestId("work-approval-routine-acknowledge"));
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith("r-1", "2026-06-16T09:00:00.000Z"));
    expect(screen.queryByTestId("work-approval-action-error")).toBeNull();
  });

  it("re-lists on a stale acknowledgement, says the state changed, and drops the error once the failure is gone", async () => {
    const acknowledge = vi.fn(async () => ({ ok: false as const, error: "routine-failure-stale" }));
    const items: WorkApprovalView[] = [failed, proposal()];
    const { api, list } = stubApi(items, { acknowledgeRoutineFailure: acknowledge } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));

    const ack = await screen.findByTestId("work-approval-routine-acknowledge");
    const calls = list.mock.calls.length;
    // The failure was already cleared elsewhere: the re-list returns the routine without it.
    items.splice(0, 1, routine({ reasons: ["plugins-missing"] }));
    fireEvent.click(ack);
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(screen.queryByTestId("work-approval-routine-acknowledge")).toBeNull());
    expect(screen.queryByTestId("work-approval-action-error")).toBeNull();
  });

  it("shows the stale refusal in words while the card still shows that failure", async () => {
    const acknowledge = vi.fn(async () => ({ ok: false as const, error: "routine-failure-stale" }));
    const { api } = stubApi([failed], { acknowledgeRoutineFailure: acknowledge } as Partial<AveApi>);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));

    fireEvent.click(await screen.findByTestId("work-approval-routine-acknowledge"));
    const error = await screen.findByTestId("work-approval-action-error");
    expect(error.textContent).toContain("상태가 바뀌어");
    expect(error.textContent).not.toContain("routine-failure-stale");
  });

  it("names a shutdown timeout and offers no acknowledgement for a configuration problem", async () => {
    const { api } = stubApi([
      routine({ key: "routine:r-2", routineId: "r-2", reasons: ["run-failed"], missingPluginIds: undefined, failure: { kind: "shutdown-timeout", firedAt: "2026-06-15T09:00:00.000Z", at: "2026-06-15T09:00:30.000Z" }, arrivedAt: "2026-06-15T09:00:30.000Z" }),
      routine(),
    ]);
    render(withApprovalSurface(<WorkBoardPanel api={api} project={PROJECT} />));

    const head = await screen.findByTestId("work-approval-head");
    expect(within(head).getByTestId("work-approval-routine-reason").textContent).toContain("제시간에");
    expect(within(head).getByTestId("work-approval-routine-acknowledge")).toBeTruthy();
    const row = screen.getAllByTestId("work-approval-row")[0]!;
    expect(within(row).getByTestId("work-approval-routine-open")).toBeTruthy();
    expect(within(row).queryByTestId("work-approval-routine-acknowledge")).toBeNull();
  });
});

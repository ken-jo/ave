// @vitest-environment jsdom
/** One notification centre shares work-approval navigation and session history. */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NotificationBell } from "../NotificationBell.js";
import { createNotificationHistory } from "../../notification-history.js";
import type { WorkApprovalsProps } from "../work-approvals/WorkApprovalsList.js";

function ApprovalsBell(props: WorkApprovalsProps) { return <NotificationBell workApprovals={props} />; }
import type { AveApi } from "../../types.js";
import type { WorkApprovalView } from "../../../../shared/work-approvals-types.js";

const ITEMS: WorkApprovalView[] = [
  {
    kind: "proposal",
    key: "proposal:indexer:k:1",
    scope: { type: "unscoped" },
    title: "Re-index the reports folder",
    arrivedAt: "2026-06-15T12:00:00.000Z",
    proposalId: "indexer:k:1",
    summary: "18 files changed.",
    pluginLabel: "Indexer",
    priority: "medium",
    expiresAt: "2026-06-22T12:00:00.000Z",
    state: "Stale.",
    evidence: [],
    blockers: [],
  },
  {
    kind: "routine-attention",
    key: "routine:r-1",
    scope: { type: "global" },
    title: "Weekday tests",
    arrivedAt: "2026-06-16T09:00:00.000Z",
    routineId: "r-1",
    reasons: ["invalid-plugin-id"],
  },
];

const PROJECTS = [
  { projectRoot: "/work/default", projectName: "기본 프로젝트", isDefault: true },
  { projectRoot: "/work/ave", projectName: "ave", isDefault: false },
  { projectRoot: "/work/handbook", projectName: "team-handbook", isDefault: false },
];

function planView(key: string, title: string, projectRoot: string, phase: "pending" | "replanning" = "pending"): WorkApprovalView {
  return {
    kind: "plan",
    key,
    scope: { type: "project", projectRoot, isDefault: projectRoot === "/work/default" },
    title,
    arrivedAt: "2026-06-14T09:00:00.000Z",
    itemId: Number(key.slice(5)),
    runId: `run-${key}`,
    planHash: "b".repeat(64),
    plan: "plan",
    revision: 0,
    planNumber: 1,
    phase,
    stale: false,
  };
}

function stubApi(result: unknown) {
  let changed: (() => void) | null = null;
  const list = vi.fn(async () => result);
  const api = {
    listWorkApprovals: list,
    onWorkApprovalsChanged: (handler: () => void) => { changed = handler; return () => { changed = null; }; },
  } as unknown as Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;
  return { api, list, fireChanged: () => changed?.() };
}

describe("ApprovalsBell", () => {
  afterEach(() => cleanup());

  it("shows the list's total across every project, and its popover rows only navigate", async () => {
    const onOpenItem = vi.fn();
    const onOpenAll = vi.fn();
    const { api, list } = stubApi({ ok: true, items: ITEMS, total: 2, projects: PROJECTS });
    render(<ApprovalsBell api={api} projectRoot="/work/ave" onOpenItem={onOpenItem} onOpenAll={onOpenAll} />);

    const badge = await screen.findByTestId("notification-bell");
    expect(list).toHaveBeenCalledWith({ allProjects: true });
    await waitFor(() => expect(badge.textContent).toContain("2"));
    fireEvent.click(badge);
    const rows = await screen.findAllByTestId("work-approvals-popover-row");
    expect(rows.map((row) => row.getAttribute("data-approval-key"))).toEqual(["proposal:indexer:k:1", "routine:r-1"]);
    expect(screen.queryByTestId("work-approval-proposal-add")).toBeNull();
    fireEvent.click(screen.getByText("Weekday tests"));
    // A shared item opens in the project being viewed.
    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith("routine:r-1", undefined));
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());

    fireEvent.click(screen.getByTestId("notification-bell"));
    fireEvent.click(await screen.findByTestId("work-approvals-popover-view-all"));
    await waitFor(() => expect(onOpenAll).toHaveBeenCalledTimes(1));
  });

  it("keeps the bell available while loading and at zero", async () => {
    let resolve!: (value: unknown) => void;
    const api = {
      listWorkApprovals: vi.fn(() => new Promise((r) => { resolve = r; })),
      onWorkApprovalsChanged: () => () => {},
    } as unknown as WorkApprovalsProps["api"];
    render(<ApprovalsBell api={api} onOpenItem={vi.fn()} onOpenAll={vi.fn()} />);
    expect(screen.getByTestId("notification-bell")).toBeVisible();
    expect(screen.queryByTestId("notification-bell-count")).toBeNull();
    await act(async () => resolve({ ok: true, items: [], total: 0, projects: PROJECTS }));
    expect(screen.getByTestId("notification-bell")).toBeVisible();
    expect(screen.queryByTestId("notification-bell-count")).toBeNull();
  });

  it("shows a failed approval list as an error instead of treating it as empty", async () => {
    const { api } = stubApi({ ok: false, error: "work-approvals-source-unavailable", source: "proposal" });
    render(<ApprovalsBell api={api} onOpenItem={vi.fn()} onOpenAll={vi.fn()} />);
    await screen.findByTestId("notification-bell-error");
    expect(screen.getByTestId("notification-bell").getAttribute("title")).toContain("불러오지 못했습니다");
    fireEvent.click(screen.getByTestId("notification-bell"));
    expect(await screen.findByTestId("work-approvals-list-error")).toHaveTextContent("불러오지 못했습니다");
  });

  it("keeps the count live on the change signal", async () => {
    const result = { ok: true, items: ITEMS.slice(0, 1), total: 1, projects: PROJECTS };
    const { api, fireChanged } = stubApi(result);
    render(<ApprovalsBell api={api} onOpenItem={vi.fn()} onOpenAll={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("notification-bell").textContent).toContain("1"));
    Object.assign(result, { items: ITEMS, total: 2 });
    await act(async () => fireChanged());
    await waitFor(() => expect(screen.getByTestId("notification-bell").textContent).toContain("2"));
  });

  it("groups the popover by project, the viewed project first and the shared items last, and opens a plan in its own project", async () => {
    const onOpenItem = vi.fn();
    const items = [
      ...ITEMS,
      planView("plan:1", "Default plan", "/work/default"),
      planView("plan:2", "Ave plan", "/work/ave"),
      planView("plan:3", "Handbook plan", "/work/handbook"),
      // Waiting on the agent, not on the user: not in the popover.
      planView("plan:4", "Re-planning", "/work/handbook", "replanning"),
    ];
    const { api } = stubApi({ ok: true, items, total: 5, projects: PROJECTS });
    render(<ApprovalsBell api={api} projectRoot="/work/ave" onOpenItem={onOpenItem} onOpenAll={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("notification-bell"));
    const groups = await screen.findAllByTestId("work-approvals-popover-group");
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["/work/ave", "/work/default", "/work/handbook", "shared"]);
    expect(groups[0]?.textContent).toContain("지금 보는 프로젝트");
    expect(screen.queryByText("Re-planning")).toBeNull();
    fireEvent.click(screen.getByText("Handbook plan"));
    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith("plan:3", "/work/handbook"));
  });

  it("leaves focus on the card a row opened, and returns it to the badge only when the popover is dismissed", async () => {
    const card = document.createElement("button");
    document.body.appendChild(card);
    try {
      // The popover traps focus while open, so the card can only take focus once it has closed.
      let popoverOpenAtCall: boolean | null = null;
      const onOpenItem = vi.fn(() => {
        popoverOpenAtCall = screen.queryByTestId("notification-center") !== null;
        card.focus();
      });
      const { api } = stubApi({ ok: true, items: ITEMS, total: 2, projects: PROJECTS });
      render(<ApprovalsBell api={api} projectRoot="/work/ave" onOpenItem={onOpenItem} onOpenAll={vi.fn()} />);
      const badge = await screen.findByTestId("notification-bell");
      fireEvent.click(badge);
      fireEvent.click(await screen.findByText("Re-index the reports folder"));
      await waitFor(() => expect(onOpenItem).toHaveBeenCalledTimes(1));
      expect(popoverOpenAtCall).toBe(false);
      expect(document.activeElement).toBe(card);

      fireEvent.click(badge);
      const popover = await screen.findByTestId("notification-center");
      fireEvent.keyDown(popover, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());
      expect(document.activeElement).toBe(badge);
    } finally {
      card.remove();
    }
  });

  it("returns focus to the badge after 전체 보기, never to the page body", async () => {
    const onOpenAll = vi.fn();
    const { api } = stubApi({ ok: true, items: ITEMS, total: 2, projects: PROJECTS });
    render(<ApprovalsBell api={api} projectRoot="/work/ave" onOpenItem={vi.fn()} onOpenAll={onOpenAll} />);
    const badge = await screen.findByTestId("notification-bell");
    fireEvent.click(badge);
    fireEvent.click(await screen.findByTestId("work-approvals-popover-view-all"));
    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());
    expect(onOpenAll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(badge);
  });
  it("merges approvals and unread history, reads on open and keeps the visible dialog non-live", async () => {
    const history = createNotificationHistory();
    history.push({ severity: "error", message: "Install failed" });
    const { api } = stubApi({ ok: true, items: ITEMS, total: 2, projects: PROJECTS });
    render(<NotificationBell history={history} workApprovals={{ api, onOpenItem: vi.fn(), onOpenAll: vi.fn() }} />);
    await waitFor(() => expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("3"));
    expect(screen.getByTestId("notification-bell")).toHaveAccessibleName(/2.*1/);
    expect(screen.getByTestId("notification-bell-error")).toHaveClass("bg-destructive");
    fireEvent.click(screen.getByTestId("notification-bell"));
    const popup = await screen.findByRole("dialog");
    expect(popup).not.toHaveAttribute("aria-live");
    expect(screen.getByTestId("notification-approvals")).toBeVisible();
    expect(screen.getByTestId("notification-history-row")).toHaveTextContent("Install failed");
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("2");
    expect(screen.queryByTestId("notification-bell-error")).toBeNull();
    act(() => { history.push({ severity: "info", message: "Ready" }); });
    expect(screen.getAllByTestId("notification-history-row")[0]).toHaveTextContent("Ready");
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: "알림 지우기: Ready" }));
    expect(screen.getAllByTestId("notification-history-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("notification-history-clear-all"));
    expect(screen.queryAllByTestId("notification-history-row")).toHaveLength(0);
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("2");
  });

  it("runs a notice action after closing and returns focus on ordinary dismissal", async () => {
    const history = createNotificationHistory();
    const run = vi.fn(() => expect(screen.queryByTestId("notification-center")).toBeNull());
    history.push({ severity: "warning", message: "Choose a model", action: { label: "Choose", run } });
    render(<NotificationBell history={history} />);
    const bell = screen.getByTestId("notification-bell");
    fireEvent.click(bell);
    fireEvent.click(await screen.findByRole("button", { name: "Choose" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(bell).toHaveFocus();
    fireEvent.click(bell);
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bell).toHaveFocus();
  });

});

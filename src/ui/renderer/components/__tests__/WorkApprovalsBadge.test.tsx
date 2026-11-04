// @vitest-environment jsdom
/** The title-bar 확인 필요 badge: the list's total, hidden until the first result and at zero; its popover only navigates. */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkApprovalsBadge } from "../work-approvals/WorkApprovalsBadge.js";
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

function stubApi(result: unknown) {
  let changed: (() => void) | null = null;
  const list = vi.fn(async () => result);
  const api = {
    listWorkApprovals: list,
    onWorkApprovalsChanged: (handler: () => void) => { changed = handler; return () => { changed = null; }; },
  } as unknown as Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;
  return { api, list, fireChanged: () => changed?.() };
}

describe("WorkApprovalsBadge", () => {
  afterEach(() => cleanup());

  it("shows the list's total for the active project, and its popover rows only navigate", async () => {
    const onOpenItem = vi.fn();
    const onOpenAll = vi.fn();
    const { api, list } = stubApi({ ok: true, items: ITEMS, total: 2 });
    render(<WorkApprovalsBadge api={api} projectRoot="/work/ave" onOpenItem={onOpenItem} onOpenAll={onOpenAll} />);

    const badge = await screen.findByTestId("work-approvals-badge");
    expect(list).toHaveBeenCalledWith({ projectRoot: "/work/ave" });
    expect(badge.textContent).toContain("2");
    fireEvent.click(badge);
    const rows = await screen.findAllByTestId("work-approvals-popover-row");
    expect(rows.map((row) => row.getAttribute("data-approval-key"))).toEqual(["proposal:indexer:k:1", "routine:r-1"]);
    expect(screen.queryByTestId("work-approval-proposal-add")).toBeNull();
    fireEvent.click(rows[1]!);
    expect(onOpenItem).toHaveBeenCalledWith("routine:r-1");
    await waitFor(() => expect(screen.queryByTestId("work-approvals-popover")).toBeNull());

    fireEvent.click(screen.getByTestId("work-approvals-badge"));
    fireEvent.click(await screen.findByTestId("work-approvals-popover-view-all"));
    expect(onOpenAll).toHaveBeenCalledTimes(1);
  });

  it("renders nothing until the first result and nothing at zero", async () => {
    let resolve!: (value: unknown) => void;
    const api = {
      listWorkApprovals: vi.fn(() => new Promise((r) => { resolve = r; })),
      onWorkApprovalsChanged: () => () => {},
    } as unknown as Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;
    const { container } = render(<WorkApprovalsBadge api={api} onOpenItem={vi.fn()} onOpenAll={vi.fn()} />);
    expect(container.innerHTML).toBe("");
    await act(async () => resolve({ ok: true, items: [], total: 0 }));
    expect(container.innerHTML).toBe("");
  });

  it("shows a failed list as a warning dot with the reason, not as a hidden badge", async () => {
    const { api } = stubApi({ ok: false, error: "work-approvals-source-unavailable", source: "proposal" });
    render(<WorkApprovalsBadge api={api} onOpenItem={vi.fn()} onOpenAll={vi.fn()} />);
    const dot = await screen.findByTestId("work-approvals-badge-error");
    expect(dot.getAttribute("title")).toContain("불러오지 못했습니다");
    expect(screen.queryByTestId("work-approvals-badge")).toBeNull();
  });

  it("keeps the count live on the change signal", async () => {
    const result = { ok: true, items: ITEMS.slice(0, 1), total: 1 };
    const { api, fireChanged } = stubApi(result);
    render(<WorkApprovalsBadge api={api} onOpenItem={vi.fn()} onOpenAll={vi.fn()} />);
    expect((await screen.findByTestId("work-approvals-badge")).textContent).toContain("1");
    Object.assign(result, { items: ITEMS, total: 2 });
    await act(async () => fireChanged());
    await waitFor(() => expect(screen.getByTestId("work-approvals-badge").textContent).toContain("2"));
  });
});

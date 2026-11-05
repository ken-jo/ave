// @vitest-environment jsdom
/** 확인 필요 plan approvals: the stored plan as a real card (the agent's plan beside the host's facts), decided only by a button press that
 * sends the run id and stored hash; queued plans expand before they can be decided; a re-planning plan is listed but not counted; and the
 * all-projects mode groups every authorized project. */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkApprovalStack, type WorkApprovalActions } from "../work-approvals/WorkApprovalStack.js";
import { splitPlanSections } from "../work-approvals/PlanDecisionControls.js";
import type { AveApi } from "../../types.js";
import type {
  WorkApprovalListResult,
  WorkApprovalProject,
  WorkApprovalView,
  WorkPlanApprovalView,
  WorkProposalApprovalView,
} from "../../../../shared/work-approvals-types.js";

const CHECKOUT = { projectRoot: "/work/checkout", projectName: "checkout" };
const PROJECTS: WorkApprovalProject[] = [
  { projectRoot: "/work/default", projectName: "기본 프로젝트", isDefault: true },
  { projectRoot: "/work/checkout", projectName: "checkout", isDefault: false },
  { projectRoot: "/work/handbook", projectName: "team-handbook", isDefault: false },
];
const HASH = "a".repeat(64);
const NOW = Date.parse("2026-06-15T12:12:00.000Z");

const STRUCTURED_PLAN = [
  "## Summary",
  "Retry failed payment webhooks.",
  "## Steps",
  "1. Read the webhook handler.",
  "2. Add a retry queue.",
  "## Changes",
  "src/webhooks/*",
  "## Risks",
  "Duplicate deliveries; revert the queue commit.",
].join("\n");

function plan(overrides: Partial<WorkPlanApprovalView> = {}): WorkPlanApprovalView {
  return {
    kind: "plan",
    key: "plan:4",
    scope: { type: "project", projectRoot: CHECKOUT.projectRoot, isDefault: false },
    title: "Retry payment webhooks",
    arrivedAt: "2026-06-15T12:00:00.000Z",
    itemId: 4,
    runId: "run-4",
    planHash: HASH,
    plan: STRUCTURED_PLAN,
    revision: 0,
    phase: "pending",
    stale: false,
    ...overrides,
  };
}

function proposal(overrides: Partial<WorkProposalApprovalView> = {}): WorkProposalApprovalView {
  return {
    kind: "proposal",
    key: "proposal:indexer:k:1",
    scope: { type: "unscoped" },
    title: "Re-index the reports folder",
    arrivedAt: "2026-06-15T12:05:00.000Z",
    proposalId: "indexer:k:1",
    summary: "18 files changed.",
    pluginLabel: "Indexer",
    priority: "medium",
    expiresAt: "2026-06-22T12:00:00.000Z",
    state: "Stale.",
    evidence: [],
    blockers: [],
    ...overrides,
  };
}

function okList(items: WorkApprovalView[], total = items.filter((i) => i.kind !== "plan" || i.phase === "pending").length): WorkApprovalListResult {
  return { ok: true, items, total, projects: PROJECTS };
}

function stubApi(result: WorkApprovalListResult | ((request: unknown) => WorkApprovalListResult), decide?: AveApi["decideWorkPlan"]) {
  let changed: (() => void) | null = null;
  const list = vi.fn(async (request: unknown) => (typeof result === "function" ? result(request) : result));
  const decideWorkPlan = vi.fn(decide ?? (async () => ({ ok: true as const, status: "approved" as const, redactedCount: 0 })));
  const api = {
    listWorkApprovals: list,
    onWorkApprovalsChanged: (handler: () => void) => { changed = handler; return () => { changed = null; }; },
    decideWorkPlan,
  } as unknown as Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged" | "decideWorkPlan">;
  return { api, list, decideWorkPlan, fireChanged: () => changed?.() };
}

function actions(overrides: Partial<WorkApprovalActions> = {}): WorkApprovalActions {
  return {
    acceptProposal: vi.fn(async () => ({ ok: true as const, itemId: 9 })),
    dismissProposal: vi.fn(async () => ({ ok: true as const })),
    runItem: vi.fn(),
    openRoutine: vi.fn(),
    acknowledgeRoutineFailure: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

function renderStack(api: ReturnType<typeof stubApi>["api"], extra: Partial<Parameters<typeof WorkApprovalStack>[0]> = {}) {
  return render(<WorkApprovalStack api={api} project={CHECKOUT} actions={actions()} now={() => NOW} {...extra} />);
}

describe("splitPlanSections", () => {
  it("splits a plan written under the four headings, and keeps anything else whole", () => {
    expect(splitPlanSections(STRUCTURED_PLAN)).toEqual({
      summary: "Retry failed payment webhooks.",
      steps: "1. Read the webhook handler.\n2. Add a retry queue.",
      changes: "src/webhooks/*",
      risks: "Duplicate deliveries; revert the queue commit.",
    });
    expect(splitPlanSections("Just do it.\n1. one\n2. two")).toBeNull();
    // Missing one heading is not a split plan.
    expect(splitPlanSections("## Summary\nx\n## Steps\ny\n## Risks\nz")).toBeNull();
  });
});

describe("확인 필요 — the plan card", () => {
  afterEach(() => cleanup());

  it("shows the agent's plan by heading and the host's facts apart from it", async () => {
    const { api } = stubApi(okList([plan({ revision: 1 })]));
    renderStack(api);
    const head = await screen.findByTestId("work-approval-head");
    expect(within(head).getByTestId("work-approval-kind").textContent).toBe("계획 승인");
    const agent = within(head).getByTestId("work-approval-plan-agent");
    expect(within(agent).getByTestId("work-approval-plan-section-steps").textContent).toContain("Add a retry queue.");
    expect(within(agent).getByTestId("work-approval-plan-section-risks").textContent).toContain("에이전트");
    const facts = within(head).getByTestId("work-approval-plan-facts");
    expect(facts.textContent).toContain(CHECKOUT.projectRoot);
    expect(facts.textContent).toContain("전체 도구");
    expect(facts.textContent).toContain("1번");
    expect(within(head).getByTestId("work-approval-plan-meta").textContent).toContain("12분 전");
  });

  it("shows an unstructured plan whole", async () => {
    const { api } = stubApi(okList([plan({ plan: "Just retry the webhooks." })]));
    renderStack(api);
    const agent = await screen.findByTestId("work-approval-plan-agent");
    expect(agent.textContent).toContain("Just retry the webhooks.");
    expect(within(agent).queryByTestId("work-approval-plan-section-steps")).toBeNull();
  });

  it("approves the stored plan by its run and hash, and shows the run starting", async () => {
    let settle!: () => void;
    const { api, decideWorkPlan } = stubApi(okList([plan()]), () => new Promise((resolve) => {
      settle = () => resolve({ ok: true as const, status: "approved" as const, redactedCount: 0 });
    }));
    renderStack(api);
    fireEvent.click(await screen.findByTestId("work-approval-plan-approve"));
    expect(decideWorkPlan).toHaveBeenCalledWith(4, { runId: "run-4", planHash: HASH, decision: "approve" });
    expect(screen.getByTestId("work-approval-plan-approve").textContent).toContain("실행 시작 중");
    expect((screen.getByTestId("work-approval-plan-reject") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => settle());
  });

  it("asks for a note before sending a plan back, without calling main", async () => {
    const { api, decideWorkPlan } = stubApi(okList([plan()]));
    renderStack(api);
    fireEvent.click(await screen.findByTestId("work-approval-plan-request-changes"));
    const note = screen.getByTestId("work-approval-plan-note");
    expect(note.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(note);
    expect(screen.getByTestId("work-approval-plan-decision-error").textContent).toContain("무엇을 고칠지");
    expect(decideWorkPlan).not.toHaveBeenCalled();
    fireEvent.change(note, { target: { value: "Cover refunds too" } });
    fireEvent.click(screen.getByTestId("work-approval-plan-request-changes"));
    expect(decideWorkPlan).toHaveBeenCalledWith(4, { runId: "run-4", planHash: HASH, decision: "request_changes", note: "Cover refunds too" });
  });

  it("offers only re-planning or rejecting for a stale plan", async () => {
    const { api, decideWorkPlan } = stubApi(okList([plan({ stale: true })]));
    renderStack(api);
    expect((await screen.findByTestId("work-approval-plan-stale")).textContent).toContain("수정 요청으로 다시 계획");
    const approve = screen.getByTestId("work-approval-plan-approve");
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(approve);
    expect(decideWorkPlan).not.toHaveBeenCalled();
  });

  it("says nothing ran when the decision could not be saved, and keeps the note for a retry", async () => {
    const { api } = stubApi(okList([plan()]), async () => { throw new Error("disk full"); });
    renderStack(api);
    const note = await screen.findByTestId("work-approval-plan-note");
    fireEvent.change(note, { target: { value: "looks right" } });
    fireEvent.click(screen.getByTestId("work-approval-plan-approve"));
    const error = await screen.findByTestId("work-approval-plan-decision-error");
    expect(error.textContent).toContain("아무것도 실행하지 않았습니다");
    expect((screen.getByTestId("work-approval-plan-note") as HTMLTextAreaElement).value).toBe("looks right");
    expect((screen.getByTestId("work-approval-plan-approve") as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers to clear a plan that is gone, and re-lists", async () => {
    const { api, list } = stubApi(okList([plan()]), async () => ({ ok: false as const, reason: "not_found" as const }));
    renderStack(api);
    fireEvent.click(await screen.findByTestId("work-approval-plan-reject"));
    const clear = await screen.findByTestId("work-approval-plan-clear");
    expect(screen.getByTestId("work-approval-plan-decision-error").textContent).toContain("삭제되어");
    const calls = list.mock.calls.length;
    fireEvent.click(clear);
    await waitFor(() => expect(list.mock.calls.length).toBe(calls + 1));
  });

  it("puts a queued plan's decision behind expanding it", async () => {
    const { api, decideWorkPlan } = stubApi(okList([proposal({ arrivedAt: "2026-06-15T11:00:00.000Z" }), plan()]));
    renderStack(api);
    const row = await screen.findByTestId("work-approval-row");
    expect(within(row).queryByTestId("work-approval-plan-approve")).toBeNull();
    fireEvent.click(within(row).getByTestId("work-approval-row-title"));
    fireEvent.click(within(screen.getByTestId("work-approval-head")).getByTestId("work-approval-plan-approve"));
    expect(decideWorkPlan).toHaveBeenCalledTimes(1);
  });

  it("lists a re-planning plan after the decisions, dimmed and uncounted", async () => {
    const onCountChange = vi.fn();
    const { api } = stubApi(okList([
      plan({ key: "plan:5", itemId: 5, phase: "replanning", revision: 1, changeRequest: "Cover refunds", arrivedAt: "2026-06-15T10:00:00.000Z" }),
      proposal(),
    ]));
    renderStack(api, { onCountChange });
    const head = await screen.findByTestId("work-approval-head");
    expect(within(head).getByTestId("work-approval-title").textContent).toBe("Re-index the reports folder");
    expect(screen.getByTestId("work-approvals-count").textContent).toBe("1");
    const waiting = screen.getByTestId("work-approvals-replanning");
    expect(waiting.textContent).toContain("Cover refunds");
    expect(waiting.textContent).toContain("2번째 계획");
    expect(within(waiting).queryByRole("button", { name: /승인/ })).toBeNull();
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(1));
  });
});

describe("확인 필요 — all projects", () => {
  afterEach(() => cleanup());

  const ALL = okList([
    plan({ key: "plan:1", itemId: 1, title: "Default plan", scope: { type: "project", projectRoot: "/work/default", isDefault: true } }),
    plan(),
    plan({ key: "plan:2", itemId: 2, title: "Handbook plan", scope: { type: "project", projectRoot: "/work/handbook", isDefault: false } }),
    proposal(),
  ]);

  it("asks main for every project and groups the items by project, the default first and the shared ones last", async () => {
    const { api, list } = stubApi((request) => ((request as { allProjects?: true }).allProjects ? ALL : okList([plan(), proposal()])));
    renderStack(api);
    await screen.findByTestId("work-approval-head");
    fireEvent.click(screen.getByTestId("work-approvals-mode-all"));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ allProjects: true }));
    const groups = await screen.findAllByTestId("work-approvals-group");
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["/work/default", "/work/checkout", "/work/handbook", "shared"]);
    expect(within(groups[0]!).getByTestId("work-approvals-group-default")).toBeTruthy();
    // Selecting a row makes it the card.
    fireEvent.click(within(groups[2]!).getByTestId("work-approval-row-title"));
    expect(within(screen.getByTestId("work-approval-head")).getByTestId("work-approval-title").textContent).toBe("Handbook plan");
  });

  it("asks which project an accepted proposal joins", async () => {
    const accept = vi.fn(async () => ({ ok: true as const, itemId: 9 }));
    const { api } = stubApi(okList([proposal()]));
    render(<WorkApprovalStack api={api} project={CHECKOUT} actions={actions({ acceptProposal: accept })} now={() => NOW} showAllProjects />);
    const picker = await screen.findByTestId("work-approval-proposal-project");
    fireEvent.change(picker, { target: { value: "/work/handbook" } });
    fireEvent.click(screen.getByTestId("work-approval-proposal-add"));
    await waitFor(() => expect(accept).toHaveBeenCalledWith("indexer:k:1", "/work/handbook"));
  });

  it("opens in all-projects mode on request and reports the request consumed", async () => {
    const onShowAllConsumed = vi.fn();
    const { api, list } = stubApi(ALL);
    renderStack(api, { showAllRequest: true, onShowAllConsumed });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ allProjects: true }));
    expect(onShowAllConsumed).toHaveBeenCalledTimes(1);
  });

  it("focuses a popover target only from the list of the project it was asked for, not a list still loading for the old one", async () => {
    let resolveNew!: (value: WorkApprovalListResult) => void;
    const list = vi.fn(async (request: unknown) => {
      const root = (request as { projectRoot?: string }).projectRoot;
      if (root === "/work/handbook") return new Promise<WorkApprovalListResult>((resolve) => { resolveNew = resolve; });
      return okList([proposal()]);
    });
    const api = {
      listWorkApprovals: list,
      onWorkApprovalsChanged: () => () => {},
      decideWorkPlan: vi.fn(),
    } as unknown as Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged" | "decideWorkPlan">;
    const onFocusConsumed = vi.fn();
    const view = render(<WorkApprovalStack api={api} project={CHECKOUT} actions={actions()} now={() => NOW} onFocusConsumed={onFocusConsumed} />);
    await screen.findByTestId("work-approval-head");
    const handbook = { projectRoot: "/work/handbook", projectName: "team-handbook" };
    view.rerender(<WorkApprovalStack api={api} project={handbook} actions={actions()} now={() => NOW} focusKey="plan:2" onFocusConsumed={onFocusConsumed} />);
    expect(onFocusConsumed).not.toHaveBeenCalled();
    const target = plan({ key: "plan:2", itemId: 2, title: "Handbook plan", scope: { type: "project", projectRoot: "/work/handbook", isDefault: false } });
    await act(async () => resolveNew(okList([proposal(), target])));
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
    expect(within(screen.getByTestId("work-approval-head")).getByTestId("work-approval-title").textContent).toBe("Handbook plan");
  });
});

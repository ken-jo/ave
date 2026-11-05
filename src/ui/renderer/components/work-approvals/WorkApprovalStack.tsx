// 확인 필요: work-level decisions for one project (plus the shared unscoped and global ones), or every authorized project grouped. The top
// item is a real card; the rest are rows. Every action goes through its source's own channel (plan decide-plan, proposal accept/dismiss,
// the routine panel); this component decides nothing by itself and has no approve shortcut — a decision is always a button press, and a
// queued plan is expanded into the card before it can be decided. Tool-execution approvals are never here; they stay in their
// conversation's ApprovalDock.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CheckSquare, Loader2 } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { cn } from "../../../../lib/utils.js";
import type { AveApi } from "../../types.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type {
  RoutineAttentionApprovalView,
  WorkApprovalProject,
  WorkApprovalView,
  WorkPlanApprovalView,
  WorkProposalApprovalView,
} from "../../../../shared/work-approvals-types.js";
import { formatMediumDateTime } from "../../../../shared/format-time.js";
import { PlanDecisionControls, PlanText } from "./PlanDecisionControls.js";
import { formatIpcError } from "../../format-ipc-error.js";
import { errorMessage } from "../../../../shared/error-message.js";
import { BRIEFING_PROPOSAL_SOURCE_ID } from "../../../../shared/work-board-types.js";
import { useWorkApprovals, type WorkApprovalsRequest } from "../../hooks/use-work-approvals.js";

/** Show kind filter chips once the list is long enough that scanning by kind helps. */
const FILTER_CHIPS_FROM = 6;

type KindFilter = "all" | WorkApprovalView["kind"];

export function approvalAge(arrivedAt: string | null, now: number): string | null {
  if (arrivedAt === null) return null;
  const at = Date.parse(arrivedAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("workApprovals.ageNow");
  if (minutes < 60) return t("workApprovals.ageMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("workApprovals.ageHours", { count: hours });
  return t("workApprovals.ageDays", { count: Math.floor(hours / 24) });
}

/** Arrival order, oldest first; an item without a time sorts last, then by key so the order is stable. */
export function sortByArrival(items: readonly WorkApprovalView[]): WorkApprovalView[] {
  return [...items].sort((a, b) => {
    if (a.arrivedAt === b.arrivedAt) return a.key.localeCompare(b.key);
    if (a.arrivedAt === null) return 1;
    if (b.arrivedAt === null) return -1;
    return a.arrivedAt.localeCompare(b.arrivedAt) || a.key.localeCompare(b.key);
  });
}

/** Proposals (unscoped), routines (global) and plans with no project are shared by every project home; a plan in a project is that
 * project's own. */
export function isShared(item: WorkApprovalView): boolean {
  return item.scope.type === "unscoped" || item.scope.type === "global";
}

/** A plan sent back for changes waits for the agent, not the user: it is listed but never counted. */
export function isCounted(item: WorkApprovalView): boolean {
  return item.kind !== "plan" || item.phase === "pending";
}

export function kindLabel(item: WorkApprovalView): string {
  if (item.kind === "plan") return t("workApprovals.kindPlan");
  if (item.kind === "proposal") return t("workApprovals.kindProposal");
  return item.failure ? t("workApprovals.kindRoutineFailed") : t("workApprovals.kindRoutineAttention");
}

function KindChip({ item }: { item: WorkApprovalView }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 text-[11px]",
        item.kind === "routine-attention" ? "border-destructive/(--opacity-medium) text-destructive" : "border-primary/(--opacity-medium) text-primary",
      )}
      data-testid="work-approval-kind"
    >
      {kindLabel(item)}
    </Badge>
  );
}

function SharedChip() {
  return (
    <Badge variant="outline" className="shrink-0 text-[11px] text-muted-foreground" data-testid="work-approval-shared">
      {t("workApprovals.scopeShared")}
    </Badge>
  );
}

function routineReason(item: RoutineAttentionApprovalView, reason: RoutineAttentionApprovalView["reasons"][number]): string {
  switch (reason) {
    case "plugins-missing":
      return t("workApprovals.routinePluginsMissing", { plugins: (item.missingPluginIds ?? []).join(", ") });
    case "invalid-plugin-id":
      return t("workApprovals.routineInvalidPluginId");
    case "run-failed":
      if (!item.failure) throw new Error(`routine-attention ${item.routineId}: run-failed without a failure`);
      return item.failure.kind === "error"
        ? t("workApprovals.routineRunFailed", { reason: item.failure.reason })
        : t("workApprovals.routineShutdownTimeout");
  }
}

function routineDetail(item: RoutineAttentionApprovalView): string[] {
  return item.reasons.map((reason) => routineReason(item, reason));
}

/** Briefing proposals carry the host's own source id as their id prefix (`<sourceId>:<kind>:<hash>`); plugins cannot use it. */
export function proposalSource(item: WorkProposalApprovalView): string {
  return item.proposalId.startsWith(`${BRIEFING_PROPOSAL_SOURCE_ID}:`)
    ? t("workBoard.proposalSourceBriefing")
    : t("workBoard.proposalSourceLabel", { plugin: item.pluginLabel });
}

function proposalMeta(item: WorkProposalApprovalView): string {
  return t("workApprovals.proposalMeta", { source: proposalSource(item) });
}

interface WorkApprovalActionRefusal {
  ok: false;
  error: string;
  message?: string;
}

export interface WorkApprovalActions {
  /** Proposal → work item in `projectRoot`. A refusal carries an IPC error code (and the store's own wording when it gave one), which the
   * card renders through formatIpcError rather than showing the code. */
  acceptProposal: (proposalId: string, projectRoot: string | undefined) => Promise<{ ok: true; itemId: number } | WorkApprovalActionRefusal>;
  dismissProposal: (proposalId: string) => Promise<{ ok: true } | WorkApprovalActionRefusal>;
  /** Start the host's plan → approve → execute run for an item that was just added. */
  runItem: (itemId: number) => void;
  /** Open the schedule (routine) surface focused on one routine. */
  openRoutine: (routineId: string) => void;
  /** Clear the failure the card shows, named by its fire; a refusal carries the IPC error code (e.g. `routine-failure-stale`). */
  acknowledgeRoutineFailure: (routineId: string, failureFiredAt: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** A routine's actions are keyed by the failure they act on, so a refreshed card with another failure (or none) starts without the old
 * error. */
function actionsKey(item: WorkApprovalView): string {
  return item.kind === "routine-attention" ? `${item.key}:${item.failure?.firedAt ?? "-"}` : item.key;
}

interface ItemActionsProps {
  item: WorkProposalApprovalView | RoutineAttentionApprovalView;
  actions: WorkApprovalActions;
  /** The project an accepted proposal joins: the home this stack belongs to (undefined = the default project). */
  targetProjectRoot: string | undefined;
  /** All-projects mode: the user picks the project an accepted proposal joins. */
  projectChoices?: readonly WorkApprovalProject[];
  compact?: boolean;
}

function ItemActions({ item, actions, targetProjectRoot, projectChoices, compact = false }: ItemActionsProps) {
  const [pending, setPending] = useState<null | "dismiss" | "add" | "add-plan" | "acknowledge">(null);
  const [error, setError] = useState<string | null>(null);
  const defaultChoice = projectChoices?.find((project) => project.projectRoot === targetProjectRoot)
    ?? projectChoices?.find((project) => project.isDefault)
    ?? projectChoices?.[0];
  const [chosenRoot, setChosenRoot] = useState<string | undefined>(defaultChoice?.projectRoot);
  const size = compact ? "sm" : "default";

  if (item.kind === "routine-attention") {
    const failure = item.failure;
    const acknowledge = async () => {
      if (!failure) return;
      setPending("acknowledge");
      setError(null);
      try {
        const result = await actions.acknowledgeRoutineFailure(item.routineId, failure.firedAt);
        if (!result.ok) setError(formatIpcError(result.error, undefined));
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setPending(null);
      }
    };
    return (
      <div className="flex shrink-0 flex-col items-end gap-1" data-testid="work-approval-actions">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {failure && (
            <Button
              variant="outline"
              size={size}
              disabled={pending !== null}
              onClick={() => void acknowledge()}
              data-testid="work-approval-routine-acknowledge"
            >
              {pending === "acknowledge" && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />}
              {t("workApprovals.routineAcknowledge")}
            </Button>
          )}
          <Button size={size} onClick={() => actions.openRoutine(item.routineId)} data-testid="work-approval-routine-open">
            {t("workApprovals.routineOpen")}
          </Button>
        </div>
        {error !== null && (
          <p role="alert" className="text-[11px] text-destructive" data-testid="work-approval-action-error">
            {t("workApprovals.actionFailed", { error })}
          </p>
        )}
      </div>
    );
  }

  const run = async (which: "dismiss" | "add" | "add-plan") => {
    setPending(which);
    setError(null);
    try {
      if (which === "dismiss") {
        const dismissed = await actions.dismissProposal(item.proposalId);
        if (!dismissed.ok) setError(formatIpcError(dismissed.error, dismissed.message));
        return;
      }
      const accepted = await actions.acceptProposal(item.proposalId, projectChoices ? chosenRoot : targetProjectRoot);
      if (!accepted.ok) {
        setError(formatIpcError(accepted.error, accepted.message));
        return;
      }
      if (which === "add-plan") actions.runItem(accepted.itemId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };
  const busy = pending !== null;
  return (
    <div className="flex shrink-0 flex-col items-end gap-1" data-testid="work-approval-actions">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {projectChoices && (
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {t("workApprovals.proposalPickProject")}
            <select
              className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground"
              value={chosenRoot ?? ""}
              disabled={busy}
              onChange={(event) => setChosenRoot(event.target.value)}
              data-testid="work-approval-proposal-project"
            >
              {projectChoices.map((project) => (
                <option key={project.projectRoot} value={project.projectRoot}>{projectLabel(project)}</option>
              ))}
            </select>
          </label>
        )}
        <Button variant="outline" size={size} disabled={busy} onClick={() => void run("dismiss")} data-testid="work-approval-proposal-dismiss">
          {pending === "dismiss" && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />}
          {t("workApprovals.proposalDismiss")}
        </Button>
        <Button variant="outline" size={size} disabled={busy} onClick={() => void run("add")} data-testid="work-approval-proposal-add">
          {pending === "add" && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />}
          {t("workApprovals.proposalAdd")}
        </Button>
        <Button size={size} disabled={busy} onClick={() => void run("add-plan")} data-testid="work-approval-proposal-add-plan">
          {pending === "add-plan" && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />}
          {t("workApprovals.proposalAddAndPlan")}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-[11px] text-destructive" data-testid="work-approval-action-error">
          {t("workApprovals.actionFailed", { error })}
        </p>
      )}
    </div>
  );
}

function ProposalDetail({ item }: { item: WorkProposalApprovalView }) {
  return (
    <div className="mt-2 space-y-2 border-t pt-2" data-testid="work-approval-proposal-detail">
      <div>
        <h4 className="text-[11px] font-semibold text-muted-foreground">{t("workBoard.proposalStateHeading")}</h4>
        <p data-testid="work-approval-proposal-state">{item.state}</p>
      </div>
      {item.evidence.length > 0 && (
        <div>
          <h4 className="text-[11px] font-semibold text-muted-foreground">{t("workBoard.proposalEvidenceHeading")}</h4>
          <ul className="space-y-0.5" data-testid="work-approval-proposal-evidence">
            {item.evidence.map((row, index) => (
              <li key={`${row.label}:${index}`}><span className="font-medium">{row.label}</span>: {row.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {item.blockers.length > 0 && (
        <div>
          <h4 className="text-[11px] font-semibold text-muted-foreground">{t("workBoard.proposalBlockersHeading")}</h4>
          <ul className="space-y-0.5" data-testid="work-approval-proposal-blockers">
            {item.blockers.map((row, index) => (
              <li key={`${row.reason}:${index}`}>{row.resolution ? `${row.reason} → ${row.resolution}` : row.reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function projectLabel(project: Pick<WorkApprovalProject, "projectName" | "isDefault">): string {
  return project.isDefault ? t("workApprovals.defaultProject") : project.projectName;
}

function PlanFacts({ item }: { item: WorkPlanApprovalView }) {
  const rows: Array<{ label: string; value: string }> = [
    {
      label: t("workApprovals.planFactProject"),
      value: item.scope.type === "project" ? item.scope.projectRoot : t("workApprovals.planFactNoProject"),
    },
    { label: t("workApprovals.planFactTools"), value: t("workApprovals.planFactToolsValue") },
    { label: t("workApprovals.planFactPlannedAt"), value: formatMediumDateTime(item.arrivedAt) },
    { label: t("workApprovals.planFactRevisions"), value: t("workApprovals.planFactRevisionsValue", { count: item.revision }) },
  ];
  return (
    <section className="rounded-md border bg-muted/(--opacity-light) p-2" data-testid="work-approval-plan-facts">
      <h4 className="text-[11px] font-semibold text-muted-foreground">{t("workApprovals.planFactsHeading")}</h4>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-[11px] font-medium">{t("workApprovals.planFactExactPlan")}</p>
    </section>
  );
}

function PlanBody({ item, api, now, onChanged }: {
  item: WorkPlanApprovalView;
  api: Pick<AveApi, "decideWorkPlan">;
  now: number;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground" data-testid="work-approval-plan-meta">
        {t("workApprovals.planMeta", { age: approvalAge(item.arrivedAt, now) ?? "" })}
      </p>
      <section className="rounded-md border p-2" data-testid="work-approval-plan-agent">
        <h4 className="text-[11px] font-semibold text-muted-foreground">{t("workApprovals.planAgentHeading")}</h4>
        <div className="mt-1 max-h-72 overflow-auto">
          <PlanText plan={item.plan} testIdPrefix="work-approval-plan" />
        </div>
      </section>
      <PlanFacts item={item} />
      <PlanDecisionControls
        key={`${item.runId}:${item.planHash}`}
        api={api}
        itemId={item.itemId}
        runId={item.runId}
        planHash={item.planHash}
        stale={item.stale}
        onDecided={onChanged}
        onGone={onChanged}
        testIdPrefix="work-approval-plan"
      />
    </div>
  );
}

function ItemBody({ item }: { item: WorkProposalApprovalView | RoutineAttentionApprovalView }) {
  const [expanded, setExpanded] = useState(false);
  if (item.kind === "proposal") {
    return (
      <div className="space-y-1 text-xs">
        <p className="text-foreground" data-testid="work-approval-summary">{item.summary}</p>
        <p className="text-muted-foreground" data-testid="work-approval-source">{proposalMeta(item)}</p>
        <button
          type="button"
          className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-testid="work-approval-proposal-expand"
        >
          {expanded ? t("workBoard.proposalCollapse") : t("workBoard.proposalExpand")}
        </button>
        {expanded && <ProposalDetail item={item} />}
      </div>
    );
  }
  return (
    <div className="space-y-1 text-xs">
      {routineDetail(item).map((line) => (
        <p key={line} className="text-foreground" data-testid="work-approval-routine-reason">{line}</p>
      ))}
      <p className="text-muted-foreground">{t("workApprovals.routineScope")}</p>
    </div>
  );
}

interface FocusableProps {
  item: WorkApprovalView;
  focusRef: (key: string, node: HTMLElement | null) => void;
  tabIndex: number;
  onFocusItem: (key: string) => void;
}

function HeadCard({
  item, index, count, actions, targetProjectRoot, projectChoices, api, now, onChanged, focusRef, tabIndex, onFocusItem,
}: FocusableProps & {
  index: number;
  count: number;
  actions: WorkApprovalActions;
  targetProjectRoot: string | undefined;
  projectChoices?: readonly WorkApprovalProject[];
  api: Pick<AveApi, "decideWorkPlan">;
  now: number;
  onChanged: () => void;
}) {
  return (
    <article
      ref={(node) => focusRef(item.key, node)}
      tabIndex={tabIndex}
      onFocus={() => onFocusItem(item.key)}
      data-approval-key={item.key}
      data-testid="work-approval-head"
      aria-label={item.title}
      className={cn(
        "rounded-lg border bg-card p-3 shadow-e1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        item.kind === "routine-attention" && "border-l-4 border-l-destructive",
      )}
    >
      <header className="flex items-start gap-2">
        <KindChip item={item} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="work-approval-title">{item.title}</h3>
        {isShared(item) && <SharedChip />}
        <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="work-approval-position">
          {t("workApprovals.position", { index: index + 1, total: count })}
        </span>
      </header>
      {item.kind === "plan" ? (
        <div className="mt-2">
          <PlanBody item={item} api={api} now={now} onChanged={onChanged} />
        </div>
      ) : (
        <>
          <div className="mt-2">
            <ItemBody item={item} />
          </div>
          <div className="mt-3 flex justify-end">
            <ItemActions
              key={actionsKey(item)}
              item={item}
              actions={actions}
              targetProjectRoot={targetProjectRoot}
              {...(projectChoices ? { projectChoices } : {})}
            />
          </div>
        </>
      )}
    </article>
  );
}

function QueuedRow({
  item, now, actions, targetProjectRoot, selected = false, selectOnly = false, focusRef, tabIndex, onFocusItem, onExpand,
}: FocusableProps & {
  now: number;
  actions: WorkApprovalActions;
  targetProjectRoot: string | undefined;
  /** All-projects mode: this row is the card shown beside the list. */
  selected?: boolean;
  /** All-projects mode: rows only select; the card beside them carries the buttons. */
  selectOnly?: boolean;
  onExpand: (key: string) => void;
}) {
  const age = approvalAge(item.arrivedAt, now);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      onExpand(item.key);
    }
  };
  return (
    <li
      ref={(node) => focusRef(item.key, node)}
      tabIndex={tabIndex}
      onFocus={() => onFocusItem(item.key)}
      onKeyDown={onKeyDown}
      data-approval-key={item.key}
      data-testid="work-approval-row"
      aria-label={item.title}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        item.kind === "routine-attention" && "border-l-4 border-l-destructive",
        selected && "border-primary bg-accent",
      )}
    >
      <KindChip item={item} />
      <button
        type="button"
        tabIndex={-1}
        className="min-w-0 flex-1 truncate text-left text-sm"
        onClick={() => onExpand(item.key)}
        data-testid="work-approval-row-title"
      >
        {item.title}
      </button>
      {isShared(item) && <SharedChip />}
      {age !== null && <span className="shrink-0 text-[11px] text-muted-foreground">{age}</span>}
      {/* A queued plan is decided only on the card, after it is expanded there. */}
      {!selectOnly && item.kind !== "plan" && (
        <ItemActions key={actionsKey(item)} item={item} actions={actions} targetProjectRoot={targetProjectRoot} compact />
      )}
    </li>
  );
}

/** Roving focus over the head card and the rows: ↑ ↓ move, Esc returns to the head. Tab goes into a card's buttons as usual. */
function useRovingFocus(keys: readonly string[]) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusRef = useCallback((key: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
  }, []);
  const focusKey = useCallback((key: string) => {
    nodes.current.get(key)?.focus();
  }, []);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>, onEscape: () => void) => {
    if (keys.length === 0) return;
    // Only a key pressed on a card or row itself moves focus. Inside a field (the note, the project picker) or a button, the arrows and
    // Esc belong to that control.
    const current = keys.findIndex((key) => nodes.current.get(key) === event.target);
    if (current === -1) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(keys.length - 1, current + 1) : Math.max(0, current - 1);
      focusKey(keys[next]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
    }
  }, [focusKey, keys]);
  const tabIndexFor = (key: string): number => {
    const active = focusedKey !== null && keys.includes(focusedKey) ? focusedKey : keys[0];
    return key === active ? 0 : -1;
  };
  return { focusRef, focusKey, onKeyDown, setFocusedKey, tabIndexFor };
}

export interface WorkApprovalStackProps {
  api: Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged" | "decideWorkPlan">;
  /** The project whose home shows this stack; accepted proposals join it. Undefined means the default project. */
  project?: ProjectIdentity;
  actions: WorkApprovalActions;
  /** Navigation target from the title-bar popover: the item to bring to the top and focus, once. */
  focusKey?: string | null;
  onFocusConsumed?: () => void;
  /** Start in all-projects mode. */
  showAllProjects?: boolean;
  /** The popover's 전체 보기: switch to all-projects mode, once. */
  showAllRequest?: boolean;
  onShowAllConsumed?: () => void;
  /** Reports the counted (decidable) items so a narrow layout can label its tab. */
  onCountChange?: (count: number | null) => void;
  /** Injectable clock for ages (tests). */
  now?: () => number;
}

interface ApprovalGroup {
  id: string;
  label: string;
  isDefault: boolean;
  items: WorkApprovalView[];
}

/** All-projects grouping: each authorized project in the main's order (the default first), then the shared items. */
function groupByProject(items: readonly WorkApprovalView[], projects: readonly WorkApprovalProject[]): ApprovalGroup[] {
  const groups: ApprovalGroup[] = projects.map((project) => ({
    id: project.projectRoot,
    label: projectLabel(project),
    isDefault: project.isDefault,
    items: items.filter((item) => item.scope.type === "project" && item.scope.projectRoot === project.projectRoot),
  }));
  groups.push({ id: "shared", label: t("workApprovals.groupShared"), isDefault: false, items: items.filter(isShared) });
  return groups.filter((group) => group.items.length > 0);
}

function ReplanningList({ items }: { items: readonly WorkPlanApprovalView[] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5 opacity-(--opacity-strong)" data-testid="work-approvals-replanning">
      <h3 className="text-xs text-muted-foreground">{t("workApprovals.replanningHeading", { count: items.length })}</h3>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.key} className="rounded-md border border-dashed bg-card px-3 py-2 text-xs" data-approval-key={item.key}>
            <div className="flex items-center gap-2">
              <KindChip item={item} />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{t("workApprovals.replanningRevision", { count: item.planNumber })}</span>
            </div>
            {item.changeRequest !== undefined && (
              <p className="mt-1 text-muted-foreground">{t("workApprovals.replanningRequest", { note: item.changeRequest })}</p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">{t("workApprovals.replanningFooter")}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The project-home stack: this project's items plus the shared ones, oldest first, the top one as a real card. In all-projects mode the
 * rows are grouped by project and the selected one is the card beside them. */
export function WorkApprovalStack({
  api, project, actions, focusKey, onFocusConsumed, showAllProjects = false, showAllRequest, onShowAllConsumed, onCountChange, now = Date.now,
}: WorkApprovalStackProps) {
  const projectRoot = project?.projectRoot;
  const [allProjects, setAllProjects] = useState(showAllProjects);
  const request = useMemo<WorkApprovalsRequest>(
    () => (allProjects ? { allProjects: true } : projectRoot === undefined ? {} : { projectRoot }),
    [allProjects, projectRoot],
  );
  const { state, refresh, requestKey } = useWorkApprovals(api, request);
  // A stale acknowledgement means the routine's failure already moved on; re-list so the card shows its current state.
  const stackActions = useMemo<WorkApprovalActions>(() => ({
    ...actions,
    acknowledgeRoutineFailure: async (routineId, failureFiredAt) => {
      const result = await actions.acknowledgeRoutineFailure(routineId, failureFiredAt);
      if (!result.ok && result.error === "routine-failure-stale") await refresh();
      return result;
    },
  }), [actions, refresh]);
  const relist = useCallback(() => { void refresh(); }, [refresh]);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const sorted = useMemo(() => (state.status === "ready" ? sortByArrival(state.items) : []), [state]);
  const decidable = useMemo(() => sorted.filter(isCounted), [sorted]);
  const replanning = useMemo(
    () => sorted.filter((item): item is WorkPlanApprovalView => item.kind === "plan" && item.phase === "replanning"),
    [sorted],
  );
  const projects = state.status === "ready" ? state.projects : [];
  const filtered = useMemo(() => (filter === "all" ? decidable : decidable.filter((item) => item.kind === filter)), [filter, decidable]);
  const groups = useMemo(() => (allProjects ? groupByProject(filtered, projects) : []), [allProjects, filtered, projects]);
  // All-projects mode reads top to bottom by group, so its first item (the one Esc returns to) is the first row, not the oldest.
  const listed = useMemo(() => (allProjects ? groups.flatMap((group) => group.items) : filtered), [allProjects, filtered, groups]);
  const head = listed.find((item) => item.key === expandedKey) ?? listed[0] ?? null;
  const queued = listed.filter((item) => item !== head);
  // All-projects rows list every item (the card is the selected one); a project home lists the rest under its card.
  const order = useMemo(
    () => (allProjects ? groups.flatMap((group) => group.items.map((item) => item.key)) : head ? [head.key, ...queued.map((item) => item.key)] : []),
    [allProjects, groups, head, queued],
  );
  const roving = useRovingFocus(order);
  const clock = now();
  const fresh = state.status === "ready" && state.requestKey === requestKey;

  useEffect(() => {
    onCountChange?.(state.status === "ready" ? decidable.length : null);
  }, [decidable.length, onCountChange, state.status]);

  useEffect(() => {
    if (!showAllRequest) return;
    setAllProjects(true);
    setFilter("all");
    onShowAllConsumed?.();
  }, [onShowAllConsumed, showAllRequest]);

  // A popover navigation lands here: show that item as the card and focus it, then report the request consumed (once per request). Only a
  // list that answers the current request counts: after the popover switched projects, the previous project's list is still on screen.
  // A target that is no longer listed (decided elsewhere, or waiting on the agent) lands on the card on top, or on the stack when it is
  // empty, so the popover never leaves focus on the page body.
  const handledFocusKey = useRef<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const firstKeyRef = useRef<string | undefined>(undefined);
  firstKeyRef.current = order[0];
  const focusNode = roving.focusKey;
  useEffect(() => {
    if (!focusKey) {
      handledFocusKey.current = null;
      return;
    }
    if (!fresh || handledFocusKey.current === focusKey) return;
    handledFocusKey.current = focusKey;
    const listedNow = decidable.some((item) => item.key === focusKey);
    if (listedNow) {
      setFilter("all");
      setExpandedKey(focusKey);
    }
    requestAnimationFrame(() => {
      const target = listedNow ? focusKey : firstKeyRef.current;
      if (target !== undefined) focusNode(target);
      else sectionRef.current?.focus();
    });
    onFocusConsumed?.();
  }, [decidable, focusKey, focusNode, fresh, onFocusConsumed]);

  if (state.status === "loading") {
    return (
      <section aria-busy="true" aria-label={t("workApprovals.loading")} data-testid="work-approvals-loading" className="space-y-2">
        <div className="h-28 animate-pulse rounded-lg bg-muted" />
        <div className="h-10 animate-pulse rounded-md bg-muted" />
        <div className="h-10 animate-pulse rounded-md bg-muted" />
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section data-testid="work-approvals-error" role="alert" className="rounded-md border border-destructive/(--opacity-medium) p-3 text-xs text-destructive">
        {formatIpcError(state.error, undefined)}
      </section>
    );
  }

  const projectCount = decidable.filter((item) => !isShared(item)).length;
  const sharedCount = decidable.length - projectCount;
  const countOf = (kind: WorkApprovalView["kind"]) => decidable.filter((item) => item.kind === kind).length;
  const kinds: Array<{ id: KindFilter; label: string }> = [
    { id: "all", label: t("workApprovals.filterAll", { count: decidable.length }) },
    { id: "plan", label: t("workApprovals.filterPlan", { count: countOf("plan") }) },
    { id: "proposal", label: t("workApprovals.filterProposal", { count: countOf("proposal") }) },
    { id: "routine-attention", label: t("workApprovals.filterRoutine", { count: countOf("routine-attention") }) },
  ];
  const select = (key: string) => {
    setExpandedKey(key);
    requestAnimationFrame(() => roving.focusKey(key));
  };
  const switchMode = (all: boolean) => {
    setAllProjects(all);
    setFilter("all");
    setExpandedKey(null);
  };

  const headCard = head && (
    <HeadCard
      item={head}
      index={allProjects ? listed.indexOf(head) : 0}
      count={listed.length}
      actions={stackActions}
      targetProjectRoot={projectRoot}
      {...(allProjects ? { projectChoices: projects } : {})}
      api={api}
      now={clock}
      onChanged={relist}
      // In all-projects mode the row is the focus target; the card beside it is reached with Tab.
      focusRef={allProjects ? () => {} : roving.focusRef}
      tabIndex={allProjects ? -1 : roving.tabIndexFor(head.key)}
      onFocusItem={roving.setFocusedKey}
    />
  );
  const rowFor = (item: WorkApprovalView) => (
    <QueuedRow
      key={item.key}
      item={item}
      now={clock}
      actions={stackActions}
      targetProjectRoot={projectRoot}
      selected={allProjects && item === head}
      selectOnly={allProjects}
      focusRef={roving.focusRef}
      tabIndex={roving.tabIndexFor(item.key)}
      onFocusItem={roving.setFocusedKey}
      onExpand={select}
    />
  );

  return (
    <section
      aria-label={t("workApprovals.title")}
      data-testid="work-approvals"
      data-mode={allProjects ? "all" : "project"}
      ref={sectionRef}
      tabIndex={-1}
      className="flex min-h-0 flex-col gap-2 outline-none"
      onKeyDown={(event) => roving.onKeyDown(event, () => {
        setExpandedKey(null);
        if (order[0]) roving.focusKey(order[0]);
      })}
    >
      <header className="flex flex-wrap items-center gap-2">
        <CheckSquare className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{t("workApprovals.title")}</h2>
        <Badge variant="outline" data-testid="work-approvals-count">{decidable.length}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="work-approvals-scope">
          {allProjects
            ? t("workApprovals.headerAllProjects", { count: decidable.length })
            : t("workApprovals.headerScope", { project: projectCount, shared: sharedCount })}
        </span>
        <div role="group" aria-label={t("workApprovals.modeLabel")} className="flex gap-1">
          <Button
            size="sm"
            variant={allProjects ? "outline" : "default"}
            aria-pressed={!allProjects}
            onClick={() => switchMode(false)}
            data-testid="work-approvals-mode-project"
          >
            {t("workApprovals.modeProject")}
          </Button>
          <Button
            size="sm"
            variant={allProjects ? "default" : "outline"}
            aria-pressed={allProjects}
            onClick={() => switchMode(true)}
            data-testid="work-approvals-mode-all"
          >
            {t("workApprovals.modeAllProjects")}
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">{t("workApprovals.orderArrival")}</span>
      </header>

      {decidable.length >= FILTER_CHIPS_FROM && (
        <div role="group" className="flex flex-wrap gap-1" data-testid="work-approvals-filters">
          {kinds.map((kind) => (
            <Button
              key={kind.id}
              size="sm"
              variant={filter === kind.id ? "default" : "outline"}
              aria-pressed={filter === kind.id}
              onClick={() => { setFilter(kind.id); setExpandedKey(null); }}
              data-testid={`work-approvals-filter-${kind.id}`}
            >
              {kind.label}
            </Button>
          ))}
        </div>
      )}

      {head === null ? (
        <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground" data-testid="work-approvals-empty">
          {t("workApprovals.empty")}
        </p>
      ) : allProjects ? (
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-64 flex-1 basis-64 space-y-2">
            {groups.map((group) => (
              <section key={group.id} data-testid="work-approvals-group" data-group={group.id} className="space-y-1">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  {group.label}
                  {group.isDefault && (
                    <Badge variant="outline" className="text-[10px]" data-testid="work-approvals-group-default">
                      {t("workApprovals.defaultTag")}
                    </Badge>
                  )}
                  <span className="font-normal">{group.items.length}</span>
                </h3>
                <ul className="space-y-1.5">{group.items.map(rowFor)}</ul>
              </section>
            ))}
          </div>
          <div className="min-w-72 flex-[2] basis-80">{headCard}</div>
        </div>
      ) : (
        <>
          {headCard}
          {queued.length > 0 && (
            <>
              <h3 className="text-xs text-muted-foreground">{t("workApprovals.queuedHeading", { count: queued.length })}</h3>
              <ul className="space-y-1.5" data-testid="work-approvals-queue">{queued.map(rowFor)}</ul>
            </>
          )}
        </>
      )}
      {head !== null && (
        <p className="text-[11px] text-muted-foreground" data-testid="work-approvals-keyboard-legend">{t("workApprovals.keyboardLegend")}</p>
      )}
      <ReplanningList items={replanning} />
      <p className="text-[11px] text-muted-foreground" data-testid="work-approvals-tool-note">{t("workApprovals.toolApprovalsNote")}</p>
    </section>
  );
}

// 확인 필요: work-level decisions for one project (plus the shared unscoped and global ones), or every project grouped. The top item is a
// real card; the rest are rows with their own buttons. Every action goes through its source's own channel (proposal accept/dismiss, the
// routine panel); this component decides nothing by itself and has no approve shortcut — a decision is always a button press.
// Tool-execution approvals are never here; they stay in their conversation's ApprovalDock.
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
  WorkApprovalView,
  WorkProposalApprovalView,
} from "../../../../shared/work-approvals-types.js";
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

/** Proposals (unscoped) and routines (global) are shared by every project home. Plan approvals (WA-1) will be the project-scoped kind. */
function isShared(item: WorkApprovalView): boolean {
  return item.scope.type === "unscoped" || item.scope.type === "global";
}

export function kindLabel(item: WorkApprovalView): string {
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
  item: WorkApprovalView;
  actions: WorkApprovalActions;
  /** The project an accepted proposal joins: the home this stack belongs to (undefined = the default project). */
  targetProjectRoot: string | undefined;
  compact?: boolean;
}

function ItemActions({ item, actions, targetProjectRoot, compact = false }: ItemActionsProps) {
  const [pending, setPending] = useState<null | "dismiss" | "add" | "add-plan" | "acknowledge">(null);
  const [error, setError] = useState<string | null>(null);
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
      const accepted = await actions.acceptProposal(item.proposalId, targetProjectRoot);
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

function ItemBody({ item }: { item: WorkApprovalView }) {
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
  item, index, count, actions, targetProjectRoot, focusRef, tabIndex, onFocusItem,
}: FocusableProps & {
  index: number; count: number; actions: WorkApprovalActions; targetProjectRoot: string | undefined;
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
      <div className="mt-2">
        <ItemBody item={item} />
      </div>
      <div className="mt-3 flex justify-end">
        <ItemActions key={actionsKey(item)} item={item} actions={actions} targetProjectRoot={targetProjectRoot} />
      </div>
    </article>
  );
}

function QueuedRow({
  item, now, actions, targetProjectRoot, focusRef, tabIndex, onFocusItem, onExpand,
}: FocusableProps & {
  now: number; actions: WorkApprovalActions; targetProjectRoot: string | undefined; onExpand: (key: string) => void;
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
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        item.kind === "routine-attention" && "border-l-4 border-l-destructive",
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
      <ItemActions key={actionsKey(item)} item={item} actions={actions} targetProjectRoot={targetProjectRoot} compact />
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
    // The focused node decides, not state: a focus change and a key press can land in the same tick.
    const active = typeof document === "undefined" ? null : document.activeElement;
    const current = keys.findIndex((key) => nodes.current.get(key) === active);
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
  api: Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;
  /** The project whose home shows this stack; accepted proposals join it. Undefined means the default project. */
  project?: ProjectIdentity;
  actions: WorkApprovalActions;
  /** Navigation target from the title-bar popover: the item to bring to the top and focus, once. */
  focusKey?: string | null;
  onFocusConsumed?: () => void;
  /** Reports the visible count so a narrow layout can label its tab. */
  onCountChange?: (count: number | null) => void;
  /** Injectable clock for ages (tests). */
  now?: () => number;
}

/** The project-home stack: this project's items plus the shared ones, oldest first, the top one as a real card. */
export function WorkApprovalStack({ api, project, actions, focusKey, onFocusConsumed, onCountChange, now = Date.now }: WorkApprovalStackProps) {
  const projectRoot = project?.projectRoot;
  const request = useMemo<WorkApprovalsRequest>(() => (projectRoot === undefined ? {} : { projectRoot }), [projectRoot]);
  const { state, refresh } = useWorkApprovals(api, request);
  // A stale acknowledgement means the routine's failure already moved on; re-list so the card shows its current state.
  const stackActions = useMemo<WorkApprovalActions>(() => ({
    ...actions,
    acknowledgeRoutineFailure: async (routineId, failureFiredAt) => {
      const result = await actions.acknowledgeRoutineFailure(routineId, failureFiredAt);
      if (!result.ok && result.error === "routine-failure-stale") await refresh();
      return result;
    },
  }), [actions, refresh]);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const sorted = useMemo(() => (state.status === "ready" ? sortByArrival(state.items) : []), [state]);
  const filtered = useMemo(() => (filter === "all" ? sorted : sorted.filter((item) => item.kind === filter)), [filter, sorted]);
  const head = filtered.find((item) => item.key === expandedKey) ?? filtered[0] ?? null;
  const queued = filtered.filter((item) => item !== head);
  const order = useMemo(() => (head ? [head.key, ...queued.map((item) => item.key)] : []), [head, queued]);
  const roving = useRovingFocus(order);
  const clock = now();

  useEffect(() => {
    onCountChange?.(state.status === "ready" ? state.items.length : null);
  }, [onCountChange, state]);

  // A popover navigation lands here: show that item as the card and focus it, then report the request consumed (once per request).
  const handledFocusKey = useRef<string | null>(null);
  const focusNode = roving.focusKey;
  useEffect(() => {
    if (!focusKey) {
      handledFocusKey.current = null;
      return;
    }
    if (state.status !== "ready" || handledFocusKey.current === focusKey) return;
    handledFocusKey.current = focusKey;
    if (sorted.some((item) => item.key === focusKey)) {
      setFilter("all");
      setExpandedKey(focusKey);
      requestAnimationFrame(() => focusNode(focusKey));
    }
    onFocusConsumed?.();
  }, [focusKey, focusNode, onFocusConsumed, sorted, state.status]);

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

  const projectCount = sorted.filter((item) => !isShared(item)).length;
  const sharedCount = sorted.length - projectCount;
  const kinds: Array<{ id: KindFilter; label: string }> = [
    { id: "all", label: t("workApprovals.filterAll", { count: sorted.length }) },
    { id: "proposal", label: t("workApprovals.filterProposal", { count: sorted.filter((i) => i.kind === "proposal").length }) },
    { id: "routine-attention", label: t("workApprovals.filterRoutine", { count: sorted.filter((i) => i.kind === "routine-attention").length }) },
  ];

  return (
    <section
      aria-label={t("workApprovals.title")}
      data-testid="work-approvals"
      className="flex min-h-0 flex-col gap-2"
      onKeyDown={(event) => roving.onKeyDown(event, () => {
        setExpandedKey(null);
        if (order[0]) roving.focusKey(order[0]);
      })}
    >
      <header className="flex items-center gap-2">
        <CheckSquare className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{t("workApprovals.title")}</h2>
        <Badge variant="outline" data-testid="work-approvals-count">{sorted.length}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="work-approvals-scope">
          {t("workApprovals.headerScope", { project: projectCount, shared: sharedCount })}
        </span>
        <span className="text-xs text-muted-foreground">{t("workApprovals.orderArrival")}</span>
      </header>

      {sorted.length >= FILTER_CHIPS_FROM && (
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
      ) : (
        <>
          <HeadCard
            item={head}
            index={0}
            count={filtered.length}
            actions={stackActions}
            targetProjectRoot={projectRoot}
            focusRef={roving.focusRef}
            tabIndex={roving.tabIndexFor(head.key)}
            onFocusItem={roving.setFocusedKey}
          />
          {queued.length > 0 && (
            <>
              <h3 className="text-xs text-muted-foreground">{t("workApprovals.queuedHeading", { count: queued.length })}</h3>
              <ul className="space-y-1.5" data-testid="work-approvals-queue">
                {queued.map((item) => (
                  <QueuedRow
                    key={item.key}
                    item={item}
                    now={clock}
                    actions={stackActions}
                    targetProjectRoot={projectRoot}
                    focusRef={roving.focusRef}
                    tabIndex={roving.tabIndexFor(item.key)}
                    onFocusItem={roving.setFocusedKey}
                    onExpand={(key) => { setExpandedKey(key); requestAnimationFrame(() => roving.focusKey(key)); }}
                  />
                ))}
              </ul>
            </>
          )}
          <p className="text-[11px] text-muted-foreground" data-testid="work-approvals-keyboard-legend">{t("workApprovals.keyboardLegend")}</p>
        </>
      )}
      <p className="text-[11px] text-muted-foreground" data-testid="work-approvals-tool-note">{t("workApprovals.toolApprovalsNote")}</p>
    </section>
  );
}

// Title-bar badge for 확인 필요: the list's `total` (every authorized project), hidden at zero and until the first result. Its popover
// lists each counted item once, grouped by project (the viewed project first, the shared items last), and only navigates; it has no
// decide buttons — decisions are made on the card in that project's home.
import { useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { formatIpcError } from "../../format-ipc-error.js";
import { Badge } from "../../../../components/ui/badge.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover.js";
import type { AveApi } from "../../types.js";
import type { WorkApprovalProject, WorkApprovalView } from "../../../../shared/work-approvals-types.js";
import { useWorkApprovals, type WorkApprovalsRequest } from "../../hooks/use-work-approvals.js";
import { approvalAge, isCounted, isShared, kindLabel, projectLabel, proposalSource, sortByArrival } from "./WorkApprovalStack.js";

export interface WorkApprovalsBadgeProps {
  api: Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;
  /** The active project, listed first; undefined is the app-managed default project. */
  projectRoot?: string;
  /** Open this item's card: in its own project's home, or the viewed one for a shared item (`projectRoot` undefined). */
  onOpenItem: (key: string, projectRoot: string | undefined) => void;
  /** Open the project home's stack. */
  onOpenAll: () => void;
  now?: () => number;
}

function rowSubtitle(item: WorkApprovalView): string {
  if (item.kind === "plan") return t("workApprovals.planSource");
  if (item.kind === "proposal") return proposalSource(item);
  return t("workApprovals.routineScope");
}

const ALL_PROJECTS: WorkApprovalsRequest = { allProjects: true };

interface PopoverGroup {
  id: string;
  label: string;
  current: boolean;
  items: WorkApprovalView[];
}

function popoverGroups(items: readonly WorkApprovalView[], projects: readonly WorkApprovalProject[], viewedRoot: string | undefined): PopoverGroup[] {
  const viewed = projects.find((project) => (viewedRoot === undefined ? project.isDefault : project.projectRoot === viewedRoot));
  const ordered = viewed ? [viewed, ...projects.filter((project) => project !== viewed)] : [...projects];
  const groups: PopoverGroup[] = ordered.map((project) => ({
    id: project.projectRoot,
    label: projectLabel(project),
    current: project === viewed,
    items: items.filter((item) => item.scope.type === "project" && item.scope.projectRoot === project.projectRoot),
  }));
  groups.push({ id: "shared", label: t("workApprovals.groupShared"), current: false, items: items.filter(isShared) });
  return groups.filter((group) => group.items.length > 0);
}

export function WorkApprovalsBadge({ api, projectRoot, onOpenItem, onOpenAll, now = Date.now }: WorkApprovalsBadgeProps) {
  const { state } = useWorkApprovals(api, ALL_PROJECTS);
  const groups = useMemo(
    () => (state.status === "ready" ? popoverGroups(sortByArrival(state.items.filter(isCounted)), state.projects, projectRoot) : []),
    [projectRoot, state],
  );
  const [open, setOpen] = useState(false);
  // A row's navigation waits until the popover has closed: while open it traps focus, so the card it opens could not take focus, and
  // on close it would hand focus back to the badge. Dismissing without a choice still returns focus to the badge.
  const pendingAction = useRef<(() => void) | null>(null);
  // A failed list is not "nothing to review": it shows as a warning dot whose tooltip says why, never as a hidden badge.
  if (state.status === "error") {
    const message = formatIpcError(state.error, undefined);
    return (
      <span
        role="status"
        aria-label={message}
        title={message}
        data-testid="work-approvals-badge-error"
        className="inline-flex h-6 items-center px-1"
      >
        <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden />
      </span>
    );
  }
  // Hidden until the first result and at zero: an empty badge would be noise on most launches.
  if (state.status !== "ready" || state.total === 0) return null;
  const clock = now();
  // A row opens a card that takes focus, so its navigation waits for the close. 전체 보기 focuses nothing of its own, so it runs at once and
  // the popover returns focus to the badge as usual.
  const openRow = (action: () => void) => {
    pendingAction.current = action;
    setOpen(false);
  };
  const openAll = () => {
    setOpen(false);
    onOpenAll();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("workApprovals.badgeLabel", { count: state.total })}
          data-testid="work-approvals-badge"
          className="inline-flex h-6 items-center gap-1 rounded-full border border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) px-2 text-[11.5px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
          {t("workApprovals.badge", { count: state.total })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 p-0"
        data-testid="work-approvals-popover"
        onCloseAutoFocus={(event) => {
          const action = pendingAction.current;
          if (action === null) return;
          pendingAction.current = null;
          event.preventDefault();
          action();
        }}
      >
        <header className="flex items-baseline justify-between border-b px-3 py-2">
          <h2 className="text-sm font-semibold">{t("workApprovals.popoverTitle", { count: state.total })}</h2>
          <span className="text-[11px] text-muted-foreground">{t("workApprovals.popoverScope")}</span>
        </header>
        <div className="max-h-80 space-y-2 overflow-y-auto px-2 py-2">
          {groups.map((group) => (
            <section key={group.id} data-testid="work-approvals-popover-group" data-group={group.id}>
              <h3 className="px-1 pb-1 text-xs font-semibold text-muted-foreground">
                {group.label} <span className="font-normal">{group.items.length}</span>
                {group.current && <span className="font-normal"> · {t("workApprovals.popoverCurrentProject")}</span>}
              </h3>
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => openRow(() => onOpenItem(item.key, item.scope.type === "project" ? item.scope.projectRoot : undefined))}
                      data-testid="work-approvals-popover-row"
                      data-approval-key={item.key}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Badge variant="outline" className="shrink-0 text-[11px]">
                        {kindLabel(item)}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{item.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{rowSubtitle(item)}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{approvalAge(item.arrivedAt, clock)}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t("workApprovals.popoverFooter")}</span>
          <button
            type="button"
            className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
            onClick={openAll}
            data-testid="work-approvals-popover-view-all"
          >
            {t("workApprovals.popoverViewAll")}
          </button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}

import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { formatIpcError } from "../../format-ipc-error.js";
import { Badge } from "../../../../components/ui/badge.js";
import type { AveApi } from "../../types.js";
import type { WorkApprovalProject, WorkApprovalView } from "../../../../shared/work-approvals-types.js";
import type { WorkApprovalsState } from "../../hooks/use-work-approvals.js";
import { approvalAge, isCounted, isShared, kindLabel, projectLabel, proposalSource, sortByArrival } from "./WorkApprovalStack.js";

export interface WorkApprovalsProps {
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

/** Shared approval rows navigate to their owning cards; only those cards can decide. */
export function WorkApprovalsList({ state, projectRoot, onOpenItem, onOpenAll, now = Date.now }: Omit<WorkApprovalsProps, "api"> & { state: WorkApprovalsState }) {
  const groups = useMemo(
    () => state.status === "ready" ? popoverGroups(sortByArrival(state.items.filter(isCounted)), state.projects, projectRoot) : [],
    [projectRoot, state],
  );
  const clock = now();
  const total = state.status === "ready" ? state.total : 0;
  return <section data-testid="notification-approvals">
    {state.status === "error" && <p className="px-3 py-2 text-sm text-destructive" data-testid="work-approvals-list-error">{formatIpcError(state.error, undefined)}</p>}
        <header className="flex items-baseline justify-between border-b px-3 py-2">
          <h2 className="text-sm font-semibold">{t("workApprovals.popoverTitle", { count: total })}</h2>
          <span className="text-dense text-muted-foreground">{t("workApprovals.popoverScope")}</span>
        </header>
        {state.status === "ready" && total === 0 && <p className="px-3 py-3 text-sm text-muted-foreground" data-testid="work-approvals-empty">{t("workApprovals.nothingToReview")}</p>}
        {groups.length > 0 && <>
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
                      onClick={() => onOpenItem(item.key, item.scope.type === "project" ? item.scope.projectRoot : undefined)}
                      data-testid="work-approvals-popover-row"
                      data-approval-key={item.key}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Badge variant="outline" className="shrink-0 text-dense">
                        {kindLabel(item)}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{item.title}</span>
                        <span className="block truncate text-dense text-muted-foreground">{rowSubtitle(item)}</span>
                      </span>
                      <span className="shrink-0 text-dense text-muted-foreground">{approvalAge(item.arrivedAt, clock)}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="flex items-center justify-between gap-2 border-t px-3 py-2 text-dense text-muted-foreground">
          <span>{t("workApprovals.popoverFooter")}</span>
          <button
            type="button"
            className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
            onClick={onOpenAll}
            data-testid="work-approvals-popover-view-all"
          >
            {t("workApprovals.popoverViewAll")}
          </button>
        </footer>
        </>}

  </section>;
}

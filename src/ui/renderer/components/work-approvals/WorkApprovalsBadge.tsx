// Title-bar badge for 확인 필요: the list's `total` (every authorized project), hidden at zero and until the first result. Its popover
// lists each item once and only navigates; it has no decide buttons — decisions are made on the card in the project home. Every kind
// today is unscoped or global, so the active project's list is the whole set; per-project groups arrive with plan approvals (WA-1).
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { Badge } from "../../../../components/ui/badge.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover.js";
import type { AveApi } from "../../types.js";
import type { WorkApprovalView } from "../../../../shared/work-approvals-types.js";
import { useWorkApprovals, type WorkApprovalsRequest } from "../../hooks/use-work-approvals.js";
import { approvalAge, kindLabel, proposalSource, sortByArrival } from "./WorkApprovalStack.js";

export interface WorkApprovalsBadgeProps {
  api: Pick<AveApi, "listWorkApprovals" | "onWorkApprovalsChanged">;
  /** The active project; undefined resolves to the app-managed default project in main. */
  projectRoot?: string;
  /** Open the project home's stack with this item as the card. */
  onOpenItem: (key: string) => void;
  /** Open the project home's stack. */
  onOpenAll: () => void;
  now?: () => number;
}

function rowSubtitle(item: WorkApprovalView): string {
  if (item.kind === "proposal") return proposalSource(item);
  return t("workApprovals.routineScope");
}

export function WorkApprovalsBadge({ api, projectRoot, onOpenItem, onOpenAll, now = Date.now }: WorkApprovalsBadgeProps) {
  const request = useMemo<WorkApprovalsRequest>(() => (projectRoot === undefined ? {} : { projectRoot }), [projectRoot]);
  const { state } = useWorkApprovals(api, request);
  const [open, setOpen] = useState(false);
  // Hidden until the first result and at zero: an empty badge would be noise on most launches.
  if (state.status !== "ready" || state.total === 0) return null;
  const items = sortByArrival(state.items);
  const clock = now();
  const select = (action: () => void) => {
    setOpen(false);
    action();
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
      <PopoverContent align="end" className="w-96 p-0" data-testid="work-approvals-popover">
        <header className="flex items-baseline justify-between border-b px-3 py-2">
          <h2 className="text-sm font-semibold">{t("workApprovals.popoverTitle", { count: state.total })}</h2>
          <span className="text-[11px] text-muted-foreground">{t("workApprovals.popoverScope")}</span>
        </header>
        <div className="max-h-80 overflow-y-auto px-2 py-2">
          <h3 className="px-1 pb-1 text-xs font-semibold text-muted-foreground">
            {t("workApprovals.groupShared")} <span className="font-normal">{items.length}</span>
          </h3>
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => select(() => onOpenItem(item.key))}
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
        </div>
        <footer className="flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t("workApprovals.popoverFooter")}</span>
          <button
            type="button"
            className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
            onClick={() => select(onOpenAll)}
            data-testid="work-approvals-popover-view-all"
          >
            {t("workApprovals.popoverViewAll")}
          </button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}

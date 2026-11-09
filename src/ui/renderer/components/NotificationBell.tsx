import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bell, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatIpcError } from "../format-ipc-error.js";
import { createNotificationHistory, notificationCounts, type NotificationHistory, type NoticeRecord } from "../notification-history.js";
import { useWorkApprovals, type WorkApprovalsRequest } from "../hooks/use-work-approvals.js";
import { WorkApprovalsList, type WorkApprovalsProps } from "./work-approvals/WorkApprovalsList.js";
import { approvalAge } from "./work-approvals/WorkApprovalStack.js";

const ALL_PROJECTS: WorkApprovalsRequest = { allProjects: true };
const EMPTY_APPROVALS_API: WorkApprovalsProps["api"] = {};
const SEVERITY_DOT = { info: "bg-info", success: "bg-success", warning: "bg-warning", error: "bg-destructive" };

export function NotificationBell({ history: suppliedHistory, workApprovals, onOpenNotification }: {
  history?: NotificationHistory;
  workApprovals?: WorkApprovalsProps;
  onOpenNotification?: (notice: NoticeRecord) => void;
}) {
  const { t } = useTranslation();
  const [localHistory] = useState(createNotificationHistory);
  const history = suppliedHistory ?? localHistory;
  const records = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const { state } = useWorkApprovals(workApprovals?.api ?? EMPTY_APPROVALS_API, ALL_PROJECTS);
  const approvalState = workApprovals ? state : { status: "ready" as const, items: [], projects: [], total: 0, requestKey: "all" };
  const approvals = approvalState.status === "ready" ? approvalState.total : 0;
  const counts = notificationCounts(records, approvals);
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const pendingAction = useRef<(() => void) | null>(null);
  const handleOpenChange = (value: boolean) => { history.setOpen(value); setOpen(value); };
  useEffect(() => {
    if (!open) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => () => history.setOpen(false), [history]);
  const navigate = (action: () => void) => { pendingAction.current = action; handleOpenChange(false); };
  const listFailed = approvalState.status === "error";
  return <Popover open={open} onOpenChange={handleOpenChange}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="icon" className="relative h-(--chrome-control-height) w-(--chrome-control-height) shrink-0"
        data-testid="notification-bell" aria-label={t("notificationCenter.label", { approvals, unread: counts.unread })}
        title={listFailed ? formatIpcError(approvalState.error, undefined) : t("notificationCenter.title")}>
        <Bell className="h-4 w-4" aria-hidden="true" />
        {counts.total > 0 && <Badge aria-hidden="true" data-testid="notification-bell-count" className="pointer-events-none absolute -right-1 -top-1 h-3.5 min-w-3.5 justify-center p-0 text-tiny leading-none">{counts.total}</Badge>}
        {(counts.error || listFailed) && <span data-testid="notification-bell-error" aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 rounded-full bg-destructive" />}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" data-testid="notification-center" aria-label={t("notificationCenter.title")}
      className="w-96 max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto p-0"
      onCloseAutoFocus={() => {
        const action = pendingAction.current;
        if (!action) return;
        pendingAction.current = null;
        queueMicrotask(action);
      }}>
      <WorkApprovalsList state={approvalState} projectRoot={workApprovals?.projectRoot} now={() => clock}
        onOpenItem={(key, root) => navigate(() => workApprovals?.onOpenItem(key, root))}
        onOpenAll={() => { handleOpenChange(false); workApprovals?.onOpenAll(); }} />
      <section data-testid="notification-history">
        <header className="flex items-baseline justify-between gap-2 border-y px-3 py-2">
          <h2 className="text-sm font-semibold">{t("notificationCenter.notices")}</h2>
          <button type="button" disabled={records.length === 0} className="text-xs text-muted-foreground disabled:opacity-50 hover:underline"
            data-testid="notification-history-clear-all" onClick={history.clearAll}>{t("notificationCenter.clearAll")}</button>
        </header>
        {records.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">{t("notificationCenter.empty")}</p>}
        <ul className="divide-y">
          {records.map((notice) => <li key={notice.id} data-testid="notification-history-row" data-notice-id={notice.id} data-severity={notice.severity} className="flex items-start gap-2 px-3 py-3">
            <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[notice.severity]}`} />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm [overflow-wrap:anywhere]">{notice.message}</p>
              <p className="text-xs text-muted-foreground">{t(`notificationCenter.source.${notice.source}`)} · <time dateTime={new Date(notice.createdAt).toISOString()}>{approvalAge(new Date(notice.createdAt).toISOString(), clock)}</time></p>
              <div className="flex flex-wrap gap-2">
                {notice.notification && onOpenNotification && <button type="button" className="text-xs underline" onClick={() => navigate(() => onOpenNotification(notice))}>{t("statusBar.toastDetailsAction")}</button>}
                {(notice.actions ?? (notice.action ? [notice.action] : [])).map((action) => <button key={action.key ?? action.label} type="button" disabled={action.disabled}
                  className="text-xs underline disabled:opacity-50" onClick={() => navigate(action.run)}>{action.label}</button>)}
              </div>
            </div>
            <button type="button" className="shrink-0 rounded p-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" data-testid="notification-history-clear"
              aria-label={t("notificationCenter.clear", { message: notice.message })} onClick={() => history.clear(notice.id)}><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
          </li>)}
        </ul>
      </section>
    </PopoverContent>
  </Popover>;
}

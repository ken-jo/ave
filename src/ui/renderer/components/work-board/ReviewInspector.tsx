import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { t } from "../../../../i18n/runtime.js";
import { workBoardReviewKind } from "../../../../shared/work-board-lifecycle.js";
import type { WorkItemResolved } from "../../../../shared/work-board-types.js";
import type { AveApi } from "../../types.js";
import { PlanDecisionControls, PlanText } from "../work-approvals/PlanDecisionControls.js";
import ReactMarkdown from "react-markdown";
import { MARKDOWN_REMARK_PLUGINS } from "../../utils/markdown-plugins.js";
import { MARKDOWN_SAFE_COMPONENTS, markdownUrlTransform } from "../../utils/markdown-safe.js";

export function ReviewInspector({ item, api, onChanged, onClose, onOpenDetail }: {
  item: WorkItemResolved;
  api: AveApi;
  onChanged: () => void;
  onClose: () => void;
  onOpenDetail: (id: number) => void;
}) {
  const kind = workBoardReviewKind(item);
  const approval = item.planApproval;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (kind === null) return null;
  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      // A changed run must be read again before the user completes its result.
      const latest = await api.getWorkBoardItem(item.id);
      if (!("status" in latest) || latest.status !== "found" || latest.item.runId !== item.runId
        || latest.item.output !== item.output || latest.item.updated_at !== item.updated_at
        || workBoardReviewKind(latest.item) !== "result") {
        setError(t("workBoard.reviewChanged"));
        return;
      }
      const result = await api.completeWorkBoardItem(item.id);
      if ("status" in result && result.status === "completed") onChanged();
      else setError(t("workBoard.errorSaveFailed"));
    } catch {
      setError(t("workBoard.errorSaveFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="shrink-0 overflow-hidden rounded-lg border border-warning/(--opacity-medium)" aria-label={t("workBoard.reviewInspector")} data-testid="work-board-review-inspector">
      <div className="flex items-center gap-2 border-b bg-muted/(--opacity-medium) px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold">{t(kind === "plan" ? "workBoard.planDecisionHeading" : "workBoard.resultReviewHeading")} · {item.title}</h3>
        <Button size="icon-xs" variant="ghost" aria-label={t("workBoard.reviewClose")} onClick={onClose}><X className="h-3 w-3" /></Button>
      </div>
      <div className="grid gap-3 p-3 @2xl:grid-cols-2">
        <div className="max-h-56 min-w-0 overflow-auto" data-testid="work-board-review-summary">
          {kind === "plan" ? <PlanText plan={item.plan ?? ""} testIdPrefix="work-board-review" /> : (
            <div className="prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} urlTransform={markdownUrlTransform} components={MARKDOWN_SAFE_COMPONENTS}>{item.output ?? ""}</ReactMarkdown>
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-2" data-testid={kind === "plan" ? "work-board-plan-decision" : "work-board-result-decision"}>
          <p className="text-dense text-muted-foreground">{t(kind === "plan" ? "workBoard.planDecisionToolNote" : "workBoard.resultReviewHint")}</p>
          {kind === "plan" && approval && item.runId ? (
            <PlanDecisionControls key={`${item.runId}:${approval.planHash}`} api={api} itemId={item.id} runId={item.runId}
              planHash={approval.planHash} stale={item.planStale === true} onDecided={onChanged} onGone={onChanged} testIdPrefix="work-board-plan" />
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenDetail(item.id)}>{t("workBoard.reviewEditDetails")}</Button>
              <Button size="sm" disabled={busy} onClick={() => void complete()} data-testid="work-board-review-complete">{t("workBoard.reviewComplete")}</Button>
            </div>
          )}
          {error && <p role="alert" className="text-dense text-destructive">{error}</p>}
        </div>
      </div>
    </section>
  );
}

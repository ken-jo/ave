import { useState } from "react";
import { t } from "../../../../i18n/runtime.js";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { WORK_BOARD_STAGES, workBoardMoveRefusal, workBoardStage, type WorkBoardStage } from "../../../../shared/work-board-lifecycle.js";
import type { WorkItemResolved } from "../../../../shared/work-board-types.js";
import type { AveApi } from "../../types.js";

export const BOARD_STAGE_LABELS: Record<WorkBoardStage, string> = {
  planned: "workBoard.columnPlanned", in_progress: "workBoard.columnInProgress", review: "workBoard.columnReview", completed: "workBoard.columnCompleted",
};

export function BoardMoveDialog({ item, target, api, onClose, onChanged }: {
  item: WorkItemResolved;
  target?: WorkBoardStage;
  api: AveApi;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [destination, setDestination] = useState<WorkBoardStage | "">(target ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = workBoardStage(item);
  const refusal = destination ? workBoardMoveRefusal(item, destination) : null;
  const move = async () => {
    if (!destination || refusal || destination === source || busy) return;
    setBusy(true);
    setError(null);
    try {
      const latest = await api.getWorkBoardItem(item.id);
      if (!("status" in latest) || latest.status !== "found" || latest.item.updated_at !== item.updated_at
        || latest.item.runId !== item.runId || latest.item.runStatus !== item.runStatus
        || workBoardStage(latest.item) !== source || workBoardMoveRefusal(latest.item, destination)) {
        setError(t("workBoard.reviewChanged"));
        return;
      }
      const result = destination === "review" ? await api.reopenWorkBoardItem(item.id)
        : destination === "completed" ? await api.completeWorkBoardItem(item.id)
        : item.status === "completed" && destination === "in_progress" ? await api.reopenWorkBoardItem(item.id)
        : await api.transitionWorkBoardItem(item.id, destination);
      if ("status" in result && ["transitioned", "completed", "reopened"].includes(result.status)) {
        onChanged();
        onClose();
      } else setError(t("workBoard.moveFailed"));
    } catch { setError(t("workBoard.moveFailed")); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent data-testid="work-board-move-dialog">
        <DialogHeader><DialogTitle>{t("workBoard.moveTitle")}</DialogTitle></DialogHeader>
        <p className="text-sm">{item.title}</p>
        <label className="space-y-1 text-sm">
          <span>{t("workBoard.moveDestination")}</span>
          <select className="w-full rounded border bg-background p-2" aria-label={t("workBoard.moveDestination")} value={destination}
            disabled={busy} onChange={(event) => { setDestination(event.target.value as WorkBoardStage); setError(null); }}>
            <option value="" disabled>{t("workBoard.moveChoose")}</option>
            {WORK_BOARD_STAGES.map((stage) => <option key={stage} value={stage} disabled={stage === source}>{t(BOARD_STAGE_LABELS[stage])}</option>)}
          </select>
        </label>
        {source === "review" && destination === "completed" && item.output && <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-sm">{item.output}</pre>}
        {refusal && <p role="alert" className="text-sm text-warning">{t(`workBoard.${refusal}`)}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("workBoard.cancelButton")}</Button>
          <Button disabled={busy || !destination || refusal !== null || destination === source} onClick={() => void move()} data-testid="work-board-move-confirm">{t("workBoard.moveConfirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

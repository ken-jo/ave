import { useDroppable } from "@dnd-kit/core";
import { t } from "../../../../i18n/runtime.js";
import type { WorkBoardStage } from "../../../../shared/work-board-lifecycle.js";
import { BOARD_STAGE_LABELS } from "./BoardMoveDialog.js";

export function BoardStageTab({ stage, selected, count, onSelect }: { stage: WorkBoardStage; selected: boolean; count: number; onSelect: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `tab:${stage}`, data: { stage } });
  return (
    <button ref={setNodeRef} type="button" role="tab" aria-selected={selected} onClick={onSelect}
      className={`rounded-md px-2.5 py-1 text-xs ${selected ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/(--opacity-half)"} ${isOver ? "ring-2 ring-ring" : ""}`}
      data-testid={`work-board-tab-${stage === "in_progress" ? "in-progress" : stage}`}>
      {t(BOARD_STAGE_LABELS[stage])} <span className="tabular-nums">{count}</span>
    </button>
  );
}

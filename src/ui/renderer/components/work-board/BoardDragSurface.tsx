import { createContext, useContext, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDndContext, useSensor, useSensors } from "@dnd-kit/core";
import { t } from "../../../../i18n/runtime.js";
import { WORK_BOARD_STAGES, workBoardMoveRefusal, workBoardStage, type WorkBoardStage } from "../../../../shared/work-board-lifecycle.js";

import type { WorkItemResolved } from "../../../../shared/work-board-types.js";
import { BOARD_STAGE_LABELS } from "./BoardMoveDialog.js";

const BoardItemsContext = createContext<readonly WorkItemResolved[]>([]);

export function useBoardDropTarget(stage: WorkBoardStage) {
  const { active } = useDndContext();
  const items = useContext(BoardItemsContext);
  const item = items.find((entry) => entry.id === active?.id);
  const refusal = item ? workBoardMoveRefusal(item, stage) : null;
  return { disabled: !item || stage === workBoardStage(item) || refusal !== null, refusal };
}

function BoardDropFeedback() {
  const { active } = useDndContext();
  const items = useContext(BoardItemsContext);
  const item = items.find((entry) => entry.id === active?.id);
  if (!item) return null;
  const refused = WORK_BOARD_STAGES.flatMap((stage) => {
    const reason = workBoardMoveRefusal(item, stage);
    return reason && stage !== workBoardStage(item) ? [{ stage, reason }] : [];
  });
  return <div role="status" className="pointer-events-none absolute inset-x-3 bottom-3 z-50 rounded-md border bg-background p-2 text-dense text-warning shadow-sm" data-testid="work-board-drop-feedback">
    {refused.map(({ stage, reason }) => <p key={stage}>{t(BOARD_STAGE_LABELS[stage])}: {t(`workBoard.${reason}`)}</p>)}
  </div>;
}

const BoardMoveContext = createContext<((itemId: number, stage?: WorkBoardStage) => void) | null>(null);
export function useBoardMove() {
  const onMove = useContext(BoardMoveContext);
  if (!onMove) throw new Error("Board move surface is missing");
  return onMove;
}

export function BoardDragSurface({ children, items, onMove }: { children: ReactNode; items: readonly WorkItemResolved[]; onMove: (itemId: number, stage?: WorkBoardStage) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragTitle, setDragTitle] = useState<string | null>(null);
  return (
    <BoardMoveContext.Provider value={onMove}>
      <BoardItemsContext.Provider value={items}>
      <DndContext sensors={sensors} collisionDetection={pointerWithin}
        accessibility={{
          screenReaderInstructions: { draggable: t("workBoard.dragInstructions") },
          announcements: {
            onDragStart: () => t("workBoard.dragStarted"),
            onDragOver: () => t("workBoard.dragInstructions"),
            onDragEnd: ({ over }) => t(over ? "workBoard.dragEnded" : "workBoard.dragCancelled"),
            onDragCancel: () => t("workBoard.dragCancelled"),
          },
        }}
        onDragStart={({ active }) => setDragTitle(String(active.data.current?.title ?? ""))}
        onDragCancel={() => setDragTitle(null)}
        onDragEnd={({ active, over }) => {
          setDragTitle(null);
          const stage = over?.data.current?.stage as WorkBoardStage | undefined;
          const item = items.find((entry) => entry.id === active.id);
          if (item && stage && stage !== workBoardStage(item) && workBoardMoveRefusal(item, stage) === null) onMove(item.id, stage);
        }}>
        <BoardDropFeedback />
        {children}
        <DragOverlay dropAnimation={null}>{dragTitle !== null && <div className="rounded-lg border bg-background p-3 text-sm shadow-lg">{dragTitle}</div>}</DragOverlay>
      </DndContext>
      </BoardItemsContext.Provider>
    </BoardMoveContext.Provider>
  );
}

import { createContext, useContext, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import { t } from "../../../../i18n/runtime.js";
import type { WorkBoardStage } from "../../../../shared/work-board-lifecycle.js";

const BoardMoveContext = createContext<((itemId: number, stage?: WorkBoardStage) => void) | null>(null);
export function useBoardMove() {
  const onMove = useContext(BoardMoveContext);
  if (!onMove) throw new Error("Board move surface is missing");
  return onMove;
}

export function BoardDragSurface({ children, onMove }: { children: ReactNode; onMove: (itemId: number, stage?: WorkBoardStage) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragTitle, setDragTitle] = useState<string | null>(null);
  return (
    <BoardMoveContext.Provider value={onMove}>
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
          if (stage && typeof active.id === "number") onMove(active.id, stage);
        }}>
        {children}
        <DragOverlay dropAnimation={null}>{dragTitle !== null && <div className="rounded-lg border bg-background p-3 text-sm shadow-lg">{dragTitle}</div>}</DragOverlay>
      </DndContext>
    </BoardMoveContext.Provider>
  );
}

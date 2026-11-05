import { useRef } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { RemoveProjectPrompt } from "../../hooks/use-remove-project.js";

export interface RemoveProjectDialogProps {
  prompt: RemoveProjectPrompt | null;
  projectName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The case 31 confirmation: what removing the project ends or deletes, what stays, and that 되돌리기 brings back only the
 * project. 취소 has the focus, so Enter and Esc both keep the project.
 */
export function RemoveProjectDialog({ prompt, projectName, onConfirm, onCancel }: RemoveProjectDialogProps) {
  const { t } = useTranslation();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const counts = prompt?.counts;
  const losses = counts && prompt
    ? ([
        ["liveTerminals", counts.liveTerminals, "sidebar.removeProjectLosesTerminals"],
        ["streamingSessions", counts.streamingSessions, "sidebar.removeProjectLosesTurns"],
        ["savedSurfaces", prompt.savedSurfaces, "sidebar.removeProjectLosesSurfaces"],
        ["pathGrants", counts.pathGrants, "sidebar.removeProjectLosesGrants"],
        ["routines", counts.routines, "sidebar.removeProjectLosesRoutines"],
      ] as const).filter(([, count]) => count > 0)
    : [];
  const notRestored = Boolean(counts && (counts.pathGrants > 0 || counts.routines > 0));
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        size="sm"
        data-testid="remove-project-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelButton.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("sidebar.removeProjectTitle", { name: projectName })}</DialogTitle>
          <DialogDescription>{t("sidebar.removeProjectDescription")}</DialogDescription>
        </DialogHeader>
        {losses.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="remove-project-losses">
            {losses.map(([key, count, label]) => (
              <li key={key} data-testid={`remove-project-loss-${key}`}>{t(label, { count })}</li>
            ))}
          </ul>
        ) : null}
        {counts && counts.detachableSessions > 0 ? (
          <div className="text-sm" data-testid="remove-project-keeps">
            <p className="text-xs font-medium text-muted-foreground">{t("sidebar.removeProjectKeepsHeading")}</p>
            <p>{t("sidebar.removeProjectKeepsSessions", { count: counts.detachableSessions })}</p>
          </div>
        ) : null}
        {notRestored ? <p className="text-xs text-muted-foreground">{t("sidebar.removeProjectUndoLimit")}</p> : null}
        <DialogFooter>
          <Button ref={cancelButton} variant="secondary" onClick={onCancel} data-testid="remove-project-cancel">
            {t("sidebar.removeProjectCancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} data-testid="remove-project-confirm">
            {t("sidebar.removeProjectConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

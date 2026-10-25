import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import { CODE_CHECKPOINT_POLICY, type RewindMode } from "../../../shared/code-rewind.js";

export function RewindDialog({ open, onCancel, onRestore }: {
  open: boolean;
  onCancel: () => void;
  onRestore: (mode: RewindMode) => Promise<{ ok: boolean }>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  async function restore(mode: RewindMode) {
    setBusy(true);
    try { await onRestore(mode); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("codeRewind.title")}</DialogTitle>
          <DialogDescription>{t("codeRewind.description")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("codeRewind.limits", {
          turns: CODE_CHECKPOINT_POLICY.maxSessionTurns,
          storage: CODE_CHECKPOINT_POLICY.maxStorageBytes / (1024 * 1024),
          file: CODE_CHECKPOINT_POLICY.maxFileBytes / (1024 * 1024),
        })}</p>
        <div className="flex flex-col gap-2">
          <Button disabled={busy} onClick={() => void restore("conversation")}>{t("codeRewind.conversation")}</Button>
          <Button disabled={busy} variant="outline" onClick={() => void restore("code")}>{t("codeRewind.code")}</Button>
          <Button disabled={busy} variant="outline" onClick={() => void restore("both")}>{t("codeRewind.both")}</Button>
          <Button disabled={busy} variant="ghost" onClick={onCancel}>{t("codeRewind.cancel")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { isWorkBoardToolApprovalSurface, type WorkBoardToolApprovalSurface } from "../../../shared/work-board-types.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { SettingsSection } from "../components/PageShell.js";
import { useNotifySaved } from "../context/SavedToastContext.js";

const SURFACE_OPTIONS: readonly { value: WorkBoardToolApprovalSurface; label: string; hint: string }[] = [
  { value: "chat", label: "workBoard.approvalSurfaceChat", hint: "workBoard.approvalSurfaceChatHint" },
  { value: "dialog", label: "workBoard.approvalSurfaceDialog", hint: "workBoard.approvalSurfaceDialogHint" },
];

/** Where a running work item's tool approval is answered: the run's chat (default) or the dialog over the board. Display location only;
 * the request and its decision are the same either way. The permissions tab reads the stored value with its other settings and passes it
 * here, with its own pending/failed notice for that read. */
export function WorkBoardApprovalSettingsContent({
  stored,
  loadNotice,
}: {
  /** The stored choice once the tab's settings read arrived; null before; "invalid" when the read held no valid choice. */
  stored: WorkBoardToolApprovalSurface | "invalid" | null;
  /** The tab's pending or failed notice for its settings read; null once it is ready. */
  loadNotice: ReactNode;
}) {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const [surface, setSurface] = useState<WorkBoardToolApprovalSurface | null>(stored === "invalid" ? null : stored);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSurface(stored === "invalid" ? null : stored);
  }, [stored]);

  const handleChange = async (next: WorkBoardToolApprovalSurface) => {
    if (next === surface) return;
    setSaving(true);
    setFailed(false);
    try {
      const result = await getApi().updateSettings({ workBoard: { toolApprovalSurface: next } });
      if ("ok" in result && result.ok === false) throw new Error("Work board approval preference was not saved");
      if (!("workBoard" in result) || !isWorkBoardToolApprovalSurface(result.workBoard.toolApprovalSurface)) {
        throw new Error("Work board approval preference response is invalid");
      }
      setSurface(result.workBoard.toolApprovalSurface);
      notifySaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      data-settings-section="permissions-work-board-approvals"
      title={t("workBoard.approvalSurfaceTitle")}
      description={t("workBoard.approvalSurfaceDescription")}
    >
      {loadNotice ?? (stored === "invalid" ? (
        <p role="alert" data-testid="work-board-approval-surface-invalid" className="text-sm text-destructive">
          {t("workBoard.approvalSurfaceReadInvalid")}
        </p>
      ) : (
        <RadioGroup
          value={surface ?? undefined}
          onValueChange={(value) => { if (isWorkBoardToolApprovalSurface(value)) void handleChange(value); }}
          disabled={surface === null || saving}
          aria-label={t("workBoard.approvalSurfaceTitle")}
          data-testid="work-board-approval-surface"
          className="space-y-2"
        >
          {SURFACE_OPTIONS.map((option) => (
            <Label key={option.value} htmlFor={`work-board-approval-${option.value}`} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
              <RadioGroupItem id={`work-board-approval-${option.value}`} value={option.value} data-value={option.value} />
              <span className="space-y-1">
                <span className="block text-sm font-medium">{t(option.label)}</span>
                <span className="block text-xs text-muted-foreground">{t(option.hint)}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      ))}
      {failed && <p role="alert" className="mt-2 text-sm text-destructive">{t("workBoard.approvalSurfaceSaveFailed")}</p>}
    </SettingsSection>
  );
}

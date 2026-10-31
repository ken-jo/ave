import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import { RecentlyDeniedPanel } from "../components/permissions/RecentlyDeniedPanel.js";

export function RecentlyDeniedDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="lg" className="max-h-[80vh] overflow-y-auto" data-testid="recently-denied-dialog">
      <DialogHeader className="sr-only"><DialogTitle>{t("recentlyDenied.title")}</DialogTitle><DialogDescription>{t("recentlyDenied.description")}</DialogDescription></DialogHeader>
      <RecentlyDeniedPanel showEmpty onRerun={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>;
}

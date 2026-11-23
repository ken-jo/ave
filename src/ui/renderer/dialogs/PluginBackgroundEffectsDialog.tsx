import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { useTranslation } from "../../../i18n/react.js";
import type { PluginBackgroundEffects } from "../types.js";

export interface PluginBackgroundEffectsReview {
  pluginId: string;
  name: string;
  reviewSha256: string;
  effects: PluginBackgroundEffects;
}

export interface PluginBackgroundEffectsDialogProps {
  review: PluginBackgroundEffectsReview | null;
  /** Why the last Allow was not saved; the card stays open so it can be retried. */
  error?: string | null;
  onDecide: (allowed: boolean) => void;
}

export function PluginBackgroundEffectsDialog({ review, error, onDecide }: PluginBackgroundEffectsDialogProps) {
  const { t } = useTranslation();
  const groups = review
    ? ([
        ["pluginBackgroundEffectsDialog.networkLabel", review.effects.networkDestinations],
        ["pluginBackgroundEffectsDialog.alertsLabel", review.effects.alertKinds],
        ["pluginBackgroundEffectsDialog.suggestionsLabel", review.effects.suggestionSources],
      ] as const).filter(([, items]) => items.length > 0)
    : [];
  return (
    <Dialog open={!!review} onOpenChange={(open) => !open && onDecide(false)}>
      <DialogContent data-testid="plugin-background-effects-dialog">
        <DialogHeader>
          <DialogTitle>{review ? t("pluginBackgroundEffectsDialog.title", { name: review.name }) : ""}</DialogTitle>
          <DialogDescription>{t("pluginBackgroundEffectsDialog.description")}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-dense">
          <li>{t("pluginBackgroundEffectsDialog.ownStorage")}</li>
          {review?.effects.llm && <li>{t("pluginBackgroundEffectsDialog.llm")}</li>}
          {review?.effects.workers && <li>{t("pluginBackgroundEffectsDialog.workers")}</li>}
          {groups.map(([label, items]) => (
            <li key={label}>
              <p className="font-medium">{t(label)}</p>
              <ul className="ml-4 list-disc font-mono">
                {items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="text-dense text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onDecide(false)}>{t("pluginBackgroundEffectsDialog.cancelButton")}</Button>
          <Button onClick={() => onDecide(true)}>{t("pluginBackgroundEffectsDialog.allowButton")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

function BackgroundEffectsList({ effects }: { effects: PluginBackgroundEffects }) {
  const { t } = useTranslation();
  const groups = ([
    ["pluginBackgroundEffectsDialog.networkLabel", effects.networkDestinations],
    ["pluginBackgroundEffectsDialog.alertsLabel", effects.alertKinds],
    ["pluginBackgroundEffectsDialog.suggestionsLabel", effects.suggestionSources],
  ] as const).filter(([, items]) => items.length > 0);
  return (
    <ul className="space-y-2 text-dense">
      <li>{t("pluginBackgroundEffectsDialog.ownStorage")}</li>
      {effects.llm && <li>{t("pluginBackgroundEffectsDialog.llm")}</li>}
      {effects.workers && <li>{t("pluginBackgroundEffectsDialog.workers")}</li>}
      {groups.map(([label, items]) => (
        <li key={label}>
          <p className="font-medium">{t(label)}</p>
          <ul className="ml-4 list-disc font-mono">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function PluginBackgroundEffectsDialog({ review, error, onDecide }: PluginBackgroundEffectsDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!review} onOpenChange={(open) => !open && onDecide(false)}>
      <DialogContent data-testid="plugin-background-effects-dialog">
        <DialogHeader>
          <DialogTitle>{review ? t("pluginBackgroundEffectsDialog.title", { name: review.name }) : ""}</DialogTitle>
          <DialogDescription>{t("pluginBackgroundEffectsDialog.description")}</DialogDescription>
        </DialogHeader>
        {review && <BackgroundEffectsList effects={review.effects} />}
        {error && <p role="alert" className="text-dense text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onDecide(false)}>{t("pluginBackgroundEffectsDialog.cancelButton")}</Button>
          <Button onClick={() => onDecide(true)}>{t("pluginBackgroundEffectsDialog.allowButton")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One row of the first-launch card; `reviewSha256` is null for an unpinned source, which no Allow can approve. */
export type PluginBackgroundEffectsUpgradeRow = Omit<PluginBackgroundEffectsReview, "reviewSha256"> & { reviewSha256: string | null };

export interface PluginBackgroundEffectsUpgradeDialogProps {
  rows: readonly PluginBackgroundEffectsUpgradeRow[] | null;
  allowed: ReadonlySet<string>;
  error?: string | null;
  onAllow: (row: PluginBackgroundEffectsUpgradeRow) => void;
  onLater: () => void;
}

export function PluginBackgroundEffectsUpgradeDialog({ rows, allowed, error, onAllow, onLater }: PluginBackgroundEffectsUpgradeDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!rows} onOpenChange={(open) => !open && onLater()}>
      <DialogContent data-testid="plugin-background-effects-upgrade-dialog">
        <DialogHeader>
          <DialogTitle>{t("pluginBackgroundEffectsUpgradeDialog.title")}</DialogTitle>
          <DialogDescription>{t("pluginBackgroundEffectsUpgradeDialog.description")}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] space-y-4 overflow-y-auto">
          {rows?.map((row) => (
            <li key={row.pluginId} data-testid={`plugin-background-effects-upgrade-row-${row.pluginId}`} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{row.name}</p>
                {allowed.has(row.pluginId)
                  ? <span className="text-dense text-muted-foreground">{t("pluginBackgroundEffectsUpgradeDialog.allowed")}</span>
                  : row.reviewSha256 !== null && (
                    <Button size="sm" onClick={() => onAllow(row)}>{t("pluginBackgroundEffectsDialog.allowButton")}</Button>
                  )}
              </div>
              {row.reviewSha256 === null && <p className="text-dense text-muted-foreground">{t("pluginConfigTab.backgroundEffectsUnpinned")}</p>}
              <BackgroundEffectsList effects={row.effects} />
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="text-dense text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="secondary" onClick={onLater}>{t("pluginBackgroundEffectsUpgradeDialog.laterButton")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

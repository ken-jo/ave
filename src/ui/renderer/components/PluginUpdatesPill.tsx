import { Puzzle, X } from "lucide-react";
import { updateViewNeedsUser, type PackageUpdateView } from "../../../shared/git-marketplace.js";
import { useTranslation } from "../../../i18n/react.js";
import { ToolbarStatusPill } from "./ToolbarStatusPill.js";

export interface PluginUpdatesPillProps {
  updates: PackageUpdateView[];
  /** Open the update review in Settings → Marketplace (design §15.6). */
  onReview: (updates: PackageUpdateView[]) => void;
  onSkip: () => void | Promise<void>;
}

/**
 * Toolbar pill for package updates that need the user. An update installs only through
 * its review — commit range, version and authority change — so a click opens
 * that review in the marketplace tab rather than installing from here.
 *
 * The full list lives in the pill's hover text — the band has room for a
 * count, and a count is what the user acts on.
 */
export function PluginUpdatesPill({ updates: offered, onReview, onSkip }: PluginUpdatesPillProps) {
  const { t } = useTranslation();
  // Only what waits for the user is counted (design §18.7.5): an update applying or already applied needs nothing from them,
  // and one waiting for idle only once it has waited 30 minutes, for *Apply now* (§18.7.4).
  const updates = offered.filter(updateViewNeedsUser);
  if (updates.length === 0) return null;

  const summary =
    updates.length === 1
      ? t("pluginUpdatesPill.summaryOne")
      : t("pluginUpdatesPill.summaryMany", { count: updates.length });
  const details = updates.map((update) => `${update.displayName} → ${update.to}`).join(", ");
  // A required update ignores a skipped version (§18.7.2): with only those shown there is nothing to skip.
  const skippable = updates.some((update) => update.required !== true);

  return (
    <ToolbarStatusPill
      tone="info"
      icon={Puzzle}
      label={
        updates.length === 1
          ? t("pluginUpdatesPill.pillLabelOne")
          : t("pluginUpdatesPill.pillLabelMany", { count: updates.length })
      }
      title={`${summary} ${details}`}
      ariaLabel={t("pluginUpdatesPill.pillAriaLabel")}
      onClick={() => onReview(updates)}
      testId="marketplace-update-action"
      {...(skippable
        ? {
            secondaryAction: {
              icon: X,
              title: t("pluginUpdatesPill.skipTitle"),
              ariaLabel: t("pluginUpdatesPill.skipAriaLabel"),
              onClick: () => void onSkip(),
              testId: "marketplace-update-skip",
            },
          }
        : {})}
    />
  );
}

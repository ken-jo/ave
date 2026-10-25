// Keep bootstrap results until dismissed or replaced by a retry event; clean completion renders nothing.

import { AlertTriangle, Info, RefreshCw, X } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { ToolbarStatusPill } from "./ToolbarStatusPill.js";
import { BOOTSTRAP_SKIP_MESSAGE_KEY } from "../../../shared/bootstrap-status.js";
import type { AppBootstrapStatus } from "../../../shared/bootstrap-status.js";

export interface BootstrapStatusPillProps {
  status: AppBootstrapStatus | null;
  onDismiss: () => void;
  onRetry: () => void;
}

/** Long error strings (multi-line tarball failures) stay hover-sized. */
function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function BootstrapStatusPill({
  status,
  onDismiss,
  onRetry,
}: BootstrapStatusPillProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (!status) return null;

  if (status.phase === "start") {
    return (
      <ToolbarStatusPill
        tone="muted"
        icon={RefreshCw}
        busy
        label={t("bootstrapStatusPill.pillInstalling")}
        title={t("bootstrapStatusPill.installing")}
        ariaLabel={t("bootstrapStatusPill.installing")}
        disabled
        testId="bootstrap-status-pill"
      />
    );
  }

  if (status.phase === "error") {
    return (
      <FailurePill
        label={t("bootstrapStatusPill.pillError")}
        title={t("bootstrapStatusPill.bootstrapError", { message: truncate(status.message) })}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />
    );
  }

  if (status.skipped) {
    // Why the bootstrap was skipped lives in `title`, and hover text is not in the accessibility tree — so the accessible name
    // carries it too, or a screen reader is told only that something can be dismissed.
    const skippedTitle = t(BOOTSTRAP_SKIP_MESSAGE_KEY[status.skipped.reason]);
    return (
      <ToolbarStatusPill
        tone="warning"
        icon={Info}
        label={t("bootstrapStatusPill.pillSkipped")}
        title={skippedTitle}
        ariaLabel={`${t("bootstrapStatusPill.dismissNotification")} ${skippedTitle}`}
        onClick={onDismiss}
        testId="bootstrap-status-pill"
      />
    );
  }

  if (status.failed.length > 0) {
    return (
      <FailurePill
        label={t("bootstrapStatusPill.pillFailed")}
        title={
          status.failed.length === 1
            ? t("bootstrapStatusPill.singlePluginFailed", {
                id: status.failed[0].id,
                error: truncate(status.failed[0].error),
              })
            : t("bootstrapStatusPill.multiplePluginsFailed", { count: status.failed.length })
        }
        onRetry={onRetry}
        onDismiss={onDismiss}
      />
    );
  }

  // complete + nothing failed + not skipped → silent.
  return null;
}

/**
 * The pill both failure states share: retry on the pill, dismiss beside it.
 *
 * Which plugin failed and why is in `title`, and hover text is not in the
 * accessibility tree — so the accessible name carries it too, or a screen
 * reader is told only that something can be retried.
 */
function FailurePill({
  label,
  title,
  onRetry,
  onDismiss,
}: {
  label: string;
  title: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ToolbarStatusPill
      tone="destructive"
      icon={AlertTriangle}
      label={label}
      title={title}
      ariaLabel={`${t("bootstrapStatusPill.pillRetryAriaLabel")} ${title}`}
      onClick={onRetry}
      testId="bootstrap-status-pill"
      secondaryAction={{
        icon: X,
        title: t("bootstrapStatusPill.dismissNotification"),
        ariaLabel: t("bootstrapStatusPill.dismissNotification"),
        onClick: onDismiss,
        testId: "bootstrap-status-dismiss",
      }}
    />
  );
}

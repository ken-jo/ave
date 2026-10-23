import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SandboxCapabilityInfo } from "../../../shared/sandbox-capability-info.js";

/** The host shell plan, rather than the toggle or platform potential, owns status. */
export function SandboxStatusBadge({
  capability,
  statusQueryFailed = false,
  onRetry,
}: {
  capability: SandboxCapabilityInfo | null | undefined;
  statusQueryFailed?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const plan = capability?.shellExecutionPlan;
  // No host snapshot means status is still unknown; platform potential and
  // desired settings cannot stand in for the actual execution route.
  if (!statusQueryFailed && (!plan || plan.sandboxed)) return null;
  const reasonText =
    plan?.fallbackReason === "platform-unsupported"
      ? t("sandboxStatus.unsupported")
      : plan?.fallbackReason === "disabled-by-setting"
        ? t("sandboxStatus.disabled")
        : plan?.fallbackReason === "windows-partial-shell-acl-unsafe" ||
            plan?.fallbackReason === "active-sandbox-not-shell-contained"
          ? t("sandboxStatus.shellUnavailable")
          : t("sandboxStatus.unavailable");
  const label = statusQueryFailed
    ? t("sandboxStatus.queryFailed")
    : t("sandboxStatus.off", { reason: reasonText });
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
    <Badge
      variant="outline"
      role="status"
      data-testid={statusQueryFailed ? "sandbox-status-query-failed" : "sandbox-off-status"}
      className="shrink-0 whitespace-normal border-warning text-warning"
      title={label}
    >
      {label}
    </Badge>
    {statusQueryFailed && onRetry ? (
      <Button type="button" size="sm" variant="ghost" onClick={onRetry} className="h-6 px-1 text-caption">
        {t("sandboxStatus.retry")}
      </Button>
    ) : null}
    </span>
  );
}

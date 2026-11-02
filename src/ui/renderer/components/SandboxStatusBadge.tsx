import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { useTranslation } from "../../../i18n/react.js";
import type { SandboxCapabilityInfo, SandboxWindowsExtensionPlan } from "../../../shared/sandbox-capability-info.js";

const EXTENSION_BADGE_KEY: Record<Exclude<SandboxWindowsExtensionPlan["readiness"], "off" | "ready">, string> = {
  checking: "sandboxStatus.extensionsChecking",
  rejected: "sandboxStatus.extensionsRejected",
  fallback: "sandboxStatus.extensionsFallback",
  unavailable: "sandboxStatus.extensionsUnavailable",
};

/** Requested extension confinement that is not on a ready container is shown even while shells are healthy; a ready
 * selection or an unrequested one shows nothing. */
function extensionBadgeKey(capability: SandboxCapabilityInfo | null | undefined): string | null {
  const plan = capability?.windowsSubstrate?.extensionPlan;
  if (!plan || plan.requestedBackend !== "mxc" || plan.readiness === "ready" || plan.readiness === "off") return null;
  return EXTENSION_BADGE_KEY[plan.readiness];
}

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
  const extensionKey = statusQueryFailed ? null : extensionBadgeKey(capability);
  // No host snapshot means status is still unknown; platform potential and desired settings cannot stand in for the actual execution route.
  const shellBadge = statusQueryFailed || (plan !== undefined && !plan.sandboxed);
  if (!shellBadge && extensionKey === null) return null;
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
    {shellBadge ? (
      <Badge
        variant="outline"
        role="status"
        data-testid={statusQueryFailed ? "sandbox-status-query-failed" : "sandbox-off-status"}
        className="shrink-0 whitespace-normal border-warning text-warning"
        title={label}
      >
        {label}
      </Badge>
    ) : null}
    {extensionKey !== null ? (
      <Badge
        variant="outline"
        role="status"
        data-testid="sandbox-extension-status"
        data-readiness={capability?.windowsSubstrate?.extensionPlan?.readiness}
        className="shrink-0 whitespace-normal border-warning text-warning"
        title={t(extensionKey)}
      >
        {t(extensionKey)}
      </Badge>
    ) : null}
    {statusQueryFailed && onRetry ? (
      <Button type="button" size="sm" variant="ghost" onClick={onRetry} className="h-6 px-1 text-caption">
        {t("sandboxStatus.retry")}
      </Button>
    ) : null}
    </span>
  );
}

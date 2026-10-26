import { TriangleAlert } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { chatSurface } from "./chat-surface.js";

/** Usage describes the next send, so the owning composer supplies its width and placement. */
export function ComposerContextNotice({
  percent,
  autoCompactEnabled,
}: {
  percent: number;
  autoCompactEnabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!Number.isFinite(percent) || percent < 0.9) return null;
  const blocked = percent > 1 && autoCompactEnabled === false;
  return (
    <div
      className={`${chatSurface({ edge: "quiet", elevation: "flat" })} mb-2 flex min-w-0 items-start gap-2 px-3 py-2 text-xs text-foreground`}
      data-testid="composer-context-notice"
      data-severity={blocked ? "error" : "warning"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <TriangleAlert className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${blocked ? "text-destructive" : "text-warning"}`} aria-hidden="true" />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        <span className="font-medium">{t("chatView.contextUsagePercent", { pct: Math.round(percent * 100) })}</span>
        {autoCompactEnabled === true ? ` ${t(percent >= 1 ? "chatView.contextOverflowWarning" : "chatView.contextNearingWarning")}` : null}
      </span>
    </div>
  );
}

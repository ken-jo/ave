import { useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { BrowserSiteChoice } from "../../../../shared/permissions-events.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";

export function BrowserSiteApprovalCard({ request, interactionLocked, onDecide }: {
  request: ApprovalRequest;
  interactionLocked: boolean;
  onDecide: (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => void;
}) {
  const { t } = useTranslation();
  const answered = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const answer = (choice?: BrowserSiteChoice) => {
    if (answered.current || interactionLocked) return;
    answered.current = true;
    setSubmitted(true);
    onDecide(choice === undefined ? "deny-once" : "allow-once", undefined, choice === undefined ? undefined : { browserSiteChoice: choice });
  };
  return <section role="dialog" tabIndex={-1} aria-label={t("toolApprovalDialog.siteTitle", { origin: request.browserSite ?? "" })} data-testid="tool-approval-panel" data-approval-request-id={request.id} data-approval-tool-name={request.toolName} className="flex min-h-0 flex-col gap-3 overflow-auto p-3"
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); answer(); } }}>
    <div data-testid="browser-site-approval-card" className="contents">
    <h3 className="break-words text-sm font-semibold">{t("toolApprovalDialog.siteTitle", { origin: request.browserSite ?? "" })}</h3>
    <p className="break-all text-xs text-muted-foreground">{request.toolName}</p>
    <p className="text-xs text-muted-foreground">{t("toolApprovalDialog.siteSessionOnly")}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={interactionLocked || submitted} onClick={() => answer("this-site")}>{t("toolApprovalDialog.siteAllow")}</Button>
      <Button disabled={interactionLocked || submitted} variant="outline" onClick={() => answer("any-site")}>{t("toolApprovalDialog.siteAllowAny")}</Button>
      <Button disabled={interactionLocked || submitted} variant="outline" onClick={() => answer()}>{t("toolApprovalDialog.deny")}</Button>
    </div>
    </div>
  </section>;
}

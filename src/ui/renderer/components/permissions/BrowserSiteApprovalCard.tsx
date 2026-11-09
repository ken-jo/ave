import { useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { BrowserSiteChoice } from "../../../../shared/permissions-events.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";

export function BrowserSiteApprovalCard({ request, conversationLabel, interactionLocked, onDecide }: {
  request: ApprovalRequest;
  conversationLabel: string;
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
  return <section role="dialog" tabIndex={-1} aria-label={t("toolApprovalDialog.siteTitle", { origin: request.browserSite ? new URL(request.browserSite).origin : "" })} data-testid="tool-approval-panel" data-approval-request-id={request.id} data-approval-tool-name={request.toolName} className="flex min-h-0 flex-col gap-3 overflow-auto p-3"
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); answer(); } }}>
    <div data-testid="browser-site-approval-card" className="contents">
    <p className="break-words text-xs text-muted-foreground" data-testid="approval-conversation">{conversationLabel}</p>
    {request.requestingAgentTitle && <p className="break-words text-sm font-medium">{t("toolApprovalDialog.requestingAgent", { title: request.requestingAgentTitle })}</p>}
    <p className="break-all text-xs text-muted-foreground">{request.toolName}</p>
    <p className="text-xs text-muted-foreground">{t("toolApprovalDialog.siteSessionOnly")}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={interactionLocked || submitted} onClick={() => answer("this-site")}>{t("toolApprovalDialog.siteAllow")}</Button>
      <Button disabled={interactionLocked || submitted} variant="outline" onClick={() => answer("any-site")}>{t("toolApprovalDialog.siteAllowAny")}</Button>
      <Button disabled={interactionLocked || submitted} variant="outline" onClick={() => answer()}>{t("toolApprovalDialog.decisionDeny")}</Button>
    </div>
    </div>
  </section>;
}

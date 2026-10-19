/**
 * The approval dock card for an `egress-host` ask: a sandboxed shell call
 * wants to connect to a host no grant covers. The person denies it once or
 * allows it for one of the scopes the host offered (Allow once, This
 * conversation, This workspace, Always). The answer is `allow-once` with the
 * picked scope, or `deny-once`; the host refuses any scope it did not offer.
 */
import type { ReactElement } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import type { EgressGrantScope } from "../../../../shared/egress-grant-scopes.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";

const SCOPE_LABEL_KEYS: Record<EgressGrantScope, string> = {
  once: "egressApprovalCard.allowOnce",
  conversation: "egressApprovalCard.allowConversation",
  workspace: "egressApprovalCard.allowWorkspace",
  always: "egressApprovalCard.allowAlways",
};

const TOOL_LABELS: Record<string, string> = { bash: "Bash", powershell: "PowerShell" };

export function EgressHostApprovalCard({
  request,
  conversationLabel,
  interactionLocked = false,
  onDecide,
}: {
  request: ApprovalRequest;
  conversationLabel: string;
  interactionLocked?: boolean;
  onDecide: (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => void;
}): ReactElement {
  const { t } = useTranslation();
  const payload = request.egressHost;
  const tool = TOOL_LABELS[request.toolName] ?? request.toolName;
  if (payload === undefined) {
    // A request of this kind always carries its payload; one that does not
    // can only be denied.
    return (
      <div className="space-y-2 p-3 text-xs" data-testid="egress-approval-card" role="alert">
        <p className="text-destructive">{t("egressApprovalCard.invalid")}</p>
        <Button size="sm" variant="outline" disabled={interactionLocked} onClick={() => onDecide("deny-once")}>
          {t("egressApprovalCard.denyOnce")}
        </Button>
      </div>
    );
  }
  const target = payload.host.includes(":") ? `[${payload.host}]:${payload.port}` : `${payload.host}:${payload.port}`;
  return (
    <section
      className="flex min-w-0 flex-col gap-3 px-3 py-2 sm:px-4 sm:py-3"
      data-testid="egress-approval-card"
      data-approval-request-id={request.id}
      data-egress-host={payload.host}
      data-egress-port={payload.port}
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold">{t("egressApprovalCard.title")}</h3>
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {t("egressApprovalCard.body", { tool })}
        </p>
        <code className="block min-w-0 break-all font-mono text-xs font-semibold" data-testid="egress-approval-target">
          {target}
        </code>
        {payload.network === "local" ? (
          <p role="note" className="min-w-0 break-words text-xs font-medium text-warning" data-testid="egress-approval-local-warning">
            {t("egressApprovalCard.localWarning")}
          </p>
        ) : null}
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {t("egressApprovalCard.conversation", { conversation: conversationLabel })}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={interactionLocked}
          data-testid="egress-approval-deny"
          onClick={() => onDecide("deny-once")}
        >
          {t("egressApprovalCard.denyOnce")}
        </Button>
        {payload.scopes.map((scope) => (
          <Button
            key={scope}
            size="sm"
            variant={scope === "once" ? "default" : "secondary"}
            disabled={interactionLocked}
            data-testid={`egress-approval-allow-${scope}`}
            onClick={() => onDecide("allow-once", undefined, { egressScope: scope })}
          >
            {t(SCOPE_LABEL_KEYS[scope])}
          </Button>
        ))}
      </div>
      {payload.scopes.includes("workspace") || payload.scopes.includes("always") ? (
        <p className="min-w-0 break-words text-xs text-muted-foreground">{t("egressApprovalCard.revokeHint")}</p>
      ) : null}
    </section>
  );
}

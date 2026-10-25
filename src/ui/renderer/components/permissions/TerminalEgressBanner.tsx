/** A terminal tab's network asks, drawn in the tab with the decision row every approval card shares (owner 2026-10-25, unified approval card).
 * Offer only host-authorized scopes; local/unverified destinations cannot be allowed permanently. The host holds connections for 120 s, denies
 * on tab close, and folds same-destination requests; Escape denies without stealing terminal focus (not while a decision dropdown or the rule
 * editor has it). */
import type { KeyboardEvent, ReactElement } from "react";
import { useTranslation } from "../../../../i18n/react.js";
import type { ApprovalRequest } from "../../types.js";
import { useOptionalApprovalSurface } from "../../hooks/use-approval.js";
import type { ApprovalChoice } from "../../types.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import { NetworkDecisionRow, egressTargetLabel } from "./EgressHostApprovalCard.js";

/** Whether `request` is an egress ask from terminal tab `tabId`. */
function isTerminalEgressAsk(request: ApprovalRequest, tabId: string): boolean {
  return request.kind === "egress-host" && request.egressHost?.terminalTabId === tabId;
}

/**
 * The requests the window's docks draw: every one but a terminal's egress ask
 * whose tab has a mounted view (that view's banner draws it). A terminal ask
 * whose tab is not on screen stays with the docks — the lane — so it can still
 * be answered before it times out.
 */
export function approvalsForDocks(
  queue: readonly ApprovalRequest[],
  tabMounted: (tabId: string) => boolean,
): ApprovalRequest[] {
  return queue.filter((request) => {
    const tabId = request.egressHost?.terminalTabId;
    return tabId === undefined || !tabMounted(tabId);
  });
}

export function TerminalEgressBanner({ tabId }: { tabId: string }): ReactElement | null {
  const { t } = useTranslation();
  const approvals = useOptionalApprovalSurface();
  if (approvals === null) return null;
  const asks = approvals.queue.filter((request) => isTerminalEgressAsk(request, tabId));
  if (asks.length === 0) return null;
  return (
    <section
      role="region"
      aria-label={t("terminalEgressBanner.region")}
      aria-live="polite"
      className="max-h-[45%] min-w-0 shrink-0 divide-y divide-warning/(--opacity-medium) overflow-y-auto border-b border-warning/(--opacity-medium) bg-warning/(--opacity-soft)"
      data-testid="terminal-egress-banner"
      data-tab-id={tabId}
    >
      {asks.map((request) => (
        <TerminalEgressRow
          key={request.id}
          request={request}
          locked={approvals.lockedRequestId === request.id}
          decide={(choice, pattern, extras) => void (extras === undefined
            ? approvals.decide(request.id, choice)
            : approvals.decide(request.id, choice, pattern, extras))}
        />
      ))}
    </section>
  );
}

function TerminalEgressRow({
  request,
  locked,
  decide,
}: {
  request: ApprovalRequest;
  locked: boolean;
  decide: (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const payload = request.egressHost;
  if (payload === undefined) return null;
  const target = egressTargetLabel(payload.host, payload.port);
  const headingId = `terminal-egress-${request.id}`;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || locked) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[role="menu"], input') !== null) return;
    event.preventDefault();
    event.stopPropagation();
    decide("deny-once");
  };
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-1.5 px-3 py-2 text-xs"
      data-testid="terminal-egress-row"
      data-approval-request-id={request.id}
      data-egress-host={payload.host}
      data-egress-port={payload.port}
      data-egress-network={payload.network}
      onKeyDown={onKeyDown}
    >
      <p id={headingId} className="min-w-0 font-semibold text-foreground">
        <code className="break-all font-mono" data-testid="terminal-egress-target">
          {t("terminalEgressBanner.blocked", { target })}
        </code>
      </p>
      {payload.network === "local" ? (
        <p role="note" className="min-w-0 break-words font-medium text-warning" data-testid="terminal-egress-local-warning">
          {t("egressApprovalCard.localWarningTab")}
        </p>
      ) : null}
      {payload.network === "unverified" ? (
        <p role="note" className="min-w-0 break-words font-medium text-warning" data-testid="terminal-egress-unverified-warning">
          {t("egressApprovalCard.unverifiedWarningTab")}
        </p>
      ) : null}
      <NetworkDecisionRow request={request} locked={locked} decide={decide} compact />
      <p className="min-w-0 break-words text-muted-foreground">
        {t("terminalEgressBanner.held")}
        {payload.scopes.includes("always") ? ` ${t("egressApprovalCard.revokeHintTerminal")}` : ""}
      </p>
    </div>
  );
}

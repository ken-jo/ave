/**
 * The banner a workspace terminal tab shows when its shell (or anything it
 * started) connects to a host no grant covers (design F): "<host>:<port>
 * blocked" with Deny and an allow per scope the host offered — Allow once
 * (this one connection), This tab (until the tab's shell exits), Always
 * (every workspace terminal); a local or unverified destination is offered
 * only Allow once and This tab, with the card's warning. Terminals have no
 * This workspace: every tab runs in the app's one default workspace.
 *
 * The connection is held while the banner is up. The host denies it after
 * 120 s without an answer, or at once when the tab closes, and then retires
 * the request, which takes its row down here.
 *
 * One row per pending destination: the host already folds every connection
 * from this tab to one destination into one request, and different
 * destinations stack, oldest first. The answer goes through the window's one
 * approval queue, as the dock's does.
 *
 * Keyboard: every action is a button in the tab order; Escape in a row
 * denies that row. Focus is not taken from the terminal when a row appears —
 * the person may be typing — and the region is announced politely instead.
 */
import type { KeyboardEvent, ReactElement } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ApprovalRequest } from "../../types.js";
import { useOptionalApprovalSurface } from "../../hooks/use-approval.js";
import { EGRESS_SCOPE_LABEL_KEYS, egressTargetLabel } from "./EgressHostApprovalCard.js";

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
          onDeny={() => void approvals.decide(request.id, "deny-once")}
          onAllow={(scope) => void approvals.decide(request.id, "allow-once", undefined, { egressScope: scope })}
        />
      ))}
    </section>
  );
}

function TerminalEgressRow({
  request,
  locked,
  onDeny,
  onAllow,
}: {
  request: ApprovalRequest;
  locked: boolean;
  onDeny: () => void;
  onAllow: (scope: NonNullable<ApprovalRequest["egressHost"]>["scopes"][number]) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const payload = request.egressHost;
  if (payload === undefined) return null;
  const target = egressTargetLabel(payload.host, payload.port);
  const headingId = `terminal-egress-${request.id}`;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || locked) return;
    event.preventDefault();
    event.stopPropagation();
    onDeny();
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
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {payload.scopes.map((scope) => (
          <Button
            key={scope}
            size="sm"
            variant={scope === "once" ? "default" : "secondary"}
            className="h-7 px-2 text-xs"
            disabled={locked}
            data-testid={`terminal-egress-allow-${scope}`}
            onClick={() => onAllow(scope)}
          >
            {t(EGRESS_SCOPE_LABEL_KEYS[scope])}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={locked}
          data-testid="terminal-egress-deny"
          onClick={onDeny}
        >
          {t("egressApprovalCard.denyOnce")}
        </Button>
      </div>
      <p className="min-w-0 break-words text-muted-foreground">
        {t("terminalEgressBanner.held")}
        {payload.scopes.includes("workspace") || payload.scopes.includes("always") ? ` ${t("egressApprovalCard.revokeHint")}` : ""}
      </p>
    </div>
  );
}

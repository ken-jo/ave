/** The approval dock card for an `egress-host` ask: a sandboxed shell call wants to connect to a host no grant covers. It draws the one decision row every approval card shares (owner 2026-10-25, unified approval card): Deny ▾ | Allow for session ▾ | Allow once. An allow left as it is answers `allow-once` with the grant of that lifetime (This session, This project, Always, from the scopes the host offered); Always deny, and an allow whose rule the person edited, first saves a `Network(...)` host rule and then answers once. The host refuses any scope it did not offer. A workspace terminal tab's ask (`egressHost.terminalTabId`) is drawn in that tab's banner (`TerminalEgressBanner`); this card draws it only when no view of the tab is mounted, and then offers This tab in place of This session, as the host does. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import { terminalTabLabel } from "../../preview/terminal-tab-labels.js";
import { canonicalStringify } from "../../../../shared/canonical-json.js";
import { resolveUserApprovalVerdict } from "../../../../shared/permissions-events.js";
import { ApprovalDecisionBar, decisionSlotsDisabled, useApprovalDecisionState } from "./ApprovalDecisionBar.js";
import { networkAnswer, networkDecisionModel, ruleSaveErrorText, type ApprovalCardChoice } from "./approval-decision.js";

type Decide = (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => void;

/** Answers a network ask from the decision row: saves the host rule a choice carries (through the same host-checked record as every card rule), then answers the gate. A refused save leaves the request pending and says why. */
function useNetworkAnswer(request: ApprovalRequest, decide: Decide): {
  readonly answer: (choice: ApprovalCardChoice, editedRule?: string) => void;
  readonly recording: boolean;
  readonly error: string | null;
} {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef(request.id);
  const recordingRef = useRef(false);
  activeRequestId.current = request.id;
  useEffect(() => {
    setError(null);
    setRecording(false);
    recordingRef.current = false;
  }, [request.id]);
  const answer = useCallback((choice: ApprovalCardChoice, editedRule?: string) => {
    const payload = request.egressHost;
    if (payload === undefined || recordingRef.current) return;
    const plan = networkAnswer(payload, choice, editedRule);
    const respond = () => {
      if (activeRequestId.current !== request.id) return;
      if (plan.egressScope === undefined) decide(plan.choice);
      else decide(plan.choice, undefined, { egressScope: plan.egressScope });
    };
    const rule = plan.rule;
    if (rule === undefined) {
      respond();
      return;
    }
    const failure = t("toolApprovalDialog.ruleDecisionSaveFailed");
    recordingRef.current = true;
    setRecording(true);
    setError(null);
    void (async () => {
      try {
        const result = await window.ave?.userApproval?.record({
          requestId: request.id,
          toolName: request.toolName,
          args: canonicalStringify(request.args ?? {}),
          source: request.source ?? "builtin",
          decision: rule.action,
          scope: rule.scope === "session" ? "session" : "persistent",
          rule,
          verdictAtApproval: resolveUserApprovalVerdict(request),
          nlJustification: null,
          trustOrigin: request.trustOrigin,
          approvalCacheKey: request.approvalCacheKey,
        });
        if (!result?.ok) {
          if (activeRequestId.current === request.id) setError(ruleSaveErrorText(result, failure));
          return;
        }
        respond();
      } catch {
        if (activeRequestId.current === request.id) setError(failure);
      } finally {
        recordingRef.current = false;
        if (activeRequestId.current === request.id) setRecording(false);
      }
    })();
  }, [request, decide, t]);
  return { answer, recording, error };
}

/** The shared decision row for a network ask, with its save error under it. */
export function NetworkDecisionRow({
  request,
  locked,
  decide,
  compact = false,
}: {
  request: ApprovalRequest;
  locked: boolean;
  decide: Decide;
  compact?: boolean;
}): ReactElement | null {
  const payload = request.egressHost;
  const { answer, recording, error } = useNetworkAnswer(request, decide);
  const state = useApprovalDecisionState(request.id);
  if (payload === undefined) return null;
  const model = networkDecisionModel(payload, request.sessionId);
  const disabled = decisionSlotsDisabled(model, state, { locked: locked || recording });
  return (
    <div className="min-w-0 space-y-1">
      <ApprovalDecisionBar model={model} state={state} disabled={disabled} onCommit={answer} compact={compact} />
      {error ? (
        <p className="text-[11px] text-destructive" role="alert" data-testid="egress-approval-save-error">{error}</p>
      ) : null}
    </div>
  );
}

/** `host:port`, an IPv6 host bracketed. */
export function egressTargetLabel(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

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
    // A request of this kind always carries its payload; one that does not can only be denied.
    return (
      <div className="space-y-2 p-3 text-xs" data-testid="egress-approval-card" role="alert">
        <p className="text-destructive">{t("egressApprovalCard.invalid")}</p>
        <Button size="sm" variant="outline" disabled={interactionLocked} onClick={() => onDecide("deny-once")}>
          {t("egressApprovalCard.denyOnce")}
        </Button>
      </div>
    );
  }
  const target = egressTargetLabel(payload.host, payload.port);
  const terminalTabId = payload.terminalTabId;
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
          {terminalTabId === undefined ? t("egressApprovalCard.body", { tool }) : t("egressApprovalCard.terminalBody")}
        </p>
        <code className="block min-w-0 break-all font-mono text-xs font-semibold" data-testid="egress-approval-target">
          {target}
        </code>
        {payload.network === "local" ? (
          <p role="note" className="min-w-0 break-words text-xs font-medium text-warning" data-testid="egress-approval-local-warning">
            {t(terminalTabId === undefined ? "egressApprovalCard.localWarning" : "egressApprovalCard.localWarningTab")}
          </p>
        ) : null}
        {payload.network === "unverified" ? (
          <p role="note" className="min-w-0 break-words text-xs font-medium text-warning" data-testid="egress-approval-unverified-warning">
            {t(terminalTabId === undefined ? "egressApprovalCard.unverifiedWarning" : "egressApprovalCard.unverifiedWarningTab")}
          </p>
        ) : null}
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {terminalTabId === undefined
            ? t("egressApprovalCard.conversation", { conversation: conversationLabel })
            : t("egressApprovalCard.terminalTab", { tab: terminalTabLabel(terminalTabId) ?? t("egressApprovalCard.terminalTabElsewhere") })}
        </p>
      </div>
      <NetworkDecisionRow request={request} locked={interactionLocked} decide={onDecide} />
      {payload.scopes.includes("project") || payload.scopes.includes("always") ? (
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {t(terminalTabId === undefined ? "egressApprovalCard.revokeHint" : "egressApprovalCard.revokeHintTerminal")}
        </p>
      ) : null}
    </section>
  );
}

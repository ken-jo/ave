/** The approval dock card for an `extension-start` ask: every extension start waiting in this conversation that nothing confines.
 * Each start has its own yes or no; nothing is answered until every start has one. */
import { useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { revealHiddenCharacters } from "../../../../shared/display-safe-text.js";
import {
  extensionStartApprovalRows, type ExtensionStartApprovalRow, type ExtensionStartChoice,
} from "../../../../shared/permissions-events.js";
import type { ApprovalDecisionExtras } from "../../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../../types.js";

const KIND_KEYS: Readonly<Record<ExtensionStartApprovalRow["kind"], string>> = {
  "plugin-child": "extensionStartCard.kindPluginChild",
  "mcp-stdio": "extensionStartCard.kindMcpStdio",
  worker: "extensionStartCard.kindWorker",
  "plugin-hook": "extensionStartCard.kindPluginHook",
};

const CAUSE_KEYS: Readonly<Record<ExtensionStartApprovalRow["cause"], string>> = {
  "no-backend": "extensionStartCard.causeNoBackend",
  "home-privacy-unverified": "extensionStartCard.causeHomePrivacy",
};

export function ExtensionStartApprovalCard({ request, conversationLabel, interactionLocked = false, onDecide }: {
  request: ApprovalRequest;
  conversationLabel: string;
  interactionLocked?: boolean;
  onDecide: (choice: ApprovalChoice, pattern?: string, extras?: ApprovalDecisionExtras) => void;
}) {
  const { t } = useTranslation();
  const rows = extensionStartApprovalRows(request.args);
  const answered = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const [choices, setChoices] = useState<Readonly<Record<string, ExtensionStartChoice>>>({});
  const locked = interactionLocked || submitted;
  const send = (choice: ApprovalChoice, extras?: ApprovalDecisionExtras) => {
    if (answered.current || interactionLocked) return;
    answered.current = true;
    setSubmitted(true);
    if (extras === undefined) onDecide(choice);
    else onDecide(choice, undefined, extras);
  };
  // Dismissing the card starts nothing: the host reads a deny with no per-start answers as a no for every start.
  const dismiss = () => send("deny-once");
  const complete = rows?.every((row) => choices[row.id] !== undefined) === true;
  const confirm = () => {
    if (rows === undefined || !complete) return;
    // Only the rows this card listed are answered, each with what was picked for it.
    const answers: Record<string, ExtensionStartChoice> = {};
    for (const row of rows) {
      const choice = choices[row.id];
      if (choice === undefined) return;
      answers[row.id] = choice;
    }
    send(Object.values(answers).includes("yes") ? "allow-once" : "deny-once", { extensionStartChoices: answers });
  };
  return (
    <section role="dialog" tabIndex={-1} aria-label={t("extensionStartCard.title")} data-testid="tool-approval-panel"
      data-approval-request-id={request.id} data-approval-tool-name={request.toolName} className="flex min-h-0 flex-col gap-3 overflow-auto p-3"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } }}>
      <div data-testid="extension-start-approval-card" className="contents">
        <p className="break-words text-xs text-muted-foreground" data-testid="approval-conversation">{conversationLabel}</p>
        <h3 className="text-sm font-semibold">{t("extensionStartCard.title")}</h3>
        {rows === undefined ? (
          // A request of this kind always lists its starts; one that does not can only be refused.
          <p className="text-xs text-destructive" role="alert">{t("extensionStartCard.invalid")}</p>
        ) : (
          <>
            <p className="min-w-0 break-words text-xs text-muted-foreground">{t("extensionStartCard.body")}</p>
            <ul className="flex min-w-0 flex-col gap-2" data-testid="extension-start-rows">
              {rows.map((row) => {
                const label = revealHiddenCharacters(row.label, { lineBreaks: true });
                return (
                  <li key={row.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
                    data-testid="extension-start-row" data-extension-start-kind={row.kind} data-extension-start-choice={choices[row.id] ?? "none"}>
                    <div className="min-w-0 space-y-0.5">
                      <p className="min-w-0 break-all font-mono text-xs font-semibold" data-testid="extension-start-label">{label}</p>
                      <p className="min-w-0 break-words text-xs text-muted-foreground">{t(KIND_KEYS[row.kind])} · {t(CAUSE_KEYS[row.cause])}</p>
                    </div>
                    <fieldset className="m-0 flex min-w-0 shrink-0 gap-2 border-0 p-0">
                      <legend className="sr-only">{label}</legend>
                      <Button size="sm" variant={choices[row.id] === "yes" ? "default" : "outline"} aria-pressed={choices[row.id] === "yes"} disabled={locked}
                        data-testid="extension-start-allow" onClick={() => setChoices((current) => ({ ...current, [row.id]: "yes" }))}>
                        {t("extensionStartCard.allow")}
                      </Button>
                      <Button size="sm" variant={choices[row.id] === "no" ? "default" : "outline"} aria-pressed={choices[row.id] === "no"} disabled={locked}
                        data-testid="extension-start-deny" onClick={() => setChoices((current) => ({ ...current, [row.id]: "no" }))}>
                        {t("extensionStartCard.deny")}
                      </Button>
                    </fieldset>
                  </li>
                );
              })}
            </ul>
            {complete ? null : <p className="text-xs text-muted-foreground" role="note" data-testid="extension-start-incomplete">{t("extensionStartCard.incomplete")}</p>}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {rows === undefined ? null : (
            <Button disabled={locked || !complete} data-testid="extension-start-confirm" onClick={confirm}>{t("extensionStartCard.confirm")}</Button>
          )}
          <Button disabled={locked} variant="outline" data-testid="extension-start-deny-all" onClick={dismiss}>{t("extensionStartCard.denyAll")}</Button>
        </div>
      </div>
    </section>
  );
}

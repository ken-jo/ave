/**
 * Every refusal, warning and failure of the marketplace in one of three tones
 * (design §18.8):
 *   - policy: a lock and "Set by your organization", the rule and where it
 *     lives (in the sentence), and no way to continue;
 *   - warning: amber, the risk, *Continue* and *Cancel*;
 *   - error: red, what happened and what to do.
 * The sentence comes from `failureText`; main's English message is reachable
 * only through *Copy details*, scrubbed of credentials first: a refused
 * address or a git error can carry a password, a token or a credential
 * helper's answer.
 */
import { AlertCircle, AlertTriangle, Lock } from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import { scrubDiagnosticSecrets } from "../../../../shared/dlp.js";
import type { GitMarketplaceErrorCode, GitMarketplaceFailure } from "../../../../shared/git-marketplace.js";
import { failureCommand, failureText, type FailureSubject } from "./labels.js";

/** Codes the organization decided: shown as policy, never as the user's mistake. */
const POLICY_CODES: ReadonlySet<GitMarketplaceErrorCode> = new Set(["SOURCE_POLICY_BLOCKED", "PACKAGE_POLICY_BLOCKED", "PACKAGE_REQUIRED_BY_POLICY"]);

export type MarketplaceProblemProps =
  | {
      tone?: undefined;
      failure: GitMarketplaceFailure;
      /** What the failure is about, so the sentence offers only actions the user has there (`failureText`). */
      subject: FailureSubject;
      /** What *Copy details* copies instead of the code and main's message. */
      details?: string;
      className?: string;
      testId?: string;
    }
  | {
      /** A failure outside the marketplace's codes (a settings write, an import), with its own sentence. */
      tone: "error";
      text: string;
      /** The raw text behind *Copy details*. */
      details: string;
      className?: string;
      testId?: string;
    }
  | {
      tone: "warning";
      /** The risk, as a full sentence. */
      text: string;
      onContinue: () => void;
      onCancel: () => void;
      className?: string;
      testId?: string;
    };

function failureDetails(failure: GitMarketplaceFailure): string {
  const reason = failure.detail ? ` · ${failure.detail.reason}` : "";
  return `${failure.code}${reason}\n${failure.message}`;
}

export function MarketplaceProblem(props: MarketplaceProblemProps) {
  const { t } = useTranslation();

  if (props.tone === "warning") {
    return (
      <div
        role="alert"
        className={cn("space-y-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-sm text-warning", props.className)}
        data-testid={props.testId}
        data-tone="warning"
      >
        <p className="flex gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{props.text}</span>
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={props.onCancel}>{t("common.cancel")}</Button>
          <Button size="sm" onClick={props.onContinue}>{t("gitMarketplace.action.continue")}</Button>
        </div>
      </div>
    );
  }

  const failure = props.tone === "error" ? null : props.failure;
  const policy = failure !== null && POLICY_CODES.has(failure.code);
  const command = failure === null ? null : failureCommand(failure);
  const text = props.tone === "error" ? props.text : failureText(t, props.failure, props.subject);
  const details = scrubDiagnosticSecrets(props.tone === "error" ? props.details : (props.details ?? failureDetails(props.failure)));
  return (
    <div
      role="alert"
      className={cn(
        "space-y-2 rounded-md border px-3 py-2 text-sm",
        policy ? "border-border bg-muted/(--opacity-light) text-foreground" : "border-destructive/(--opacity-medium) bg-destructive/(--opacity-soft) text-destructive",
        props.className,
      )}
      data-testid={props.testId}
      data-tone={policy ? "policy" : "error"}
    >
      {policy && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Lock className="size-3.5" aria-hidden="true" />
          {t("gitMarketplace.policy.setByOrganization")}
        </p>
      )}
      <p className="flex gap-2">
        {!policy && <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
        <span className="break-words">{text}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {command !== null && (
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(command)}>
            {t("gitMarketplace.action.copyCommand")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(details)}>
          {t("gitMarketplace.action.copyDetails")}
        </Button>
      </div>
    </div>
  );
}

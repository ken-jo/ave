import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  isSessionOnlyApprovalMemoryScope,
  resolveUserApprovalVerdict,
  type ApprovalRuleSave,
  type UserApprovalScope,
  type UserApprovalVerdict,
} from "../../../shared/permissions-events.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { ChevronDown } from "lucide-react";
import { buildApprovalScopeOptions } from "../../../permissions/approval-scope-options.js";
import { SOURCE_BADGE } from "../constants.js";
import type { ApprovalDecisionExtras } from "../hooks/use-approval.js";
import { EgressHostApprovalCard } from "./permissions/EgressHostApprovalCard.js";
import { UserOwnedSurfaceApprovalCard } from "./permissions/UserOwnedSurfaceApprovalCard.js";
import type { ReviewerSuggestion } from "../hooks/use-permission-signals.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";
import type {
  ParentEscalationCause,
  ParentEscalationNotice,
} from "../../../shared/parent-escalation-notice.js";
import { canonicalStringify as canonicalStringifyForRenderer } from "../../../shared/canonical-json.js";
import {
  parseRationaleApprovalDisplay,
  type RationaleApprovalDisplay,
} from "../../../shared/rationale-approval-display.js";
import { isNonUserTrustOrigin, trustOriginLabel } from "../utils/trust-origin-label.js";
import { getActiveSurface } from "../preview/active-surface.js";
import {
  ReviewRow,
  categoryLabel,
  levelBadgeClass,
  pickSummary,
  reviewBoxClass,
  reviewTitleForCategory,
  riskLevelKoLabel,
  sensitivityLabel,
  type ParsedSummary,
  type ReviewBasisRow,
} from "./permissions/PermissionDecisionCard.js";
import {
  formatEvaluationLimits,
  PermissionEvaluationContextPanel,
} from "./permissions/PermissionEvaluationContextPanel.js";
import { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";
import {
  parseElicitationSchema,
  type ElicitationEnumValue,
  type ElicitationFieldKind as ElicitationSchemaFieldKind,
} from "../../../shared/mcp-elicitation-schema.js";
import { isRecord } from "../../../shared/is-record.js";
import { approvalActionSummary } from "../../../shared/approval-action-summary.js";
import { TEST_IDS } from "../../../shared/test-ids.js";
import type { RiskLevel, ToolCategory } from "../../../shared/permission-review-status.js";
import { shellExecutionEnvironmentLines } from "../../../shared/shell-execution-environment.js";
import { terminalCommandLookalikes } from "../../../shared/terminal-command-lookalikes.js";
import { ApprovalDecisionBar, decisionSlotsDisabled, useApprovalDecisionState } from "./permissions/ApprovalDecisionBar.js";
import {
  allowRefusalKey,
  exactDecisionModel,
  oneShotDecisionModel,
  FOLDER_ALLOW_LABEL_KEY,
  pathGrantDecisionModel,
  ruleSaveErrorText,
  ruleSaveFor,
  shellDecisionModel,
  type ApprovalCardChoice,
} from "./permissions/approval-decision.js";

type ElicitationFieldKind = ElicitationSchemaFieldKind;
type ElicitationFormValue = string | boolean;

type ElicitationEnumOption = {
  key: string;
  label: string;
  value: unknown;
};

type ElicitationField = {
  name: string;
  label: string;
  description?: string;
  kind: ElicitationFieldKind;
  required: boolean;
  defaultValue?: unknown;
  enumOptions?: ElicitationEnumOption[];
};

type ElicitationSchemaParseResult =
  | { supported: true; fields: ElicitationField[] }
  | { supported: false; fields: [] };

const INTEGER_INPUT_RE = /^[+-]?\d+$/;
/** Shown for an enum member whose natural label would be blank (the empty string). The member is still offered; dropping it, or
 * rejecting the whole schema over it, would leave the user unable to answer a request the resolver considers perfectly valid. */
const EMPTY_ENUM_OPTION_LABEL = '""';

const UNSUPPORTED_ELICITATION_SCHEMA: ElicitationSchemaParseResult = { supported: false, fields: [] };

function isBoilerplateApprovalReason(value: string): boolean {
  const normalized = value.trim();
  return /^user confirmation required(?:\s*\([^)]*\))?[.!]?$/i.test(normalized)
    || /^approval required(?:\s*\([^)]*\))?[.!]?$/i.test(normalized)
    || /^상태 변경 도구\s*\([^)]*\)$/.test(normalized)
    || /\(\s*(?:category|trust)\s*:[^)]+\)\s*$/i.test(normalized);
}

function enumOptionLabel(value: ElicitationEnumValue): string {
  const label = value === null ? "null" : String(value);
  return label.length > 0 ? label : EMPTY_ENUM_OPTION_LABEL;
}

function buildEnumOptions(values: readonly ElicitationEnumValue[]): ElicitationEnumOption[] {
  return values.map((value, index) => ({
    key: String(index),
    label: enumOptionLabel(value),
    value,
  }));
}

/**
 * Adapt the shared parse result into display fields. Support is decided by
 * {@link parseElicitationSchema} alone; this must not add rejections of its own,
 * or the approval surface can once again refuse a schema the resolver accepts.
 */
function parseElicitationFields(args: unknown): ElicitationSchemaParseResult {
  if (!isRecord(args)) return UNSUPPORTED_ELICITATION_SCHEMA;
  const parsed = parseElicitationSchema(args.requestedSchema);
  if (!parsed) return UNSUPPORTED_ELICITATION_SCHEMA;
  return {
    supported: true,
    fields: parsed.fields.map((field) => ({
      name: field.name,
      label: field.title ?? field.name,
      ...(field.description ? { description: field.description } : {}),
      kind: field.kind,
      required: field.required,
      defaultValue: field.defaultValue,
      ...(field.enumValues ? { enumOptions: buildEnumOptions(field.enumValues) } : {}),
    })),
  };
}

function initialElicitationValues(fields: readonly ElicitationField[]): Record<string, ElicitationFormValue> {
  const values: Record<string, ElicitationFormValue> = {};
  for (const field of fields) {
    if (field.enumOptions) {
      const defaultIndex = field.enumOptions.findIndex((option) => option.value === field.defaultValue);
      values[field.name] = defaultIndex >= 0 ? String(defaultIndex) : "";
    } else if (field.kind === "boolean") {
      values[field.name] = typeof field.defaultValue === "boolean" ? field.defaultValue : false;
    } else if (typeof field.defaultValue === "string" || typeof field.defaultValue === "number") {
      values[field.name] = String(field.defaultValue);
    } else {
      values[field.name] = "";
    }
  }
  return values;
}

function isNumericFieldInvalid(field: ElicitationField, value: ElicitationFormValue | undefined): boolean {
  if (field.kind !== "number" && field.kind !== "integer") return false;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const trimmed = value.trim();
  if (field.kind === "integer" && !INTEGER_INPUT_RE.test(trimmed)) return true;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return true;
  return field.kind === "integer" && !Number.isInteger(parsed);
}

function isRequiredElicitationValueMissing(
  field: ElicitationField,
  value: ElicitationFormValue | undefined,
): boolean {
  if (!field.required) return false;
  if (field.kind === "boolean") return typeof value !== "boolean";
  return typeof value !== "string" || value.trim().length === 0;
}

function isElicitationFormInvalid(
  fields: readonly ElicitationField[],
  values: Record<string, ElicitationFormValue>,
): boolean {
  return fields.some((field) =>
    isRequiredElicitationValueMissing(field, values[field.name]) ||
    isNumericFieldInvalid(field, values[field.name]),
  );
}

function buildElicitationContent(
  fields: readonly ElicitationField[],
  values: Record<string, ElicitationFormValue>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (field.enumOptions) {
      const option = typeof raw === "string"
        ? field.enumOptions.find((candidate) => candidate.key === raw)
        : undefined;
      if (option) content[field.name] = option.value;
      continue;
    }
    if (field.kind === "boolean") {
      if (typeof raw === "boolean") content[field.name] = raw;
      continue;
    }
    if (typeof raw !== "string" || raw.trim().length === 0) {
      if (field.required) content[field.name] = "";
      continue;
    }
    const trimmed = raw.trim();
    if (field.kind === "integer") {
      content[field.name] = Number(trimmed);
    } else if (field.kind === "number") {
      content[field.name] = Number(trimmed);
    } else {
      content[field.name] = raw;
    }
  }
  return content;
}

function isMcpElicitationRequest(request: ApprovalRequest | null): boolean {
  return Boolean(
    request &&
      request.source === "mcp" &&
      request.kind === "agent-action" &&
      request.toolName.startsWith("mcp:") &&
      request.toolName.endsWith(":elicitation"),
  );
}

function hasRequestedElicitationSchema(request: ApprovalRequest | null): boolean {
  const args = request?.args;
  return isRecord(args) && args.requestedSchema !== undefined;
}

const RATIONALE_INVALID_APPROVAL_MESSAGE =
  "Rationale details could not be verified. Approval is unavailable; you can deny this request.";
const RATIONALE_FAILED_EXPLANATION_MESSAGE =
  "The model explanation is unavailable. Review the host-sealed action before deciding.";

function rationaleScopeAlignmentLabel(
  alignment: RationaleApprovalDisplay["scopeAlignment"],
): string {
  switch (alignment) {
    case "aligned":
      return "Aligned with the current request";
    case "unclear":
      return "Needs a closer scope review";
    case "outside":
      return "Outside the current request";
    case "unknown":
      return "Unavailable";
  }
}

function RationaleTextList({
  values,
  testId,
}: {
  values: readonly string[];
  testId: string;
}) {
  return (
    <ul className="space-y-1" data-testid={testId}>
      {values.map((value, index) => (
        <li key={`${index}:${value}`} className="break-words">
          {value}
        </li>
      ))}
    </ul>
  );
}

/** Rationale approvals expose only the narrow, HMAC-bound display contract. Never reuse the normal request/args review
 * path here: its payload can carry audit-only identifiers and model-provided text that do not belong in the decision card. */
function RationaleApprovalCard({
  display,
}: {
  display: RationaleApprovalDisplay | null;
}) {
  if (display === null) {
    return (
      <div
        className="rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-faint) p-3 text-xs text-destructive"
        data-testid="rationale-approval-invalid"
        id="rationale-approval-invalid"
        role="alert"
      >
        {RATIONALE_INVALID_APPROVAL_MESSAGE}
      </div>
    );
  }

  return (
    <section
      className="min-w-0 overflow-hidden rounded-md border"
      data-testid="rationale-approval-card"
    >
      <h4 className="flex min-w-0 flex-wrap items-start justify-between gap-2 border-b px-3 py-2 text-xs font-semibold">
        <span className="shrink-0">Host-sealed action</span>
        <code
          className="min-w-0 max-w-full break-all text-right font-mono"
          data-testid="rationale-approval-tool"
        >
          {display.toolName}
        </code>
      </h4>
      <div className="divide-y">
        <ReviewRow label={t("toolApprovalDialog.rowTarget")}>
          <RationaleTextList
            testId="rationale-approval-targets"
            values={display.canonicalTargets}
          />
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowChange")}>
          <RationaleTextList
            testId="rationale-approval-effects"
            values={display.requestedEffects}
          />
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowSideEffects")}>
          <RationaleTextList
            testId="rationale-approval-resources"
            values={display.affectedResources}
          />
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowAuthScope")}>
          <span data-testid="rationale-approval-authority">
            {display.requiredAuthority}
          </span>
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowVerdict")}>
          <span data-testid="rationale-approval-verdict">
            {riskLevelKoLabel(display.effectiveVerdict.level)} · {display.effectiveVerdict.reason}
          </span>
        </ReviewRow>
        <ReviewRow label={t("toolApprovalDialog.rowScope")}>
          <div className="space-y-1" data-testid="rationale-approval-scope">
            <p>{rationaleScopeAlignmentLabel(display.scopeAlignment)}</p>
            <RationaleTextList
              testId="rationale-approval-scope-reasons"
              values={display.scopeReasons}
            />
          </div>
        </ReviewRow>
      </div>

      {/* The model's explanation is visibly separate from host-sealed facts.
          It is rendered as a React text node, never as markup or input. */}
      <div
        className="border-t bg-muted/(--opacity-light) px-3 py-2"
        data-testid="rationale-model-explanation"
      >
        <p className="text-xs font-semibold">Model suggestion</p>
        {display.rationaleStatus === "ready" ? (
          <p className="mt-1 text-xs" data-testid="rationale-model-suggestion">
            {display.suggestion}
          </p>
        ) : (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="rationale-model-fallback"
            role="status"
          >
            {RATIONALE_FAILED_EXPLANATION_MESSAGE}
          </p>
        )}
      </div>
    </section>
  );
}

/** Display the shared child-escalation cause without deriving a permission decision in the renderer. */
const PARENT_ESCALATION_CAUSE_KEY: Record<ParentEscalationCause, string> = {
  "parent-escalated": "toolApprovalDialog.parentEscalationCauseParentEscalated",
  timeout: "toolApprovalDialog.parentEscalationCauseTimeout",
  "malformed-output": "toolApprovalDialog.parentEscalationCauseMalformedOutput",
  "rate-limited": "toolApprovalDialog.parentEscalationCauseRateLimited",
  "adjudicator-unavailable":
    "toolApprovalDialog.parentEscalationCauseAdjudicatorUnavailable",
  "llm-error": "toolApprovalDialog.parentEscalationCauseLlmError",
  "turn-aborted": "toolApprovalDialog.parentEscalationCauseTurnAborted",
  "repeated-denial": "toolApprovalDialog.parentEscalationCauseRepeatedDenial",
};

/** Tells the user that a stage they never saw already ran on this ask, and how it ended. Reading order is the trust order: the host-owned cause first, then the two pieces of text a model wrote; the child's title and the parent's sentence; both quoted and attributed, because model
 * text rendered as dock prose reads like an instruction from the app rather than a quote from a party to the request. The reason arrives already bounded by the adjudicator that parsed it; cutting it again here would silently drop the end of a sentence whose point is usually at the end. */
function ParentEscalationBand({ notice }: { notice: ParentEscalationNotice }) {
  const { t: tBand } = useTranslation();
  const reason = notice.reason.trim();
  const causeKey: string | undefined = PARENT_ESCALATION_CAUSE_KEY[notice.cause];
  return (
    <div
      className="min-w-0 rounded-md border border-info/(--opacity-medium) bg-info/(--opacity-faint) px-3 py-2"
      data-testid="parent-escalation-band"
      data-parent-escalation-cause={notice.cause}
    >
      <p className="text-xs font-semibold text-info">
        {tBand("toolApprovalDialog.parentEscalationTitle")}
      </p>
      <p
        className="mt-0.5 break-words text-[11px] leading-relaxed"
        data-testid="parent-escalation-cause"
      >
        {/* A cause this build has no sentence for says so, rather than
            rendering an empty line: the band's whole job is to account for a
            stage the user did not see, and a blank account is worse than an
            unfamiliar one. */}
        {causeKey
          ? tBand(causeKey)
          : tBand("toolApprovalDialog.parentEscalationCauseUnrecognized")}
      </p>
      <p
        className="mt-0.5 break-words text-[10px] text-muted-foreground"
        data-testid="parent-escalation-child"
      >
        <span className="font-medium">
          {tBand("toolApprovalDialog.parentEscalationChildLabel")}
        </span>{" "}
        {/* The title came from the parent's own spawn arguments, so it is
            quoted for the same reason the parent's sentence below is: a
            model's words must not wear the app's voice on the one surface
            where the user decides whether to trust them. */}
        <q>{notice.childTitle}</q>
      </p>
      {reason ? (
        <p
          className="mt-1 break-words text-[10px] text-muted-foreground"
          data-testid="parent-escalation-reason"
        >
          <span className="font-medium">
            {tBand("toolApprovalDialog.parentEscalationReasonLabel")}
          </span>{" "}
          <q className="italic">{reason}</q>
        </p>
      ) : null}
    </div>
  );
}

/** Offers to hand the reviewing over to the LLM reviewer, at the moment the user is answering yet another ask by hand. The suggestion is about the run of approvals the user just made, not about this one request, so it is deliberately
 * quieter than every other band here: it must never read as part of what is being asked. Enabling is one gesture and the failure of that gesture stays inside the band, because the decision the card exists for has to remain answerable either way. */
function ReviewerSuggestionBand({ suggestion }: { suggestion: ReviewerSuggestion }) {
  const { t: tBand } = useTranslation();
  return (
    <div
      className="flex min-w-0 items-start gap-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-faint) px-3 py-2"
      data-testid="reviewer-suggestion-band"
      data-reviewer-suggestion-reason={suggestion.reason}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-warning">
          {tBand("chatView.permissionReviewSuggestionTitle")}
        </p>
        <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
          {suggestion.reason === "allow-always"
            ? tBand("chatView.permissionReviewSuggestionAllowAlways")
            : tBand("chatView.permissionReviewSuggestionRepeat", {
                count: suggestion.allowCount,
                minutes: Math.max(1, Math.round(suggestion.windowMs / 60000)),
              })}
        </p>
        {suggestion.error ? (
          <p
            className="mt-0.5 break-words text-[10px] text-destructive"
            data-testid="reviewer-suggestion-error"
          >
            {suggestion.error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={suggestion.busy}
          data-testid="reviewer-suggestion-enable"
          onClick={suggestion.onEnable}
        >
          {suggestion.busy
            ? tBand("chatView.permissionReviewSuggestionBusy")
            : tBand("chatView.permissionReviewSuggestionAction")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          data-testid="reviewer-suggestion-dismiss"
          onClick={suggestion.onDismiss}
        >
          {tBand("chatView.permissionReviewSuggestionDismiss")}
        </Button>
      </div>
    </div>
  );
}


/** What "remember" on this card will actually cover. Read only from the host-derived `approvalMemory` on the
 * request; never inferred from args; so the copy cannot promise a narrower scope than the store will apply. */
function rememberScopeText(
  t: (key: string, params?: Record<string, string>) => string,
  request: Pick<ApprovalRequest, "toolName" | "source" | "approvalMemory">,
  path: string,
): string {
  const memory = request.approvalMemory;
  if (memory?.kind !== "key") return t("toolApprovalDialog.exactPersistentScope", { path });
  const toolName = request.toolName;
  const pathToolName = memory.scope.kind === "path" && request.source === "builtin"
    && memory.key.startsWith("file-write-path:")
    && ["write_file", "edit_file", "multi_edit", "apply_patch"].includes(toolName)
    ? "write_file, edit_file, multi_edit, apply_patch"
    : toolName;
  switch (memory.scope.kind) {
    case "mcp-tool":
      return t("toolApprovalDialog.rememberScopeMcpTool", { serverId: memory.scope.serverId, toolName: memory.scope.toolName, path });
    case "origin":
      return t("toolApprovalDialog.rememberScopeOrigin", { toolName, origin: memory.scope.origin, path });
    case "path":
      return t("toolApprovalDialog.rememberScopePath", { toolName: pathToolName, target: memory.scope.path, path });
    case "paths":
      return t("toolApprovalDialog.rememberScopePath", { toolName, target: memory.scope.paths.map((target) => JSON.stringify(target)).join(", "), path });
    case "transfer":
      return t(
        memory.scope.overwrite
          ? "toolApprovalDialog.rememberScopeTransferOverwrite"
          : "toolApprovalDialog.rememberScopeTransfer",
        { toolName, source: memory.scope.sourcePath, destination: memory.scope.destinationPath, path },
      );
    case "command":
      return t("toolApprovalDialog.rememberScopeCommand", { path });
    case "browser-origin":
      return t(
        memory.scope.tabOpener === "agent"
          ? "toolApprovalDialog.rememberScopeBrowserAgentOrigin"
          : "toolApprovalDialog.rememberScopeBrowserUserOrigin",
        { toolName, origin: memory.scope.origin },
      );
    case "browser-agent-tabs":
      return t("toolApprovalDialog.rememberScopeBrowserAgentTabs", { toolName });
    case "terminal-command":
      return t("toolApprovalDialog.rememberScopeTerminalCommand", { cwd: memory.scope.cwd });
  }
}

/** The exact command a `terminal_run` card types (as the card's input row shows it), the terminal it types into and the directory its shell is in; the last two
 * sealed by the host before the card was shown. Named the way the terminal's tab is labelled when it is the window's active terminal (the usual target), else by its id. */
function terminalTargetText(
  t: (key: string, params?: Record<string, string>) => string,
  request: Pick<ApprovalRequest, "approvalMemory" | "args">,
): string | null {
  const memory = request.approvalMemory;
  if (memory?.kind !== "key" || memory.scope.kind !== "terminal-command") return null;
  const command = parseArgs(request.args)?.command;
  if (typeof command !== "string") return null;
  const active = getActiveSurface();
  const terminal = active?.kind === "terminal" && active.tabId === memory.scope.tabId ? active.label : memory.scope.tabId;
  return memory.scope.lane === "manual"
    ? t("toolApprovalDialog.hostTerminalTarget", { command, terminal, shell: memory.scope.shell, cwd: memory.scope.physicalCwd })
    : t("toolApprovalDialog.terminalTarget", { command, terminal, cwd: memory.scope.cwd });
}

/** Facts about a `terminal_run` command a reader could miss in its text: each character that could pass for another, by code point (a look-alike reads as the letter it imitates; words in one
 * script, such as Korean filenames, are not listed; see terminalCommandLookalikes), and a terminal directory outside the allowed folders (the command still runs there, inside the terminal's sandbox). */
function terminalCommandNotes(
  t: (key: string, params?: Record<string, string>) => string,
  request: Pick<ApprovalRequest, "approvalMemory" | "args" | "evaluationContext" | "shellRule" | "hostTerminalAfterExternalContent">,
): string[] {
  const notes: string[] = [];
  if (request.hostTerminalAfterExternalContent === true) notes.push(t("toolApprovalDialog.hostTerminalAfterExternalContent"));
  const memory = request.approvalMemory;
  if (memory?.kind !== "key" || memory.scope.kind !== "terminal-command") return notes;
  // The user's own shell: no sandbox, and the approved command's output goes back to the model.
  if (memory.scope.lane === "manual") notes.push(t("toolApprovalDialog.hostTerminalWarning"));
  const command = parseArgs(request.args)?.command;
  if (typeof command === "string") {
    const lookalikes = terminalCommandLookalikes(command);
    if (lookalikes.length > 0) {
      const list = lookalikes
        .slice(0, 12)
        .map((ch) => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
        .join(", ");
      notes.push(t("toolApprovalDialog.terminalLookalike", { list: lookalikes.length > 12 ? `${list}, …` : list }));
    }
  }
  const context = request.evaluationContext;
  if (context) {
    // Both sides are in the allowed-directory check's form (realpath, case-folded where the file system folds case): the
    // host resolved the terminal's directory when it sealed the target, and the list is kept that way (allowed-directories.ts).
    const target = memory.scope.cwdForMatch;
    const inside = context.allowedDirectories.some((dir) => {
      const root = dir.endsWith("/") ? dir.slice(0, -1) : dir;
      return target === root || target.startsWith(`${root}/`);
    });
    if (!inside) {
      notes.push(memory.scope.lane === "manual"
        ? t("toolApprovalDialog.hostTerminalOutsideAllowed", { cwd: memory.scope.physicalCwd })
        : t("toolApprovalDialog.terminalOutsideAllowed", { cwd: memory.scope.cwd }));
    }
  }
  return notes;
}

/** Whether this card's remember button records for this app session only (browser scopes) rather than persistently. Host-derived from the request's `approvalMemory`, the same predicate the record
 * handler enforces. The page a browser call acts on, and whose tab it is. Shown on every browser card, including the one-shot cards of the user's own tabs, which have no remember line to carry it. */
function browserTargetText(
  t: (key: string, params?: Record<string, string>) => string,
  request: Pick<ApprovalRequest, "approvalMemory">,
): string | null {
  const memory = request.approvalMemory;
  if (memory?.kind !== "key" || memory.scope.kind !== "browser-origin") return null;
  return t(
    memory.scope.tabOpener === "agent" ? "toolApprovalDialog.browserTargetAgentTab" : "toolApprovalDialog.browserTargetUserTab",
    { origin: memory.scope.origin },
  );
}

function isSessionOnlyRemember(request: Pick<ApprovalRequest, "approvalMemory"> | null | undefined): boolean {
  const memory = request?.approvalMemory;
  return memory?.kind === "key" && isSessionOnlyApprovalMemoryScope(memory.scope);
}

export function ToolApprovalContent({
  open,
  request,
  conversationLabel,
  narrowLaneScroll = false,
  pendingCount = 1,
  onDecide,
  onOpenPermanentDeny,
  interactionLocked = false,
  proposedChoice = null,
  reviewerSuggestion = null,
}: {
  open: boolean;
  request: ApprovalRequest | null;
  /** What the card calls the conversation that raised it; the surface's own name for itself (a tile's title,
   * "Side chat", "no conversation"). The raw session id is kept for the review details, where an id is useful. */
  conversationLabel: string;
  /** Let a very narrow floating approval scroll as one card when its footer cannot fit. */
  narrowLaneScroll?: boolean;
  pendingCount?: number;
  onDecide: (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => void;
  onOpenPermanentDeny?: (request: ApprovalRequest, verdict: UserApprovalVerdict) => void;
  /** Settings owns the current exact-deny decision until it is saved or cancelled. */
  interactionLocked?: boolean;
  /** Approval-sentence preselection: focuses the named decision button. */
  proposedChoice?: ApprovalChoice | null;
  /** The window's held reviewer suggestion; `null` draws no band. */
  reviewerSuggestion?: ReviewerSuggestion | null;
}) {
  const { t: tHook } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [recordingDecision, setRecordingDecision] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(request?.id ?? null);
  const recordingRequestIdRef = useRef<string | null>(null);
  const decisionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [decisionIndex, setDecisionIndex] = useState(0);
  activeRequestIdRef.current = request?.id ?? null;
  const userProvidedPurpose =
    request?.approvalPurpose?.source === "conversation" &&
    request.approvalPurpose.confidence === "sufficient"
      ? request.approvalPurpose.text.trim()
      : "";
  const elicitationParse = useMemo(
    () => parseElicitationFields(request?.args),
    [request?.args],
  );
  const isRationaleApproval = request?.kind === "rationale";
  const rationaleDisplay = useMemo(
    () => isRationaleApproval
      ? parseRationaleApprovalDisplay(request?.args)
      : null,
    [isRationaleApproval, request?.args],
  );
  const rationaleDisplayInvalid = isRationaleApproval && rationaleDisplay === null;
  // Path-grant (out-of-allowed-dir) view-model; the ONE place the shared scope authority is projected for rendering. The card below stays a
  // single layout for every kind; only this data (labels, availability, the pattern the allow-always button must carry) is kind-specific.
  const isOutOfDir = request?.kind === "out-of-allowed-dir";
  const outOfDir = isOutOfDir ? request?.outOfAllowedDir : undefined;
  const outOfDirCandidatePath = outOfDir?.candidatePath ?? "";
  const outOfDirSuggestedParent = outOfDir?.suggestedParent ?? null;
  const outOfDirScopes = useMemo(() => {
    if (!isOutOfDir) return null;
    const options = buildApprovalScopeOptions({
      candidatePath: outOfDirCandidatePath,
      suggestedParent: outOfDirSuggestedParent,
      ...(request?.allowedChoices ? { allowedChoices: request.allowedChoices } : {}),
    });
    return {
      deny: options.find((scope) => scope.choice === "deny-once") ?? null,
      always: options.find((scope) => scope.choice === "allow-always") ?? null,
      once: options.find((scope) => scope.choice === "allow-once") ?? null,
    };
  }, [
    isOutOfDir,
    outOfDirCandidatePath,
    outOfDirSuggestedParent,
    request?.allowedChoices,
  ]);
  const elicitationFields = elicitationParse.fields;
  const isMcpElicitation = isMcpElicitationRequest(request);
  const hasElicitationSchema = isMcpElicitation && hasRequestedElicitationSchema(request);
  const isElicitationForm = isMcpElicitation && elicitationFields.length > 0;
  const isUnsupportedElicitationForm = hasElicitationSchema && !elicitationParse.supported;
  const [elicitationValues, setElicitationValues] = useState<Record<string, ElicitationFormValue>>({});

  // Reset the async decision lock only when the queue head itself changes. Other request-local
  // form updates must never reopen controls while the exact decision record is still in flight.
  useEffect(() => {
    recordingRequestIdRef.current = null;
    setRecordingDecision(false);
    setRecordError(null);
  }, [request?.id]);

  useEffect(() => () => {
    activeRequestIdRef.current = null;
    recordingRequestIdRef.current = null;
  }, []);

  // Reset request-local choice state when the queue head changes. Approval cards never collect typed prose; an
  // explicit user reason must already be part of the originating conversation and is projected read-only below.
  useEffect(() => {
    setElicitationValues(initialElicitationValues(elicitationFields));
  }, [request?.id, elicitationFields]);

  const finalVerdict = isRationaleApproval
    ? rationaleDisplay?.effectiveVerdict.level ?? "high"
    : resolveUserApprovalVerdict(request ?? {});
  const isAgentAction =
    request?.category === "agent-action" && request.kind === "agent-action";

  const elicitationInvalid = isElicitationFormInvalid(elicitationFields, elicitationValues);
  const elicitationContent = useMemo(
    () => buildElicitationContent(elicitationFields, elicitationValues),
    [elicitationFields, elicitationValues],
  );

  // HIGH approval is itself the explicit act. The explanatory text is a read-only, one-shot audit
  // summary from host-owned context; it is never a renderer-authored prerequisite for the decision.
  const showsHighRiskReason = finalVerdict === "high" && !isRationaleApproval && request?.userOwnedSurfaceReviewFallback !== true;
  const highRiskReasonSource = userProvidedPurpose.length > 0
    ? tHook("toolApprovalDialog.reasonFromRequest")
    : tHook("toolApprovalDialog.reasonFromPermissionAudit");
  const approveDisabled =
    rationaleDisplayInvalid ||
    isUnsupportedElicitationForm ||
    elicitationInvalid;

  // Host-constrained and sealed approvals remain per-invocation. The "Always allow" control
  // stays visible for layout/decision consistency but is disabled with an explicit explanation.
  const isHostConstrainedToOneShot =
    request?.allowedChoices !== undefined &&
    !request.allowedChoices.includes("allow-always");
  const approvalIsOneShot =
    isRationaleApproval ||
    isMcpElicitation ||
    isAgentAction ||
    isHostConstrainedToOneShot;
  // For a path grant, availability comes from the shared scope authority (buildApprovalScopeOptions): allow-always exists only when the host resolved a safe parent AND the host
  // did not narrow the choices. A browser scope is remembered until restart only; the remember button says so and records `scope: "session"` (the record handler enforces it).
  const rememberIsSessionOnly = !outOfDirScopes && isSessionOnlyRemember(request);
  const shellRule = request?.shellRule;
  // An exact tool approval is remembered only where the host allows it; the host checks again from its own snapshot.
  const exactAllowRefusal = request?.persistentAllowAllowed === false
    ? "toolApprovalDialog.persistentUnavailableOneShot"
    : finalVerdict === "high" && request?.persistentAllowAllowed !== true
      ? "toolApprovalDialog.persistentUnavailableHighRisk"
      : null;
  // The host records no exact decision, an Always deny included, for a one-shot ask (`one-shot-not-recordable`); such a card offers none.
  const exactDenyRefusal = request?.exactRecordAllowed === false ? "toolApprovalDialog.persistentUnavailableOneShot" : null;
  const settingsEditing = onOpenPermanentDeny !== undefined;
  const hasSession = Boolean(request?.sessionId);
  // One decision row for every approval type (owner 2026-10-25, unified approval card); only this model is type-specific. A request the host
  // answers once only is one-shot whatever else it is, so that is decided before the folder card.
  const decisionModel = useMemo(() => {
    if (shellRule) return shellDecisionModel(shellRule);
    if (approvalIsOneShot) {
      return oneShotDecisionModel(finalVerdict === "high" ? "toolApprovalDialog.persistentUnavailableHighRisk" : "toolApprovalDialog.persistentUnavailableOneShot");
    }
    if (outOfDirScopes) {
      return pathGrantDecisionModel(
        outOfDirScopes.always?.path ?? null,
        outOfDirSuggestedParent ? "toolApprovalDialog.persistentUnavailableOneShot" : "toolApprovalDialog.persistentUnavailableNoParent",
        settingsEditing,
        exactDenyRefusal,
      );
    }
    return exactDecisionModel({ sessionOnly: rememberIsSessionOnly, hasSession, allowRefusalKey: exactAllowRefusal, denyRefusalKey: exactDenyRefusal, settingsEditing });
  }, [shellRule, outOfDirScopes, outOfDirSuggestedParent, settingsEditing, approvalIsOneShot, finalVerdict, rememberIsSessionOnly, hasSession, exactAllowRefusal, exactDenyRefusal]);
  const decision = useApprovalDecisionState(request?.id ?? null);
  const slotsDisabled = decisionSlotsDisabled(decisionModel, decision, {
    locked: recordingDecision || interactionLocked,
    denyUnavailable: outOfDirScopes !== null && outOfDirScopes.deny === null,
    allowUnavailable: approveDisabled,
    allowOnceUnavailable: outOfDirScopes !== null && outOfDirScopes.once === null,
  });
  const [denyDecisionDisabled, alwaysAllowDecisionDisabled, allowOnceDecisionDisabled] = slotsDisabled;
  const allowRefusal = allowRefusalKey(decisionModel);
  const persistentUnavailableReason = allowRefusal === null ? null : tHook(allowRefusal);

  // Exactly one enabled decision must remain in the tab order. Default to the fail-closed Reject
  // action so a pending Enter/Space from the covered composer can never become an accidental approval.
  useEffect(() => {
    const disabled = [
      denyDecisionDisabled,
      alwaysAllowDecisionDisabled,
      allowOnceDecisionDisabled,
    ];
    const preferredIndex = disabled.findIndex((value) => !value);
    setDecisionIndex(preferredIndex >= 0 ? preferredIndex : 0);
  }, [
    allowOnceDecisionDisabled,
    alwaysAllowDecisionDisabled,
    denyDecisionDisabled,
    request?.id,
  ]);

  // A `/allow` sentence FILLS THE FORM: it moves focus onto the decision it named (an "always" allow also selects the lasting choice in the
  // allow dropdown); the target line above rewrites with it; and nothing is decided until that button is pressed. A proposal naming a decision
  // this request does not offer is ignored rather than approximated.
  const proposedDecisionIndex = proposedChoice === "deny-once"
    ? 0
    : proposedChoice === "allow-always"
      ? 1
      : proposedChoice === "allow-once"
        ? 2
        : null;
  const selectDecision = decision.select;
  useEffect(() => {
    if (proposedChoice !== "allow-always") return;
    const lasting = decisionModel.variant === "path-grant" ? "allow-everywhere" : "allow-project";
    if (decisionModel.options[lasting].offered) selectDecision(lasting);
  }, [proposedChoice, decisionModel, selectDecision, request?.id]);
  useEffect(() => {
    if (proposedDecisionIndex === null) return;
    const disabled = [
      denyDecisionDisabled,
      alwaysAllowDecisionDisabled,
      allowOnceDecisionDisabled,
    ];
    if (disabled[proposedDecisionIndex]) return;
    setDecisionIndex(proposedDecisionIndex);
    const frame = requestAnimationFrame(() => {
      decisionButtonRefs.current[proposedDecisionIndex]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    proposedDecisionIndex,
    denyDecisionDisabled,
    alwaysAllowDecisionDisabled,
    allowOnceDecisionDisabled,
  ]);

  const moveDecisionFocus = useCallback((direction: 1 | -1) => {
    const buttons = decisionButtonRefs.current;
    const disabled = [
      denyDecisionDisabled,
      alwaysAllowDecisionDisabled,
      allowOnceDecisionDisabled,
    ];
    const focusedIndex = buttons.findIndex((button) => button === document.activeElement);
    let nextIndex = focusedIndex >= 0 ? focusedIndex : decisionIndex;

    for (let step = 0; step < buttons.length; step += 1) {
      nextIndex = (nextIndex + direction + buttons.length) % buttons.length;
      const button = buttons[nextIndex];
      if (button && !disabled[nextIndex]) {
        setDecisionIndex(nextIndex);
        button.focus();
        return;
      }
    }
  }, [
    allowOnceDecisionDisabled,
    alwaysAllowDecisionDisabled,
    decisionIndex,
    denyDecisionDisabled,
  ]);

  // Save a remembered decision before resolving the live request: a shell card saves a rule (`rule`), every other remembering card an exact
  // tool approval. The request is answered only when the save succeeded, and only while it is still the card's request.
  const recordThenRespond = useCallback(async (
    record: { readonly decision: "allow" | "deny"; readonly scope: UserApprovalScope; readonly rule?: ApprovalRuleSave } | null,
    respond: () => void,
  ) => {
    if (interactionLocked || recordingRequestIdRef.current !== null) return;
    const requestIdAtStart = request?.id ?? null;
    setRecordError(null);
    if (request && record) {
      const failureKey = record.rule ? "toolApprovalDialog.ruleDecisionSaveFailed" : "toolApprovalDialog.exactDecisionSaveFailed";
      // canonicalStringify: sort object keys so {a,b} and {b,a} produce the same string; matching how dispatchReviewer builds the lookup key.
      const canonicalArgs = canonicalStringifyForRenderer(request.args ?? {});
      recordingRequestIdRef.current = request.id;
      setRecordingDecision(true);
      try {
        const result = await window.ave?.userApproval?.record({
          requestId: request.id,
          toolName: request.toolName,
          args: canonicalArgs,
          source: request.source ?? "builtin",
          decision: record.decision,
          scope: record.scope,
          ...(record.rule === undefined ? {} : { rule: record.rule }),
          verdictAtApproval: finalVerdict as UserApprovalVerdict,
          nlJustification: null,
          trustOrigin: request.trustOrigin,
          approvalCacheKey: request.approvalCacheKey,
        });
        if (!result?.ok) {
          if (activeRequestIdRef.current === request.id) {
            setRecordError(record.rule ? ruleSaveErrorText(result, tHook(failureKey)) : tHook(failureKey));
          }
          return;
        }
      } catch {
        if (activeRequestIdRef.current === request.id) setRecordError(tHook(failureKey));
        return;
      } finally {
        if (recordingRequestIdRef.current === request.id) {
          recordingRequestIdRef.current = null;
          if (activeRequestIdRef.current === request.id) {
            setRecordingDecision(false);
          }
        }
      }
    }
    // The parent decision callback addresses the current FIFO head. An async record completion from a request that was cancelled/replaced must never resolve the next request.
    if (activeRequestIdRef.current !== requestIdAtStart) return;
    respond();
  }, [request, finalVerdict, interactionLocked, tHook]);
  const approvalExtras = useMemo<ApprovalDecisionExtras | undefined>(
    () => hasElicitationSchema && elicitationParse.supported
      ? { elicitationContent }
      : undefined,
    [hasElicitationSchema, elicitationParse.supported, elicitationContent],
  );

  // What each choice of the row means for this card's approval type. A shell card saves a `Bash(...)`/`PowerShell(...)` rule and answers once;
  // an exact tool approval is saved for the conversation or the project; a folder card allows its parent folder for good. Always deny never reaches
  // the gate's tool-wide deny-always: it is saved as a rule or an exact deny, and the request is denied once.
  const handleCardChoice = useCallback((choice: ApprovalCardChoice, editedRule?: string) => {
    if (recordingRequestIdRef.current !== null) return;
    if (choice === "deny-once") {
      onDecide("deny-once");
      return;
    }
    if (choice === "allow-once") {
      void recordThenRespond(null, () => {
        if (approvalExtras === undefined) onDecide("allow-once", undefined);
        else onDecide("allow-once", undefined, approvalExtras);
      });
      return;
    }
    if (!decisionModel.options[choice].offered) return;
    switch (decisionModel.variant) {
      case "shell": {
        const rule = ruleSaveFor(choice, editedRule);
        void recordThenRespond(
          { decision: rule.action, scope: rule.scope === "session" ? "session" : "persistent", rule },
          () => (rule.action === "deny" ? onDecide("deny-once") : onDecide("allow-once", undefined)),
        );
        return;
      }
      case "exact":
      case "path-grant": {
        if (choice === "deny-always") {
          void recordThenRespond({ decision: "deny", scope: "persistent" }, () => onDecide("deny-once"));
          return;
        }
        if (decisionModel.variant === "path-grant") {
          // The folder grant itself is the host's to save, from the parent path the scope authority resolved.
          const parent = outOfDirScopes?.always?.path;
          if (choice === "allow-everywhere" && parent !== undefined) void recordThenRespond(null, () => onDecide("allow-always", parent));
          return;
        }
        // The gate answer matches the record: a conversation approval answers allow-session (so a host-held descriptor grant lasts the
        // conversation too), a project or user-global one allow-always.
        const scope: UserApprovalScope = choice === "allow-session" ? "session" : choice === "allow-project" ? "persistent" : "global";
        void recordThenRespond({ decision: "allow", scope }, () => onDecide(scope === "session" ? "allow-session" : "allow-always", undefined));
        return;
      }
      case "one-shot":
      case "network":
        return;
    }
  }, [onDecide, recordThenRespond, approvalExtras, decisionModel, outOfDirScopes]);

  const approveDisabledDescriptionId = rationaleDisplayInvalid
    ? "rationale-approval-invalid"
    : (isUnsupportedElicitationForm || elicitationInvalid
        ? "mcp-elicitation-input-unavailable"
        : undefined);
  // Path grants keep the A/D shortcuts inert (see handlePanelKeyDown), so their buttons must not advertise them.
  const decisionShortcutsActive = !isOutOfDir;
  const approveButtonTitle = rationaleDisplayInvalid
    ? RATIONALE_INVALID_APPROVAL_MESSAGE
    : (approveDisabled
        ? tHook("toolApprovalDialog.completeRequiredChoices")
        : decisionShortcutsActive
          ? tHook("toolApprovalDialog.shortcutA")
          : undefined);


  const handlePanelKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (isTextEntryShortcutTarget(e.target)) return;
    // An open decision dropdown is portalled, but its keys still bubble here: Escape closes the menu and letters move within it; none of them decides.
    if (isMenuTarget(e.target)) return;
    const decisionNavigationTarget = e.target === e.currentTarget || (
      e.target instanceof Element &&
      e.target.closest('[data-testid="approval-decision-actions"]') !== null
    );
    if (interactionLocked || recordingRequestIdRef.current !== null) {
      if (
        e.key === "Escape" ||
        e.key.toLowerCase() === "a" ||
        e.key.toLowerCase() === "d" ||
        (decisionNavigationTarget && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (decisionNavigationTarget && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      e.stopPropagation();
      moveDecisionFocus(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!request?.requireExplicit) onDecide("deny-once");
      return;
    }
    // Path-grant requests keep their decision semantics on the buttons only: the user may have navigated to the allow-always (parent grant) scope, and the generic A shortcut
    // would silently commit a plain allow-once, discarding that selection. Before the frame unification these shortcuts never existed for this kind; keep it that way (review MAJOR).
    const isOutOfDirRequest = request?.kind === "out-of-allowed-dir";
    if (e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!approveDisabled && !isOutOfDirRequest) {
        handleCardChoice("allow-once");
      }
    } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!isOutOfDirRequest) onDecide("deny-once");
    }
  }, [
    request?.requireExplicit,
    request?.kind,
    onDecide,
    approveDisabled,
    handleCardChoice,
    interactionLocked,
    moveDecisionFocus,
  ]);

  if (!open || !request) return null;
  if (request.userOwnedSurface !== undefined && request.userOwnedSurfaceReviewFallback !== true) {
    return <UserOwnedSurfaceApprovalCard key={request.id} request={request} conversationLabel={conversationLabel} interactionLocked={interactionLocked} onDecide={onDecide} pendingCount={pendingCount}
      targetDescription={request.userOwnedSurface === "browser" ? browserTargetText(tHook, request) : terminalTargetText(tHook, request)}
      notes={request.userOwnedSurface === "host-terminal" ? terminalCommandNotes(tHook, request) : []} />;
  }
  if (request.kind === "egress-host") {
    return (
      <EgressHostApprovalCard
        request={request}
        conversationLabel={conversationLabel}
        interactionLocked={interactionLocked}
        onDecide={onDecide}
      />
    );
  }

  // NOTE: argsStr uses JSON.stringify for human-readable display (pretty-printed, insertion-order keys). The IPC approval record uses canonicalStringify
  // which sorts object keys; key ordering may differ between what is shown here and the canonical form used for cache-key lookups in dispatchReviewer.
  const argsStr = isRationaleApproval
    ? ""
    : (JSON.stringify(request.args, null, 2) ?? "");
  const explicitHostExecution = request.executionPlan !== undefined
    && "executionRequest" in request.executionPlan
    && request.executionPlan.executionRequest === "host";
  const requiresHostConsent = request.executionPlan?.mode === "plain"
    && request.executionPlan.requiresExplicitUserApproval;
  const argsTruncated = !requiresHostConsent && argsStr.length > 500 && !expanded;
  const argsDisplay = argsTruncated ? argsStr.slice(0, 500) + "\n…" : argsStr;
  const source = request.source ?? "unknown";
  const sourceBadge = request.source ? SOURCE_BADGE[request.source] ?? request.source : tHook("toolApprovalDialog.unknown");
  const originLabel = trustOriginLabel(request.trustOrigin);
  const category = request.toolCategory ?? "meta";
  // finalVerdict already computed above (before the null-check guard); use it here.
  const isSurfaceReviewFallback = request.userOwnedSurfaceReviewFallback === true;
  const badgeClassName = isSurfaceReviewFallback ? "text-muted-foreground" : levelBadgeClass(finalVerdict as RiskLevel);
  const reviewClassName = isSurfaceReviewFallback ? "border-border" : reviewBoxClass(finalVerdict as RiskLevel);
  // Rationale cards render the sealed table and out-of-dir cards render the path-grant evidence rows;
  // neither consumes the generic review rows, so skip computing them. The frame around that evidence is shared.
  const rows = isRationaleApproval || isOutOfDir
    ? []
    : approvalReviewRows(request, category, argsStr, originLabel, source, sourceBadge);
  const sandboxSummary = isRationaleApproval ? null : approvalSandboxSummary(request);
  const categoryImpact = approvalActionSummary(request, tHook);
  const specificReviewerReason = request.reviewerVerdict?.reason.trim() ?? "";
  const specificHostReason = request.reason.trim();
  // The path-grant reason is host-derived and localized here; the raw request.reason for this kind is an internal English marker.
  const reviewedImpact = isOutOfDir
    ? tHook("dockedApprovalCard.headline", { toolName: request.toolName })
    : !isBoilerplateApprovalReason(specificReviewerReason)
      ? specificReviewerReason
      : !isBoilerplateApprovalReason(specificHostReason)
        ? specificHostReason
        : categoryImpact;
  const highRiskReason = (userProvidedPurpose || reviewedImpact || categoryImpact).slice(0, 220);
  const impactSummary = isRationaleApproval
    ? ""
    : (showsHighRiskReason
        ? highRiskReason
        : (request.approvalPurpose?.text.trim() || reviewedImpact || categoryImpact)
      ).slice(0, 220);

  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${narrowLaneScroll ? "@max-[14rem]:flex-none" : ""}`}
      data-testid="tool-approval-panel"
      data-pending-count={pendingCount}
      data-approval-request-id={isRationaleApproval ? undefined : request.id}
      data-approval-tool-name={isRationaleApproval ? undefined : request.toolName}
      data-approval-args={
        isRationaleApproval ? undefined : canonicalStringifyForRenderer(request.args)
      }
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tool-approval-card">
        <section className={`min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-2 sm:px-4 sm:py-3 ${narrowLaneScroll ? "@max-[14rem]:overscroll-auto" : ""}`}>
          <div className="space-y-2">
            {/* Identity strip — host-owned facts (toolName, source, category,
                origin, risk chip), rendered for EVERY kind including a
                rationale whose sealed display failed to parse. The sealed
                table is EVIDENCE; identity must never depend on it — the
                degenerate card that showed no tool name at all is the bug
                this unconditional render removes. */}
                <div className="min-w-0 space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className={`${badgeClassName} shrink-0`}>
                      {isSurfaceReviewFallback ? <span data-testid="approval-logical-review-fallback">{tHook("toolApprovalDialog.surfaceReviewNeedsConfirmation")}</span>
                        : riskLevelKoLabel(finalVerdict as RiskLevel)}
                    </Badge>
                    <code
                      className="min-w-0 flex-1 break-all font-mono text-xs font-semibold"
                      data-testid="approval-tool-identity"
                    >
                      {/* For a sealed card only the HMAC-sealed display.toolName
                          is display-trusted; the generic request fields are
                          deliberately not attested for this kind. When the seal
                          is invalid the request name is the only identity left —
                          strictly better than the identity-less card this
                          replaces, but it must say it is unverified. */}
                      {isRationaleApproval
                        ? rationaleDisplay?.toolName ?? request.toolName
                        : sourceToolToken(request)}
                    </code>
                    {rationaleDisplayInvalid ? (
                      <span
                        className="shrink-0 rounded-full border border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) px-1.5 py-px text-[10px] text-destructive"
                        data-testid="approval-identity-unverified"
                      >
                        {tHook("toolApprovalDialog.identityUnverified")}
                      </span>
                    ) : null}
                  </div>
                  {!isRationaleApproval && (
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span>{request.sourcePluginId ?? sourceBadge}</span>
                    <span aria-hidden="true">·</span>
                    <span>{categoryLabel(category)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{originLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 truncate" data-testid="approval-conversation">
                      {conversationLabel}
                    </span>
                  </div>
                  )}
                  {request.kind === "agent-action" && request.approvalScope ? (
                    <p className="break-words text-[10px] text-muted-foreground">
                      {tHook("toolApprovalDialog.approvalScopePrefix")}: {request.approvalScope}
                    </p>
                  ) : null}
                </div>

            {/* Above the impact summary, and outside every kind-specific
                branch: the fact that a parent agent already looked at this ask
                and could not settle it is context for the decision itself, so
                it must not sit below a fold or inside one card variant. */}
            {request.parentEscalation ? (
              <ParentEscalationBand notice={request.parentEscalation} />
            ) : null}

            {/* Below the escalation band, above the impact summary. The
                escalation band accounts for THIS ask and the user needs it to
                answer; the reviewer suggestion is about the run of asks around
                it and offers a settings change. Request context first, standing
                advice second — the reverse would put an offer the user can
                ignore ahead of the fact they cannot. */}
            {reviewerSuggestion ? (
              <ReviewerSuggestionBand suggestion={reviewerSuggestion} />
            ) : null}

            {!isRationaleApproval && (
              <>
                <div
                  className={`min-w-0 rounded-md border-l-2 px-3 py-2 ${
                    showsHighRiskReason
                      ? "border-destructive bg-destructive/(--opacity-faint)"
                      : "border-warning bg-warning/(--opacity-subtle)"
                  }`}
                  data-testid="approval-impact-summary"
                >
                  {showsHighRiskReason ? (
                    <span className="text-[10px] font-semibold text-destructive">
                      {highRiskReasonSource}
                    </span>
                  ) : null}
                  <p
                    className="break-words text-xs leading-relaxed"
                    data-testid={showsHighRiskReason ? "high-risk-audit-reason" : undefined}
                  >
                    {impactSummary}
                  </p>
                  {/* Path grants keep what will be granted on screen: the
                      line tracks the selected decision, so moving to
                      allow-always shows the parent folder before the press. */}
                  {isOutOfDir ? (
                    <p
                      className="mt-0.5 break-all font-mono text-[11px]"
                      data-testid="approval-decision-target"
                    >
                      {decisionIndex === 0
                        ? tHook("dockedApprovalCard.denySummary")
                        : decisionIndex === 1 && outOfDirScopes?.always
                          ? tHook("dockedApprovalCard.targetParent", {
                              path: outOfDirScopes.always.path ?? "",
                            })
                          : outOfDirCandidatePath}
                    </p>
                  ) : null}
                  {sandboxSummary ? (
                    <p
                      className="mt-0.5 break-words text-[10px] text-muted-foreground"
                      data-testid={sandboxSummary.testId}
                    >
                      {sandboxSummary.value}
                    </p>
                  ) : null}
                  {request.executionPlan ? (
                    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground" data-testid="tool-approval-shell-environment">
                      {shellExecutionEnvironmentLines(request.executionPlan).map((line) => <p key={line}>{line}</p>)}
                    </div>
                  ) : null}
                  {requiresHostConsent ? (
                    <div className="mt-2 space-y-1" data-testid="tool-approval-host-execution">
                      <p className="text-sm font-semibold text-destructive">{tHook("shellExecution.hostWarning")}</p>
                      <p className="break-all font-mono text-xs" data-testid="tool-approval-execution-cwd">
                        {tHook("shellExecution.cwd", { path: request.executionCwd ?? "" })}
                      </p>
                      {explicitHostExecution ? <>
                        <p className="text-xs">{tHook("shellExecution.justification")}</p>
                        <p className="whitespace-pre-wrap break-words text-xs">
                          {isRecord(request.args) && typeof request.args.justification === "string" ? request.args.justification : ""}
                        </p>
                      </> : null}
                    </div>
                  ) : null}
                  {showsHighRiskReason ? (
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {tHook("toolApprovalDialog.highRiskExplicitApproval")}
                    </p>
                  ) : null}
                </div>
              </>
            )}

            <details
              className="group min-w-0 overflow-hidden rounded-lg border border-border-strong bg-muted/(--opacity-light)"
              data-testid={TEST_IDS.approvalReviewDetails}
              open={requiresHostConsent || undefined}
            >
              <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold">
                    {tHook("toolApprovalDialog.reviewDetails")}
                  </span>
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {tHook("toolApprovalDialog.reviewDetailsHint")}
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="space-y-3 border-t p-3">
                <p className="break-all text-[10px] text-muted-foreground">
                  {tHook("approvalAttribution.rowConversation")}:{" "}
                  <code className="font-mono" data-testid="approval-conversation-id">
                    {request.sessionId ?? tHook("approvalAttribution.unattributed")}
                  </code>
                </p>
                {isRationaleApproval ? (
                  <RationaleApprovalCard display={rationaleDisplay} />
                ) : isOutOfDir ? (
                  <div
                    className={`min-w-0 overflow-hidden rounded-md border ${reviewClassName}`}
                    data-testid="approval-path-grant-evidence"
                  >
                    <h4 className="border-b px-3 py-2 text-xs font-semibold">
                      {reviewTitleForCategory(category)}
                    </h4>
                    <ReviewRow label={tHook("toolApprovalDialog.allowOnce")}>
                      <code className="break-all font-mono">{outOfDirCandidatePath}</code>
                    </ReviewRow>
                    {outOfDirSuggestedParent ? (
                      <>
                        <ReviewRow label={tHook(FOLDER_ALLOW_LABEL_KEY)}>
                          <code className="break-all font-mono">{outOfDirSuggestedParent}</code>
                        </ReviewRow>
                        <p className="border-t px-3 py-2 text-xs text-muted-foreground" data-testid="approval-folder-project-hint">
                          {tHook("toolApprovalDialog.folderAddsProject")}
                        </p>
                      </>
                    ) : null}
                    {decisionIndex === 1 && (outOfDir?.adjacencyWarnings.length ?? 0) > 0 ? (
                      <p
                        className="border-t px-3 py-2 text-[11px] text-warning"
                        data-testid="approval-adjacency-warning"
                      >
                        {`⚠ ${outOfDir?.adjacencyWarnings.join(" · ")}`}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className={`min-w-0 overflow-hidden rounded-md border ${reviewClassName}`}>
                    <h4 className="border-b px-3 py-2 text-xs font-semibold">
                      {reviewTitleForCategory(category)}
                    </h4>
                    {rows.map((row) => (
                      <ReviewRow
                        key={row.label}
                        label={row.label}
                        testId={row.monospace ? undefined : row.testId}
                      >
                        {row.monospace ? (
                          <pre
                            className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                            data-testid={row.testId}
                          >
                            {row.value}
                          </pre>
                        ) : row.value}
                      </ReviewRow>
                    ))}
                  </div>
                )}

                {!isRationaleApproval && (
                  <PermissionEvaluationContextPanel context={request.evaluationContext} />
                )}

                {!isRationaleApproval && (
                  <div className="min-w-0 overflow-hidden rounded-md border bg-background">
                    <p className="border-b px-3 py-2 text-xs font-semibold">
                      {tHook("toolApprovalDialog.showFullInput")}
                    </p>
                    <pre className="max-h-56 max-w-full overflow-auto px-3 py-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                      {argsDisplay}
                    </pre>
                    {argsStr.length > 500 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto px-3 pb-2 pt-0 text-[11px] text-primary underline hover:bg-transparent"
                        onClick={() => setExpanded((v) => !v)}
                      >
                        {expanded ? tHook("toolApprovalDialog.collapse") : tHook("toolApprovalDialog.showAll")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </details>

            {!isRationaleApproval && isElicitationForm && (
              <div
                className="mt-3 rounded-md border bg-background p-3"
                data-testid="mcp-elicitation-form"
              >
                <p className="mb-2 text-xs font-semibold">Requested fields</p>
                <div className="grid gap-3">
                  {elicitationFields.map((field) => {
                    const inputId = `mcp-elicitation-${field.name}`;
                    const labelId = `${inputId}-label`;
                    const value = elicitationValues[field.name];
                    const invalid =
                      isRequiredElicitationValueMissing(field, value) ||
                      isNumericFieldInvalid(field, value);
                    return (
                      <div key={field.name} className="grid gap-1.5">
                        <Label
                          id={labelId}
                          htmlFor={field.enumOptions || field.kind === "boolean" ? inputId : undefined}
                          className="text-xs"
                        >
                          {field.label}
                          {field.required && <span className="ml-1 text-destructive">*</span>}
                        </Label>
                        {field.enumOptions ? (
                          <NativeSelect
                            id={inputId}
                            size="sm"
                            className="w-full"
                            value={typeof value === "string" ? value : ""}
                            aria-invalid={invalid || undefined}
                            data-testid={`mcp-elicitation-field-${field.name}`}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setElicitationValues((current) => ({
                                ...current,
                                [field.name]: nextValue,
                              }));
                            }}
                          >
                            <NativeSelectOption value="">Select...</NativeSelectOption>
                            {field.enumOptions.map((option) => (
                              <NativeSelectOption key={option.key} value={option.key}>
                                {option.label}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        ) : field.kind === "boolean" ? (
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id={inputId}
                              checked={value === true}
                              data-testid={`mcp-elicitation-field-${field.name}`}
                              onCheckedChange={(checked) => {
                                setElicitationValues((current) => ({
                                  ...current,
                                  [field.name]: checked === true,
                                }));
                              }}
                            />
                            <Label htmlFor={inputId} className="text-xs font-normal">
                              True
                            </Label>
                          </div>
                        ) : (
                          <div
                            id={inputId}
                            className="min-w-0 rounded-md border bg-muted/(--opacity-light) px-3 py-2 text-xs"
                            role="group"
                            aria-labelledby={labelId}
                            aria-invalid={invalid || undefined}
                            data-testid={`mcp-elicitation-field-${field.name}`}
                            data-readonly="true"
                          >
                            {typeof value === "string" && value.trim().length > 0 ? (
                              <code className="break-all font-mono">{value}</code>
                            ) : (
                              <span className="text-muted-foreground">
                                {tHook("toolApprovalDialog.noTypedValueProvided")}
                              </span>
                            )}
                          </div>
                        )}
                        {field.description && (
                          <p className="text-[11px] text-muted-foreground">
                            {field.description}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!isRationaleApproval && isUnsupportedElicitationForm && (
              <div
                className="mt-3 rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-faint) p-3 text-xs text-destructive"
                data-testid="mcp-elicitation-unsupported"
              >
                Requested form schema is not supported.
              </div>
            )}

            {!isRationaleApproval && (isUnsupportedElicitationForm || elicitationInvalid) && (
              <p
                id="mcp-elicitation-input-unavailable"
                className="mt-2 text-[10px] text-muted-foreground"
                data-testid="mcp-elicitation-input-unavailable"
              >
                {tHook("toolApprovalDialog.typedInputOutsideApproval")}
              </p>
            )}

          </div>

        </section>
          <footer className="min-w-0 shrink-0 space-y-1.5 border-t bg-card px-3 py-2 sm:px-4">
            {shellRule ? (
              <div className="space-y-1" data-testid="approval-shell-rule-context">
                {/* Only unconfined runs display the outside-sandbox warning. */}
                {request.executionPlan?.sandboxed !== true ? (
                  <p className="text-[11px] text-muted-foreground" data-testid="approval-shell-outside-sandbox">{tHook("toolApprovalDialog.shellOutsideSandbox")}</p>
                ) : null}
                {(
                  <p className="break-all text-[10px] text-muted-foreground" data-testid="approval-shell-rule-scope-target">
                    {tHook("toolApprovalDialog.shellScopeProjectTarget", { root: shellRule.projectRoot })}
                  </p>
                )}
                {/* An -EncodedCommand payload is shown as the script it runs; the host checked that text, and no rule covers it. */}
                {shellRule.decodedCommands?.map((decoded, index) => (
                  <div key={index} className="min-w-0 space-y-0.5" data-testid="approval-shell-decoded-command">
                    <p className="text-[10px] font-medium text-warning">{tHook("toolApprovalDialog.shellDecodedCommand")}</p>
                    <code className="block whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px]">{decoded}</code>
                  </div>
                ))}
              </div>
            ) : null}
            {/* Fail-closed: a sealed display that cannot be parsed strips the allow options entirely — offering approval for an action whose
                identity evidence is broken is not an option this card may present. Deny remains: it unblocks the turn and lets the model
                regenerate the rationale. */}
            <ApprovalDecisionBar
              model={decisionModel}
              state={decision}
              disabled={slotsDisabled}
              onCommit={handleCardChoice}
              onEditInSettings={onOpenPermanentDeny
                ? () => {
                    if (recordingRequestIdRef.current === null) onOpenPermanentDeny(request, finalVerdict as UserApprovalVerdict);
                  }
                : undefined}
              editInSettingsDisabled={recordingDecision}
              hideAllows={rationaleDisplayInvalid}
              stackWhenNarrow={narrowLaneScroll}
              slotProps={(slot) => {
                const slotDisabled = slotsDisabled[slot];
                const common = {
                  ref: (element: HTMLButtonElement | null) => {
                    decisionButtonRefs.current[slot] = element;
                  },
                  tabIndex: decisionIndex === slot && !slotDisabled ? 0 : -1,
                  onFocus: () => setDecisionIndex(slot),
                  "data-proposed": proposedDecisionIndex === slot && !slotDisabled ? "true" : undefined,
                };
                if (slot === 0) {
                  return {
                    ...common,
                    title: decisionShortcutsActive ? tHook("toolApprovalDialog.shortcutD") : undefined,
                    "aria-describedby": interactionLocked ? "approval-decision-locked" : undefined,
                  };
                }
                if (slot === 1) {
                  return {
                    ...common,
                    title: persistentUnavailableReason
                      ?? (approveDisabled ? tHook("toolApprovalDialog.completeRequiredChoices") : undefined),
                    "aria-describedby": interactionLocked
                      ? "approval-decision-locked"
                      : persistentUnavailableReason
                        ? "allow-always-unavailable-reason"
                        : approveDisabled
                          ? approveDisabledDescriptionId
                          : undefined,
                  };
                }
                return {
                  ...common,
                  title: approveButtonTitle,
                  "aria-describedby": interactionLocked
                    ? "approval-decision-locked"
                    : approveDisabled
                      ? approveDisabledDescriptionId
                      : undefined,
                };
              }}
            />
            {persistentUnavailableReason ? (
              <p
                id="allow-always-unavailable-reason"
                className="text-[10px] text-muted-foreground"
                data-testid="allow-always-unavailable-reason"
              >
                {persistentUnavailableReason}
              </p>
            ) : null}
            {browserTargetText(tHook, request) ? (
              <p className="text-[10px] text-muted-foreground" data-testid="approval-browser-target">
                {browserTargetText(tHook, request)}
              </p>
            ) : null}
            {terminalTargetText(tHook, request) ? (
              <p className="text-[10px] text-muted-foreground break-all" data-testid="approval-terminal-target">
                {terminalTargetText(tHook, request)}
              </p>
            ) : null}
            {terminalCommandNotes(tHook, request).map((note) => (
              <p key={note} className="text-[10px] text-warning break-all" data-testid="approval-terminal-note">
                {note}
              </p>
            ))}
            {decisionModel.variant === "exact" && allowRefusal === null && request.persistentApprovalCwd ? (
              <p className="text-[10px] text-muted-foreground" data-testid="allow-always-exact-scope">
                {decision.selected === "allow-everywhere"
                  ? request.approvalMemory?.kind === "key" && request.approvalMemory.scope.kind === "mcp-tool"
                    ? tHook("toolApprovalDialog.rememberScopeMcpToolGlobal", { serverId: request.approvalMemory.scope.serverId, toolName: request.approvalMemory.scope.toolName })
                    : tHook("toolApprovalDialog.exactScopeEverywhere")
                  : rememberScopeText(tHook, request, request.persistentApprovalCwd)}
              </p>
            ) : null}
            {interactionLocked ? (
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p
                  id="approval-decision-locked"
                  className="text-[10px] text-muted-foreground"
                  data-testid="approval-decision-locked"
                >
                  {tHook("toolApprovalDialog.decisionPendingInSettings")}
                </p>
                {/* Settings holds this request's exact-deny draft; the way back to it stays open while every decision is locked. */}
                {onOpenPermanentDeny && decision.selected !== "deny-always" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    className="h-auto min-w-0 max-w-full shrink p-0 text-right text-[11px] whitespace-normal break-words"
                    data-testid={TEST_IDS.openPermanentDenySettings}
                    onClick={() => onOpenPermanentDeny(request, finalVerdict as UserApprovalVerdict)}
                  >
                    {tHook("toolApprovalDialog.openPermissionSettings")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {recordError ? (
              <p className="text-[11px] text-destructive" role="alert" data-testid="exact-decision-save-error">
                {recordError}
              </p>
            ) : null}
          </footer>
      </div>
    </div>
  );
}

function isMenuTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"]') !== null;
}

function isTextEntryShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(
    'input, textarea, select, [role="textbox"], [contenteditable="true"]',
  ) !== null;
}

function parseArgs(args: unknown): ParsedSummary | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as ParsedSummary;
}

function approvalSandboxSummary(request: ApprovalRequest): ReviewBasisRow | null {
  const cap = request.executionPlan?.capability ?? request.sandboxCapability;
  if (!cap) return null;

  let value: string;
  if (cap.kind === "partial") {
    value = t("toolApprovalDialog.sandboxPartial");
  } else if (cap.kind === "fs-only") {
    value = t("toolApprovalDialog.sandboxFsOnly");
  } else if (cap.kind === "none" || cap.confidence === "assumed") {
    value = t("toolApprovalDialog.sandboxNone");
  } else if (cap.kind === "disposable-container") {
    // The broker guest: filesystem and process tree are the guest's own and are discarded with it; egress is the guest's policy, not "partial".
    value = t("toolApprovalDialog.sandboxDisposableGuest");
  } else if (
    cap.confines &&
    !(cap.confines.filesystem && cap.confines.process && cap.confines.network)
  ) {
    value = t("toolApprovalDialog.sandboxNetworkOnly", {
      net: cap.confines.network ? "✓" : "✗",
      fs: cap.confines.filesystem ? "✓" : "✗",
      proc: cap.confines.process ? "✓" : "✗",
    });
  } else {
    value = t("toolApprovalDialog.sandboxActive", { kind: cap.kind });
  }
  if (request.executionPlan?.requiresExplicitUserApproval === true) {
    value += ` · ${t("toolApprovalDialog.allowOnce")}`;
  }
  return {
    label: t("toolApprovalDialog.rowSandbox"),
    value,
    testId: request.executionPlan ? "tool-approval-execution-plan" : "tool-approval-sandbox",
  };
}

function approvalReviewRows(
  request: ApprovalRequest,
  category: ToolCategory,
  inputSummary: string,
  originLabel: string,
  _source: string,
  _sourceBadge: string,
): ReviewBasisRow[] {
  const parsed = parseArgs(request.args);
  const reviewer = request.userOwnedSurfaceReviewFallback === true ? request.reviewerVerdict?.reason ?? request.reason : request.reviewerVerdict
    ? `${riskLevelKoLabel(request.reviewerVerdict.level)} · ${request.reviewerVerdict.reason}`
    : request.reason;
  // Source, trust origin, category, conversation and sandbox now live in the compact always-visible summary. Details contain only additional evidence.
  const rows: ReviewBasisRow[] = [];
  if (isNonUserTrustOrigin(request.trustOrigin)) {
    rows.push({
      label: t("toolApprovalDialog.rowCaution"),
      value: t("toolApprovalDialog.cautionNonUserOrigin", { originLabel }),
    });
  }

  // Elaboration rows render ONLY when they carry actual per-invocation data; pickSummary's hardcoded "…not specified" fallback is dropped so the dock shows real args, not boilerplate. The primary data row (target / command /
  // endpoint) + the reviewer verdict always render. Always-hardcoded/redundant rows (write impact = source·category·note; read scope = source·category·…; read volume) are removed; origin + category already live in the tiles + 판단.
  const NO_DATA = "__AVE_NO_APPROVAL_DATA__";
  const optRow = (
    label: string,
    keys: string[],
    opts: Partial<ReviewBasisRow> = {},
  ): ReviewBasisRow | null => {
    const v = pickSummary(parsed, keys, NO_DATA);
    return v === NO_DATA ? null : { label, value: v, ...opts };
  };
  const kept = (...rs: (ReviewBasisRow | null)[]): ReviewBasisRow[] =>
    rs.filter((r): r is ReviewBasisRow => r !== null);

  if (category === "read") {
    rows.push(
      { label: t("toolApprovalDialog.rowTarget"), value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "directory", "resource", "query", "url", "uri"], inputSummary), monospace: true, testId: "tool-approval-input" },
      { label: t("toolApprovalDialog.rowSensitivity"), value: sensitivityLabel(parsed) },
    );
  } else if (category === "write") {
    rows.push(
      { label: t("toolApprovalDialog.rowTarget"), value: request.target?.filePath ?? pickSummary(parsed, ["path", "paths", "target", "targets", "file", "configKey", "taskId", "id"], inputSummary), monospace: true, testId: "tool-approval-input" },
      ...kept(
        optRow(t("toolApprovalDialog.rowChange"), ["operation", "action", "mode", "patch", "content", "body", "text"], { monospace: true }),
        optRow(t("toolApprovalDialog.rowRecovery"), ["diff", "backup", "rollback", "undo"]),
      ),
    );
  } else if (category === "network") {
    rows.push(
      { label: t("toolApprovalDialog.rowEndpoint"), value: pickSummary(parsed, ["endpoint", "url", "uri", "host", "baseUrl"], t("toolApprovalDialog.endpointNotSpecified")), monospace: true, testId: "tool-approval-input" },
      ...kept(
        optRow(t("toolApprovalDialog.rowMethod"), ["method", "httpMethod"]),
        optRow(t("toolApprovalDialog.rowPayload"), ["payload", "body", "message", "text", "input", "params", "args"], { monospace: true }),
        optRow(t("toolApprovalDialog.rowAuthScope"), ["auth", "scope", "scopes", "tenant", "account"]),
      ),
    );
  } else if (category === "shell") {
    rows.push(
      { label: t("toolApprovalDialog.rowCommand"), value: pickSummary(parsed, ["command", "cmd", "args", "script", "argv"], inputSummary), monospace: true, testId: "tool-approval-input" },
      ...kept(
        optRow(t("toolApprovalDialog.rowCwdEnv"), ["cwd", "workingDirectory", "env", "environment"], { monospace: true }),
      ),
      { label: t("toolApprovalDialog.rowLimits"), value: formatEvaluationLimits(request.evaluationContext) },
    );
  } else {
    rows.push({
      label: t("toolApprovalDialog.rowInput"),
      value: inputSummary,
      monospace: true,
      testId: "tool-approval-input",
    });
  }

  rows.push(
    { label: t("toolApprovalDialog.rowVerdict"), value: reviewer },
  );
  return rows;
}

/** Compact `source:tool` identity for the Tool/Source tile; `builtin:bash`, `mcp:<tool>`, or `<pluginId>:<tool>` for a plugin (agent-action) call. One short token
 * instead of the old three-line source/plugin/scope stack, so the approval content fits without scrolling. The origin + risk are still shown in the review box's 출처/판단 rows. */
function sourceToolToken(request: ApprovalRequest): string {
  const tool = request.toolName;
  if (request.kind === "agent-action" && request.sourcePluginId) {
    return `${request.sourcePluginId}:${tool}`;
  }
  return `${request.source ?? "unknown"}:${tool}`;
}

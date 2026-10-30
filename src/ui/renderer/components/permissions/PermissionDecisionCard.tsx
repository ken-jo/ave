import type { ReactNode } from "react";
import { t } from "../../../../i18n/runtime.js";
import type { RiskLevel, ToolCategory } from "../../../../shared/permission-review-status.js";

export type ReviewBasisRow = {
  label: string;
  value: string;
  monospace?: boolean;
  testId?: string;
};

export type ParsedSummary = Record<string, unknown>;

export function ReviewRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  // Lets the row wrapper itself carry a data-testid so prose rows (non-monospace) can be selected without forcing them into
  // the `<pre>` branch (which mis-renders human- readable sentences as terminal output).
  testId?: string;
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-1 border-b px-3 py-2 last:border-b-0 sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-3"
      data-testid={testId}
    >
      <b className="text-xs">{label}</b>
      <div className="min-w-0 break-words text-xs leading-relaxed">
        {children}
      </div>
    </div>
  );
}

/**
 * Canonical Korean label for a {@link RiskLevel}.
 *
 * Centralized here so every risk-display site (ToolApprovalContent
 * badge / reviewer-verdict row and denial history
 * row, future surfaces) reads the same translation. Translating only
 * the primary badge is the failure mode this replaced: the remaining
 * `level.toUpperCase()` callers leaked raw English to users.
 */
export function riskLevelKoLabel(level: RiskLevel): string {
  if (level === "high") return t("permissionDecisionCard.riskHigh");
  if (level === "medium") return t("permissionDecisionCard.riskMedium");
  return t("permissionDecisionCard.riskLow");
}

export function levelBadgeClass(level: RiskLevel) {
  if (level === "high") return "border-destructive text-destructive";
  if (level === "medium") return "border-warning text-warning";
  return "border-primary text-primary";
}

export function reviewBoxClass(level: RiskLevel) {
  if (level === "high") return "border-destructive/(--opacity-half) bg-destructive/(--opacity-subtle)";
  if (level === "medium") return "border-warning/(--opacity-half) bg-warning/(--opacity-subtle)";
  return "border-primary/(--opacity-medium) bg-primary/(--opacity-faint)";
}

export function reviewTitleForCategory(category: ToolCategory) {
  if (category === "read") return t("permissionDecisionCard.reviewTitleRead");
  if (category === "network") return t("permissionDecisionCard.reviewTitleNetwork");
  if (category === "shell") return t("permissionDecisionCard.reviewTitleShell");
  return t("permissionDecisionCard.reviewTitleDefault");
}

export function categoryLabel(category: ToolCategory) {
  if (category === "network") return t("permissionDecisionCard.categoryNetwork");
  if (category === "shell") return t("permissionDecisionCard.categoryShell");
  if (category === "write") return t("permissionDecisionCard.categoryWrite");
  if (category === "read") return t("permissionDecisionCard.categoryRead");
  return t("permissionDecisionCard.categoryMeta");
}

export function pickSummary(parsed: ParsedSummary | null, keys: string[], emptyText: string): string {
  if (!parsed) return emptyText;
  for (const key of keys) {
    const value = parsed[key];
    if (value === undefined || value === null || value === "") continue;
    return formatSummaryValue(value);
  }
  return emptyText;
}

function formatSummaryValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function sensitivityLabel(parsed: ParsedSummary | null): string {
  const explicit = pickSummary(parsed, ["sensitivity", "dataClass", "classification"], "");
  return explicit || t("permissionDecisionCard.sensitivityFallback");
}

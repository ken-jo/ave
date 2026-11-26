import { t } from "../i18n/runtime.js";
import type { UnknownModelPricingReason } from "../shared/model-pricing.js";

/** Clamp invalid or nonpositive counts to zero and round sub-thousand fractions. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Use locale grouping with the same invalid-count clamp as compact formatting. */
export function formatTokensExact(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

/** Widen precision below a cent and group USD thousands in en-US. */
export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return t("be_costEstimator.costUnknown");
  if (n <= 0) return "$0";
  if (n < 0.001) return `$${n.toFixed(5)}`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const PRICING_REASON_LABELS = {
  "endpoint-price-unavailable": "pricing.endpointPriceUnavailable",
  "legacy-route-unrecorded": "pricing.legacyRouteUnrecorded",
} as const satisfies Record<UnknownModelPricingReason, string>;

export function formatUsageCost(usage: {
  cost?: number;
  unknownCostTurns?: number;
  endpointPriceUnavailableTurns?: number;
  legacyRouteUnrecordedTurns?: number;
}): string {
  const { cost, unknownCostTurns } = usage;
  const base = cost !== undefined && (!unknownCostTurns || cost > 0)
    ? formatCost(cost) : t("be_costEstimator.costUnknown");
  return [
    usage.unknownCostTurns
      ? t("usageDashboard.unknownCostTurns", { base, turns: String(usage.unknownCostTurns) })
      : base,
    ...(usage.endpointPriceUnavailableTurns ? [t(PRICING_REASON_LABELS["endpoint-price-unavailable"])] : []),
    ...(usage.legacyRouteUnrecordedTurns ? [t(PRICING_REASON_LABELS["legacy-route-unrecorded"])] : []),
  ].join(" · ");
}

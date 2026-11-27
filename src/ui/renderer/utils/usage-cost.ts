import type { TranslateFn } from "../../../i18n/translate.js";
import { formatCost } from "../../../lib/cost-format.js";
import type { UnknownModelPricingReason } from "../../../shared/model-pricing.js";

export const PRICING_REASON_LABELS = {
  "endpoint-price-unavailable": "pricing.endpointPriceUnavailable",
  "legacy-route-unrecorded": "pricing.legacyRouteUnrecorded",
} as const satisfies Record<UnknownModelPricingReason, string>;

export function formatUsageCost(usage: {
  cost?: number;
  unknownCostTurns?: number;
  endpointPriceUnavailableTurns?: number;
  legacyRouteUnrecordedTurns?: number;
}, t: TranslateFn): string {
  const { cost, unknownCostTurns } = usage;
  const base = cost !== undefined && (!unknownCostTurns || cost > 0)
    ? formatCost(cost) : t("be_costEstimator.costUnknown");
  return [
    unknownCostTurns
      ? t("usageDashboard.unknownCostTurns", { base, turns: String(unknownCostTurns) })
      : base,
    ...(usage.endpointPriceUnavailableTurns ? [t(PRICING_REASON_LABELS["endpoint-price-unavailable"])] : []),
    ...(usage.legacyRouteUnrecordedTurns ? [t(PRICING_REASON_LABELS["legacy-route-unrecorded"])] : []),
  ].join(" · ");
}

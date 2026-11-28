import type { SessionRepository } from "../memory/session-repository.js";
import { isRecord } from "../shared/is-record.js";
import type { ModelUsageSegment } from "../shared/model-pricing.js";
import { localDateKey, localMonthStartKey, localMondayWeekStartKey, shiftLocalDateKey } from "../shared/local-date.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionRuntimeId,
  type SubscriptionUsageSource,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import { isLLMVendor, type LLMVendor } from "./llm/types.js";
import { normalizeAiSdkUsageForCost } from "./llm/pricing.js";
import { LEGACY_ROUTE_UNRECORDED, parseResolvedModelPricing, recordedUsageSegmentPricing, type RecordedModelPricing, type UnknownModelPricingReason } from "../shared/model-pricing.js";
import { averageDailyCost, computeCost } from "../shared/pricing-data.js";

export interface UsageTurnEntry {
  timestamp: string;
  sessionId: string;
  type: string;
  tokenUsage?: ModelUsageSegment["tokenUsage"];
  usageByModel?: ModelUsageSegment[];
  modelSettings?: { pricing?: unknown };
  /** Untrusted persisted subscription telemetry; normalize before use. */
  subscriptionUsage?: unknown;
  route?: string;
  input?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Subtotal of priced requests. Unknown requests contribute no amount. */
  cost: number;
  /** A known price can contribute a zero subtotal. */
  hasPricedCost?: true;
  unknownCostTurns?: number;
  endpointPriceUnavailableTurns?: number;
  legacyRouteUnrecordedTurns?: number;
}

export interface UsagePerVendor extends UsageTotals {
  vendor: string;
  model: string;
}

export interface UsageTrendPoint extends UsageTotals {
  date: string; // YYYY-MM-DD
}

export interface UsageConversation extends UsageTotals {
  sessionId: string;
  turns: number;
  firstInput?: string;
}

// Subscription telemetry is token-only and must never enter API pricing or cost projections.
interface SubscriptionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Number of measured provider request segments, not billable API turns. */
  segments: number;
}

interface SubscriptionUsagePerRuntime extends SubscriptionUsageTotals {
  provider: SubscriptionRuntimeId;
  model: string;
}

interface SubscriptionUsageTrendPoint extends SubscriptionUsageTotals {
  date: string; // YYYY-MM-DD
}

interface SubscriptionUsageSummary {
  today: SubscriptionUsageTotals;
  thisWeek: SubscriptionUsageTotals;
  thisMonth: SubscriptionUsageTotals;
  perRuntime: SubscriptionUsagePerRuntime[];
  perModel: SubscriptionUsagePerRuntime[];
  trend: SubscriptionUsageTrendPoint[];
  /** Separate provenance totals; never interpreted as price information. */
  sources: Record<SubscriptionUsageSource, SubscriptionUsageTotals>;
}

export interface UsageSummary {
  /** Coverage can omit unsaved sessions or turns without persisted summaries. */
  auditIncomplete?: true;
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  perVendor: UsagePerVendor[];
  perModel: UsagePerVendor[];
  trend: UsageTrendPoint[];
  /** Ranked by priced spend, with totals drawn only from priced requests. */
  topConversations: UsageConversation[];
  /** Activity with or without a recorded price, ranked by total tokens. */
  topConversationsByTokens: UsageConversation[];
  subscription: SubscriptionUsageSummary;
  generatedAt: string;
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function emptySubscriptionTotals(): SubscriptionUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    segments: 0,
  };
}

function emptySubscriptionSources(): Record<SubscriptionUsageSource, SubscriptionUsageTotals> {
  return {
    "provider-reported": emptySubscriptionTotals(),
    "local-estimate": emptySubscriptionTotals(),
  };
}

type UsageVendor = LLMVendor | "unknown";

function parseRoute(route: string | undefined): { vendor: UsageVendor; model: string } {
  if (!route) return { vendor: "unknown", model: "unknown" };
  const [v, ...rest] = route.split("/");
  if (!isLLMVendor(v)) {
    // Legacy bare-route usage stays visible but unpriced; do not assign it to the default vendor.
    return { vendor: "unknown", model: route };
  }
  const vendor: LLMVendor = v;
  return { vendor, model: rest.join("/") || "unknown" };
}

type UsageSegment = {
  vendor: UsageVendor;
  model: string;
  tokenUsage: NonNullable<UsageTurnEntry["tokenUsage"]>;
  pricing?: RecordedModelPricing;
};

function parseSubscriptionUsageSegments(entry: UsageTurnEntry): SubscriptionUsageTelemetry[] {
  if (!Array.isArray(entry.subscriptionUsage)) return [];
  const segments: SubscriptionUsageTelemetry[] = [];
  for (const raw of entry.subscriptionUsage) {
    const telemetry = normalizeSubscriptionUsageTelemetry(raw);
    if (telemetry) segments.push(telemetry);
  }
  return segments;
}

function parseUsageSegments(entry: UsageTurnEntry): UsageSegment[] {
  const recordedRoute = parseRoute(entry.route);
  const recordedPricing = parseResolvedModelPricing(entry.modelSettings?.pricing);
  if (entry.usageByModel?.length) {
    const primary = { vendorProvider: recordedRoute.vendor, vendorModel: recordedRoute.model, pricing: recordedPricing };
    return entry.usageByModel.map((segment) => {
      const model = segment.vendorModel || "unknown";
      // Renamed or retired vendor IDs retain their usage as visible, unpriced segments.
      const pricing = recordedUsageSegmentPricing({ ...segment, vendorModel: model }, primary);
      return isLLMVendor(segment.vendorProvider)
        ? { vendor: segment.vendorProvider, model, tokenUsage: segment.tokenUsage, pricing }
        : { vendor: "unknown" as const, model: `${segment.vendorProvider}/${model}`, tokenUsage: segment.tokenUsage, pricing };
    });
  }
  if (!entry.tokenUsage) return [];
  const { vendor, model } = parseRoute(entry.route);
  const tokenUsage =
    vendor === "claude"
      // Legacy rows without normalized segments use raw SDK semantics; split cache input before pricing.
      ? normalizeAiSdkUsageForCost(entry.tokenUsage, vendor)
      : entry.tokenUsage;
  return [{ vendor, model, tokenUsage, pricing: recordedPricing }];
}

function addTo(
  target: UsageTotals,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  vendor: UsageVendor,
  cost: number | undefined,
  unknownPricingReason: UnknownModelPricingReason | undefined,
): void {
  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheReadTokens += cacheRead;
  target.cacheWriteTokens += cacheWrite;

  // Unknown legacy cache semantics must not inflate totals beyond input plus output.
  target.totalTokens +=
    vendor === "claude"
      ? input + output + cacheRead + cacheWrite
      : input + output;
  const subtotal = cost === undefined ? undefined : target.cost + cost;
  if (subtotal !== undefined && Number.isFinite(subtotal)) {
    target.cost = subtotal;
    target.hasPricedCost = true;
  } else {
    target.unknownCostTurns = (target.unknownCostTurns ?? 0) + 1;
  }
  if (unknownPricingReason === "endpoint-price-unavailable") {
    target.endpointPriceUnavailableTurns = (target.endpointPriceUnavailableTurns ?? 0) + 1;
  } else if (unknownPricingReason === "legacy-route-unrecorded") {
    target.legacyRouteUnrecordedTurns = (target.legacyRouteUnrecordedTurns ?? 0) + 1;
  }
}

function addSubscriptionTo(
  target: SubscriptionUsageTotals,
  telemetry: SubscriptionUsageTelemetry,
): void {
  target.inputTokens += telemetry.inputTokens;
  target.outputTokens += telemetry.outputTokens;
  target.cacheReadTokens += telemetry.cacheReadTokens ?? 0;
  target.cacheWriteTokens += telemetry.cacheWriteTokens ?? 0;
  target.reasoningOutputTokens += telemetry.reasoningOutputTokens ?? 0;
  // Use canonical reported or estimated totalTokens; cache and reasoning are not additive extras.
  target.totalTokens += telemetry.totalTokens;
  target.segments += 1;
}

export function computeUsageSummary(
  entries: UsageTurnEntry[],
  now: Date = new Date(),
): UsageSummary {
  const todayKey = localDateKey(now);
  const weekKey = localMondayWeekStartKey(now);
  const monthKey = localMonthStartKey(now);

  const today = emptyTotals();
  const thisWeek = emptyTotals();
  const thisMonth = emptyTotals();

  const perVendorMap = new Map<string, UsagePerVendor>();
  const perModelMap = new Map<string, UsagePerVendor>();
  const trendMap = new Map<string, UsageTrendPoint>();
  const convMap = new Map<string, UsageConversation>();
  const pricedConvMap = new Map<string, UsageConversation>();

  const subscription = {
    today: emptySubscriptionTotals(),
    thisWeek: emptySubscriptionTotals(),
    thisMonth: emptySubscriptionTotals(),
    perRuntime: [] as SubscriptionUsagePerRuntime[],
    perModel: [] as SubscriptionUsagePerRuntime[],
    trend: [] as SubscriptionUsageTrendPoint[],
    sources: emptySubscriptionSources(),
  };
  const subscriptionPerRuntimeMap = new Map<SubscriptionRuntimeId, SubscriptionUsagePerRuntime>();
  const subscriptionPerModelMap = new Map<string, SubscriptionUsagePerRuntime>();
  const subscriptionTrendMap = new Map<string, SubscriptionUsageTrendPoint>();

  for (const e of entries) {
    const ts = new Date(e.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    const dKey = localDateKey(ts);

    for (const telemetry of parseSubscriptionUsageSegments(e)) {
      if (dKey === todayKey) addSubscriptionTo(subscription.today, telemetry);
      if (dKey >= weekKey) addSubscriptionTo(subscription.thisWeek, telemetry);
      if (dKey >= monthKey) addSubscriptionTo(subscription.thisMonth, telemetry);
      addSubscriptionTo(subscription.sources[telemetry.source], telemetry);

      let runtime = subscriptionPerRuntimeMap.get(telemetry.provider);
      if (!runtime) {
        runtime = { provider: telemetry.provider, model: "*", ...emptySubscriptionTotals() };
        subscriptionPerRuntimeMap.set(telemetry.provider, runtime);
      }
      addSubscriptionTo(runtime, telemetry);

      const modelKey = `${telemetry.provider}\u0000${telemetry.model}`;
      let model = subscriptionPerModelMap.get(modelKey);
      if (!model) {
        model = { provider: telemetry.provider, model: telemetry.model, ...emptySubscriptionTotals() };
        subscriptionPerModelMap.set(modelKey, model);
      }
      addSubscriptionTo(model, telemetry);

      let trendPoint = subscriptionTrendMap.get(dKey);
      if (!trendPoint) {
        trendPoint = { date: dKey, ...emptySubscriptionTotals() };
        subscriptionTrendMap.set(dKey, trendPoint);
      }
      addSubscriptionTo(trendPoint, telemetry);
    }

    const segments = parseUsageSegments(e);
    if (segments.length === 0) continue;

    let c = convMap.get(e.sessionId);
    if (!c) {
      c = { sessionId: e.sessionId, turns: 0, firstInput: e.input, ...emptyTotals() };
      convMap.set(e.sessionId, c);
    }
    c.turns += 1;

    let countedPricedTurn = false;
    for (const segment of segments) {
      const { vendor, model, tokenUsage } = segment;
      const {
        inputTokens,
        outputTokens,
        cacheReadTokens = 0,
        cacheWriteTokens = 0,
      } = tokenUsage;
      const pricing = segment.pricing ?? LEGACY_ROUTE_UNRECORDED;
      const unknownPricingReason = pricing.source === "unknown" ? pricing.reason : undefined;
      const cost = pricing.source !== "unknown" ? computeCost(tokenUsage, pricing.rates, vendor) : undefined;

      if (dKey === todayKey) addTo(today, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, unknownPricingReason);
      if (dKey >= weekKey) addTo(thisWeek, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, unknownPricingReason);
      if (dKey >= monthKey) addTo(thisMonth, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, unknownPricingReason);

      const vKey = vendor;
      let v = perVendorMap.get(vKey);
      if (!v) {
        v = { vendor, model: "*", ...emptyTotals() };
        perVendorMap.set(vKey, v);
      }
      addTo(v, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, unknownPricingReason);

      const mKey = `${vendor}/${model}`;
      let m = perModelMap.get(mKey);
      if (!m) {
        m = { vendor, model, ...emptyTotals() };
        perModelMap.set(mKey, m);
      }
      addTo(m, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, unknownPricingReason);

      let t = trendMap.get(dKey);
      if (!t) {
        t = { date: dKey, ...emptyTotals() };
        trendMap.set(dKey, t);
      }
      addTo(t, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, unknownPricingReason);
      addTo(c, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, unknownPricingReason);
      if (cost !== undefined && Number.isFinite(cost)) {
        let priced = pricedConvMap.get(e.sessionId);
        if (!priced) {
          priced = { sessionId: e.sessionId, turns: 0, firstInput: e.input, ...emptyTotals() };
          pricedConvMap.set(e.sessionId, priced);
        }
        if (!countedPricedTurn) priced.turns += 1;
        countedPricedTurn = true;
        addTo(priced, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, undefined);
      }
    }
  }

  const trend = Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const topConversations = Array.from(pricedConvMap.values())
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens || a.sessionId.localeCompare(b.sessionId))
    .slice(0, 5);
  const topConversationsByTokens = Array.from(convMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens || a.sessionId.localeCompare(b.sessionId))
    .slice(0, 5);

  subscription.perRuntime = Array.from(subscriptionPerRuntimeMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
  subscription.perModel = Array.from(subscriptionPerModelMap.values())
    .sort((a, b) => (
      b.totalTokens - a.totalTokens
      || a.provider.localeCompare(b.provider)
      || a.model.localeCompare(b.model)
    ));
  subscription.trend = Array.from(subscriptionTrendMap.values())
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    today,
    thisWeek,
    thisMonth,
    perVendor: Array.from(perVendorMap.values()).sort((a, b) => b.cost - a.cost),
    perModel: Array.from(perModelMap.values()).sort((a, b) => b.cost - a.cost),
    trend,
    topConversations,
    topConversationsByTokens,
    subscription,
    generatedAt: now.toISOString(),
  };
}

export interface UsageRangeOptions {
  dateFrom: string;
  dateTo: string;
}

export type UsageSessionSource = Pick<SessionRepository, "listSessions" | "loadSession">;

function validTokens(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function toUsageTurn(sessionId: string, timestamp: string, summary: Record<string, unknown>): UsageTurnEntry {
  const route = typeof summary.vendorProvider === "string" && typeof summary.vendorModel === "string"
    ? `${summary.vendorProvider}/${summary.vendorModel}`
    : undefined;
  const segments = Array.isArray(summary.usageByModel) ? summary.usageByModel.filter(
    (item): item is ModelUsageSegment => isRecord(item) && typeof item.vendorProvider === "string"
      && typeof item.vendorModel === "string" && isRecord(item.tokenUsage)
      && validTokens(item.tokenUsage.inputTokens) && validTokens(item.tokenUsage.outputTokens),
  ) : [];
  const cacheReadTokens = validTokens(summary.cacheReadTokens) ? summary.cacheReadTokens : 0;
  const cacheWriteTokens = validTokens(summary.cacheWriteTokens) ? summary.cacheWriteTokens : 0;
  const tokenUsage = !segments.length && !Array.isArray(summary.subscriptionUsage)
    && validTokens(summary.freshInputTokens) && validTokens(summary.tokensOut)
    && (summary.usageReported === true || (summary.usageReported === undefined
      && summary.freshInputTokens + summary.tokensOut + cacheReadTokens + cacheWriteTokens > 0))
    ? { inputTokens: summary.freshInputTokens + cacheReadTokens + cacheWriteTokens,
        outputTokens: summary.tokensOut, cacheReadTokens, cacheWriteTokens }
    : undefined;
  const pricing = isRecord(summary.modelSettings) ? parseResolvedModelPricing(summary.modelSettings.pricing) : undefined;
  return {
    timestamp, sessionId, type: "turn", route, tokenUsage, usageByModel: segments.map((segment) => ({
      ...segment,
      tokenUsage: normalizeAiSdkUsageForCost(segment.tokenUsage, segment.vendorProvider),
    })),
    ...(pricing ? { modelSettings: { pricing } } : {}),
    subscriptionUsage: summary.subscriptionUsage,
  };
}

export async function getUsageRange(
  sessions: UsageSessionSource,
  opts: UsageRangeOptions,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const entries: UsageTurnEntry[] = [];
  const counted = new Set<string>();
  // Sessions outside this repository and turns without summaries have no measurable usage.
  const incomplete = { auditIncomplete: true as const };
  let listed: ReturnType<UsageSessionSource["listSessions"]>;
  try {
    listed = sessions.listSessions({ kind: "all" });
  } catch {
    return { ...computeUsageSummary(entries, now), ...incomplete };
  }
  for (const { id } of listed) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    let messages: unknown[] | null;
    try {
      messages = sessions.loadSession(id);
    } catch {
      continue;
    }
    for (const message of messages ?? []) {
      if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.meta)) continue;
      const { createdAt, messageId, turnSummary } = message.meta;
      if (!validTokens(createdAt) || !isRecord(turnSummary)) continue;
      const ts = new Date(createdAt);
      if (!Number.isFinite(ts.getTime())) continue;
      const date = localDateKey(ts);
      if (date < opts.dateFrom || date > opts.dateTo) continue;
      if (typeof messageId === "string" && messageId.length > 0) {
        if (counted.has(messageId)) continue;
        counted.add(messageId);
      }
      entries.push(toUsageTurn(id, ts.toISOString(), turnSummary));
    }
  }
  return { ...computeUsageSummary(entries, now), ...incomplete };
}

export function computeMonthlyProjection(trend: UsageTrendPoint[]): number | undefined {
  const dailyAverage = averageDailyCost(trend);
  if (dailyAverage === undefined) return undefined;
  const projection = dailyAverage * 30;
  return Number.isFinite(projection) ? projection : undefined;
}

export function getUsageSummary(
  sessions: UsageSessionSource,
  days: number = 60,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const today = localDateKey(now);
  return getUsageRange(sessions, { dateFrom: shiftLocalDateKey(today, -days), dateTo: today }, now);
}

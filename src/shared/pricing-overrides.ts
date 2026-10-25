/** Normalize settings rows and the deployed environment map to one list before validation, merging, and cache signing. */

/** Only billed rates are correctable; context capacity drives compaction and must remain a model capability fact. */
export interface PricingOverride {
  vendor: string;
  model: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

const OPTIONAL_PRICING_OVERRIDE_RATES = [
  "cacheReadPer1M",
  "cacheWritePer1M",
] as const;

/** Rates must be finite and non-negative; zero means free, not unknown. The editor shares this check before saving. */
export function isPricingOverrideRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeOne(input: unknown): PricingOverride | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const vendor = typeof obj.vendor === "string" ? obj.vendor.trim() : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  if (vendor === "" || model === "") return undefined;
  if (!isPricingOverrideRate(obj.inputPer1M) || !isPricingOverrideRate(obj.outputPer1M)) return undefined;
  const entry: PricingOverride = {
    vendor,
    model,
    inputPer1M: obj.inputPer1M,
    outputPer1M: obj.outputPer1M,
  };
  for (const key of OPTIONAL_PRICING_OVERRIDE_RATES) {
    const value = obj[key];
    if (isPricingOverrideRate(value)) entry[key] = value;
  }
  return entry;
}

/** Drop malformed rows independently so one bad row cannot reset valid corrections; later vendor/model duplicates win. */
export function normalizePricingOverrides(value: unknown): PricingOverride[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, PricingOverride>();
  for (const raw of value) {
    const entry = normalizeOne(raw);
    if (entry) byKey.set(`${entry.vendor}\u0000${entry.model}`, entry);
  }
  return [...byKey.values()];
}

/** Invalid environment JSON falls back to list prices, never zero cost. */
export function parsePricingOverrideEnv(raw: string | undefined): PricingOverride[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const flattened: unknown[] = [];
  for (const [vendor, models] of Object.entries(parsed as Record<string, unknown>)) {
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [model, rates] of Object.entries(models as Record<string, unknown>)) {
      if (!rates || typeof rates !== "object" || Array.isArray(rates)) continue;
      flattened.push({ ...(rates as Record<string, unknown>), vendor, model });
    }
  }
  return normalizePricingOverrides(flattened);
}

/** Use whole-list precedence so the settings table cannot show a mixture of active and overridden rows. */
export function resolvePricingOverrides(
  setting: readonly PricingOverride[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): readonly PricingOverride[] {
  const fromEnv = parsePricingOverrideEnv(env.AVE_PRICING_OVERRIDE);
  if (fromEnv.length > 0) return fromEnv;
  return setting ?? [];
}

/** Price corrections invalidate usage aggregation; row order alone must not change the cache signature. */
export function pricingOverridesSignature(overrides: readonly PricingOverride[]): string {
  return JSON.stringify(
    [...overrides]
      .map((entry) => [
        entry.vendor,
        entry.model,
        entry.inputPer1M,
        entry.outputPer1M,
        entry.cacheReadPer1M ?? null,
        entry.cacheWritePer1M ?? null,
      ])
      .sort((left, right) => String(left).localeCompare(String(right))),
  );
}

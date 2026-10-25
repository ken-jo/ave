/** Normalize deterministically; invalid computational types drop the model, while unknown descriptive or enum values drop only that field. */
import {
  REASONING_EFFORT_VALUES,
  type CatalogCostTier,
  type CatalogModel,
  type CatalogModelCost,
  type CatalogModelReasoning,
  type CatalogProvider,
  type ReasoningEffortValue,
} from "./types.js";

/** A window or completion limit above this is a malformed record, not a model. */
const MAX_CATALOG_TOKEN_LIMIT = 100_000_000;
/** A per-million price above this is a malformed record. */
const MAX_PRICE_PER_MILLION = 100_000;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 200;
const MAX_MODALITIES = 16;

export interface CatalogDiagnostic {
  provider: string;
  model?: string;
  message: string;
}

export interface NormalizedProviders {
  providers: Record<string, CatalogProvider>;
  diagnostics: CatalogDiagnostic[];
}

class Malformed extends Error {}

/** Records a dropped field or value; the model itself is kept. */
type Note = (message: string) => void;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown, field: string, max = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Malformed(`${field} is not a short string`);
  return value;
}

/** A descriptive string: a bad one is dropped and noted, not fatal. */
function descriptiveString(value: unknown, field: string, max: number, note: Note): string | undefined {
  try {
    return optionalString(value, field, max);
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    note(`${field} dropped: ${error.message}`);
    return undefined;
  }
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Malformed(`${field} is not a boolean`);
  return value;
}

/** Zero and absent limits mean unstated, not a model incapable of output. */
function optionalLimit(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_CATALOG_TOKEN_LIMIT) {
    throw new Malformed(`${field} is not a token count`);
  }
  return value === 0 ? undefined : value;
}

/** Retain a listed zero as source data; consumers must not infer free usage. */
function optionalPrice(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PRICE_PER_MILLION) {
    throw new Malformed(`${field} is not a price`);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_MODALITIES || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 32)) {
    throw new Malformed(`${field} is not a list of names`);
  }
  return [...(value as string[])];
}

function rates(source: Record<string, unknown>, field: string): Omit<CatalogCostTier, "afterInputTokens"> {
  const out: Omit<CatalogCostTier, "afterInputTokens"> = {};
  const input = optionalPrice(source.input, `${field}.input`);
  const output = optionalPrice(source.output, `${field}.output`);
  const cacheRead = optionalPrice(source.cache_read, `${field}.cache_read`);
  const cacheWrite = optionalPrice(source.cache_write, `${field}.cache_write`);
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  return out;
}

function cost(value: unknown): CatalogModelCost | undefined {
  if (value === undefined) return undefined;
  const source = record(value);
  if (!source) throw new Malformed("cost is not an object");
  const out: CatalogModelCost = { ...rates(source, "cost") };
  const reasoning = optionalPrice(source.reasoning, "cost.reasoning");
  if (reasoning !== undefined) out.reasoning = reasoning;
  const tiers: CatalogCostTier[] = [];
  if (source.tiers !== undefined) {
    if (!Array.isArray(source.tiers)) throw new Malformed("cost.tiers is not a list");
    for (const [index, raw] of source.tiers.entries()) {
      const tier = record(raw);
      const shape = record(tier?.tier);
      if (!tier || !shape) throw new Malformed(`cost.tiers[${index}] is not a tier`);
      // Unsupported tier kinds leave only base rates.
      if (shape.type !== "context") continue;
      const size = optionalLimit(shape.size, `cost.tiers[${index}].tier.size`);
      if (size === undefined) throw new Malformed(`cost.tiers[${index}].tier.size is missing`);
      tiers.push({ afterInputTokens: size, ...rates(tier, `cost.tiers[${index}]`) });
    }
  }
  if (tiers.length === 0 && source.context_over_200k !== undefined) {
    const over = record(source.context_over_200k);
    if (!over) throw new Malformed("cost.context_over_200k is not an object");
    tiers.push({ afterInputTokens: 200_000, ...rates(over, "cost.context_over_200k") });
  }
  if (tiers.length > 0) out.tiers = tiers.sort((a, b) => a.afterInputTokens - b.afterInputTokens);
  return Object.keys(out).length > 0 ? out : undefined;
}

function reasoning(model: Record<string, unknown>, note: Note): CatalogModelReasoning | undefined {
  const supported = optionalBoolean(model.reasoning, "reasoning");
  if (supported === undefined) return undefined;
  const out: CatalogModelReasoning = { supported };
  if (model.reasoning_options === undefined) return out;
  if (!supported) throw new Malformed("reasoning_options on a model without reasoning");
  if (!Array.isArray(model.reasoning_options)) throw new Malformed("reasoning_options is not a list");
  for (const [index, raw] of model.reasoning_options.entries()) {
    const option = record(raw);
    const field = `reasoning_options[${index}]`;
    if (!option) throw new Malformed(`${field} is not an object`);
    if (option.type === "toggle") {
      out.toggle = true;
    } else if (option.type === "effort") {
      if (!Array.isArray(option.values)) throw new Malformed(`${field}.values is not a list`);
      const values: ReasoningEffortValue[] = [];
      for (const value of option.values) {
        // The source schema admits `null` (and the string "null") for "no explicit effort".
        if (value === null || value === "null") continue;
        if (!(REASONING_EFFORT_VALUES as readonly unknown[]).includes(value)) {
          note(`${field}.values: unknown effort ${JSON.stringify(value)} dropped`);
          continue;
        }
        if (!values.includes(value as ReasoningEffortValue)) values.push(value as ReasoningEffortValue);
      }
      if (values.length > 0) out.effort = values;
    } else if (option.type === "budget_tokens") {
      // The source admits -1 as a minimum ("dynamic budget"); only positive bounds are bounds.
      if (option.min !== undefined && typeof option.min !== "number") throw new Malformed(`${field}.min is not a number`);
      const min = typeof option.min === "number" && option.min > 0 ? optionalLimit(option.min, `${field}.min`) : undefined;
      const max = optionalLimit(option.max, `${field}.max`);
      out.budgetTokens = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    } else {
      note(`${field}: unknown control ${JSON.stringify(option.type)} dropped`);
    }
  }
  return out;
}

function interleaved(value: unknown): CatalogModel["interleaved"] {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  const object = record(value);
  const field = optionalString(object?.field, "interleaved.field", 64);
  if (!field) throw new Malformed("interleaved is neither a boolean nor a field");
  return { field };
}

function status(value: unknown, note: Note): CatalogModel["status"] {
  if (value === undefined) return undefined;
  if (value === "alpha" || value === "beta" || value === "deprecated") return value;
  note(`status ${JSON.stringify(value)} dropped`);
  return undefined;
}

function normalizeModel(key: string, raw: unknown, note: Note): CatalogModel {
  const model = record(raw);
  if (!model) throw new Malformed("not an object");
  const id = optionalString(model.id, "id", MAX_ID_LENGTH);
  if (id === undefined) throw new Malformed("id is missing");
  if (id !== key) throw new Malformed("id does not match its key");
  const limit = record(model.limit);
  if (model.limit !== undefined && !limit) throw new Malformed("limit is not an object");
  const limits: CatalogModel["limits"] = {};
  const context = optionalLimit(limit?.context, "limit.context");
  const input = optionalLimit(limit?.input, "limit.input");
  const output = optionalLimit(limit?.output, "limit.output");
  if (context !== undefined) limits.context = context;
  if (input !== undefined) limits.input = input;
  if (output !== undefined) limits.output = output;
  const out: CatalogModel = { id, limits };
  const name = descriptiveString(model.name, "name", MAX_TEXT_LENGTH, note);
  const family = descriptiveString(model.family, "family", 64, note);
  const canonicalId = optionalString(model.canonical_model_id, "canonical_model_id", MAX_ID_LENGTH);
  if (name !== undefined && name !== id) out.name = name;
  if (family !== undefined) out.family = family;
  if (canonicalId !== undefined) out.canonicalId = canonicalId;
  if (model.modalities !== undefined) {
    const modalities = record(model.modalities);
    if (!modalities) throw new Malformed("modalities is not an object");
    out.modalities = {
      input: stringList(modalities.input, "modalities.input"),
      output: stringList(modalities.output, "modalities.output"),
    };
  }
  const attachment = optionalBoolean(model.attachment, "attachment");
  const toolCall = optionalBoolean(model.tool_call, "tool_call");
  const structuredOutput = optionalBoolean(model.structured_output, "structured_output");
  const temperature = optionalBoolean(model.temperature, "temperature");
  if (attachment !== undefined) out.attachment = attachment;
  if (toolCall !== undefined) out.toolCall = toolCall;
  if (structuredOutput !== undefined) out.structuredOutput = structuredOutput;
  if (temperature !== undefined) out.temperature = temperature;
  const reasoned = reasoning(model, note);
  if (reasoned) out.reasoning = reasoned;
  const interleave = interleaved(model.interleaved);
  if (interleave) out.interleaved = interleave;
  const priced = cost(model.cost);
  if (priced) out.cost = priced;
  const state = status(model.status, note);
  if (state) out.status = state;
  const released = descriptiveString(model.release_date, "release_date", 10, note);
  if (released !== undefined) out.releaseDate = released;
  return out;
}

/** Report missing providers instead of inventing them; refresh decides whether provider loss is acceptable. */
export function normalizeModelsDevProviders(document: unknown, providerIds: readonly string[]): NormalizedProviders {
  const root = record(document);
  if (!root) throw new Error("models.dev document is not an object");
  const providers: Record<string, CatalogProvider> = {};
  const diagnostics: CatalogDiagnostic[] = [];
  for (const providerId of [...providerIds].sort()) {
    const provider = record(root[providerId]);
    const models = record(provider?.models);
    if (!provider || !models) {
      diagnostics.push({ provider: providerId, message: "provider is missing or has no models" });
      continue;
    }
    const normalized: Record<string, CatalogModel> = {};
    for (const key of Object.keys(models).sort()) {
      const note: Note = (message) => diagnostics.push({ provider: providerId, model: key, message });
      try {
        normalized[key] = normalizeModel(key, models[key], note);
      } catch (error) {
        if (!(error instanceof Malformed)) throw error;
        note(`model dropped: ${error.message}`);
      }
    }
    providers[providerId] = { models: normalized };
  }
  return { providers, diagnostics };
}

/** Pruned generator input must include every field the normalizer reads. */
export const MODELS_DEV_MODEL_FIELDS = [
  "attachment",
  "canonical_model_id",
  "cost",
  "family",
  "id",
  "interleaved",
  "limit",
  "modalities",
  "name",
  "reasoning",
  "reasoning_options",
  "release_date",
  "status",
  "structured_output",
  "temperature",
  "tool_call",
] as const;

/** Keep model fields and provider endpoints only; host-owned package and environment metadata stay excluded. */
export function pruneModelsDevDocument(
  document: unknown,
  providerIds: readonly string[],
): Record<string, { api?: string; models: Record<string, unknown> }> {
  const root = record(document);
  if (!root) throw new Error("models.dev document is not an object");
  const pruned: Record<string, { api?: string; models: Record<string, unknown> }> = {};
  for (const providerId of [...providerIds].sort()) {
    const provider = record(root[providerId]);
    const models = record(provider?.models);
    if (!models) continue;
    // Preserve endpoints so tests can verify native-host provider mappings.
    const api = typeof provider?.api === "string" ? provider.api : undefined;
    const kept: Record<string, unknown> = {};
    for (const key of Object.keys(models).sort()) {
      const model = record(models[key]);
      if (!model) {
        // Kept as-is so the normalizer reports it; pruning must not hide a fault.
        kept[key] = models[key];
        continue;
      }
      const fields: Record<string, unknown> = {};
      for (const field of MODELS_DEV_MODEL_FIELDS) if (model[field] !== undefined) fields[field] = model[field];
      kept[key] = fields;
    }
    pruned[providerId] = { ...(api !== undefined ? { api } : {}), models: kept };
  }
  return pruned;
}

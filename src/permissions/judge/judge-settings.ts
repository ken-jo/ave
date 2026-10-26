// An empty chain is off; configured chains default to audit-only shadow until explicitly activated. Migrate single-provider settings to one stage; only the user may write this subtree, never the agent.
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { classifyAddress } from "../../core/network-guard.js";
import { isLLMVendor, llmVendorModelOptions, type LLMVendor } from "../../shared/llm-vendor-defaults.js";
import type { JudgeCategory } from "./judge-contract.js";
import { MAX_PERMISSION_JUDGE_STAGES } from "../../shared/permission-judge-settings.js";
import { JUDGE_BLOCK_THRESHOLDS } from "./judge-breaker.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

// Settings path of the subtree. The write floor is enforced outside this module: agent file and shell writes to `~/.ave/config/settings.json` hit the sensitive-path floor, and the only writer is the user-keyboard-gated Settings IPC in `src/ipc/domains/permission-judge.ts`.
const JUDGE_SETTINGS_KEY = "permissions.judge";

const JUDGE_STAGE_PROVIDERS = ["builtin-llm", "external"] as const;
type JudgeStageProvider = (typeof JUDGE_STAGE_PROVIDERS)[number];

// Legacy single-provider values, accepted only for migration.
const LEGACY_PROVIDERS = ["off", ...JUDGE_STAGE_PROVIDERS] as const;

const JUDGE_MODES = ["shadow", "active"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export interface JudgeExternalSettings {
  // argv array; argv[0] must be an absolute path. Run without a shell.
  command?: readonly string[];
  // HTTPS URL, or HTTP on a loopback host only.
  url?: string;
  // Extra environment variable NAMES forwarded to the command judge on top of the minimal base set. Ave's own variables and credential names are refused.
  env?: readonly string[];
}

// A chat-picker model: vendor plus a model id the picker offers for it.
export interface JudgeModelRef {
  vendor: LLMVendor;
  model: string;
}

export interface JudgeStageSettings {
  provider: JudgeStageProvider;
  // Stage id recorded in the audit, unique within the chain (e.g. `jev`).
  id: string;
  // Confidence threshold in [0, 1]. A verdict whose confidence is below it — or that reports no confidence — escalates to the next stage.
  escalateBelow?: number;
  // builtin-llm only. Absent = the permission reviewer model (`JudgeSettings.model`, else the active chat model).
  model?: JudgeModelRef;
  // external only.
  external?: JudgeExternalSettings;
}

export interface JudgeBreakerSettings {
  // Consecutive judge denials per session that pause automation.
  consecutive: number;
  // Total judge denials per session that pause automation.
  total: number;
}

export interface JudgeSettings {
  // The permission reviewer's model, picked by the user from the connected models. `null` is the explicit "unset" state: the reviewer runs on the active chat model and follows it when chat switches. Never resolved to a fixed default here; the host resolves it each time it wires the reviewer.
  model: JudgeModelRef | null;
  // Ordered stages; empty = off.
  chain: JudgeStageSettings[];
  mode: JudgeMode;
  categories: Record<JudgeCategory, boolean>;
  // Per-stage timeout.
  timeoutMs: number;
  // Whole-chain deadline; exceeding it is a failure and the fallback applies.
  chainDeadlineMs: number;
  breaker: JudgeBreakerSettings;
}

export const DEFAULT_JUDGE_SETTINGS: Readonly<JudgeSettings> = Object.freeze({
  model: null,
  chain: Object.freeze([]) as unknown as JudgeStageSettings[],
  mode: "shadow",
  categories: Object.freeze({ shell: true, write: true, network: false }),
  timeoutMs: TOOL_TIMEOUT_POLICY.reviewerHttpTimeoutMs,
  chainDeadlineMs: 60_000,
  breaker: JUDGE_BLOCK_THRESHOLDS,
}) as Readonly<JudgeSettings>;

const TIMEOUT_MIN_MS = 500;
const TIMEOUT_MAX_MS = 120_000;
const CHAIN_DEADLINE_MIN_MS = 1_000;
const CHAIN_DEADLINE_MAX_MS = 600_000;
const STAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export class JudgeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeSettingsError";
  }
}

// Returns an error message, or null when the command is acceptable.
export function checkExternalCommand(command: unknown): string | null {
  if (!Array.isArray(command) || command.length === 0) {
    return "external.command must be a non-empty argv array";
  }
  if (!command.every((part) => typeof part === "string" && part.length > 0 && !part.includes("\0"))) {
    return "external.command entries must be non-empty strings without NUL";
  }
  if (!isAbsolute(command[0] as string)) {
    return "external.command[0] must be an absolute executable path";
  }
  return null;
}

function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare.toLowerCase() === "localhost") return true;
  if (isIP(bare) === 0) return false;
  // `this-computer` also covers 0.0.0.0/8 and `::`; only real loopback is accepted.
  if (bare.startsWith("0.") || bare === "::") return false;
  return classifyAddress(bare) === "this-computer";
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Never forwarded to an external judge: Ave / Electron runtime variables and well-known credential names.
const REFUSED_ENV_NAMES: readonly RegExp[] = [
  /^(AVE|ELECTRON)_/i,
  /_(API_KEY|TOKEN|SECRET|PASSWORD)$/i,
  /^AWS_/i,
  /^GITHUB_TOKEN$/i,
  /^(ANTHROPIC|OPENAI)_/i,
];

// Returns an error message, or null when the env name list is acceptable.
export function checkExternalEnv(env: unknown): string | null {
  if (!Array.isArray(env)) return "external.env must be an array of variable names";
  for (const name of env) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) return `external.env name invalid: '${String(name)}'`;
    if (REFUSED_ENV_NAMES.some((re) => re.test(name))) {
      return `external.env must not forward Ave runtime or credential variable '${name}'`;
    }
  }
  return null;
}

// Returns an error message, or null when the URL is acceptable.
export function checkExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return "external.url must be a non-empty string";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "external.url is not a valid URL";
  }
  if (url.username || url.password) return "external.url must not embed credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return null;
  return "external.url must be https, or http on a loopback host";
}

function checkExternal(external: unknown): { value?: JudgeExternalSettings; error?: string } {
  if (!external || typeof external !== "object" || Array.isArray(external)) {
    return { error: "provider 'external' requires an external { command | url } block" };
  }
  const obj = external as Record<string, unknown>;
  const hasCommand = obj.command !== undefined;
  const hasUrl = obj.url !== undefined;
  if (hasCommand === hasUrl) return { error: "external must set exactly one of command or url" };
  if (hasCommand) {
    const err = checkExternalCommand(obj.command) ?? (obj.env === undefined ? null : checkExternalEnv(obj.env));
    if (err) return { error: err };
    return {
      value: {
        command: [...(obj.command as string[])],
        ...(obj.env === undefined ? {} : { env: [...(obj.env as string[])] }),
      },
    };
  }
  if (obj.env !== undefined) return { error: "external.env applies to the command transport only" };
  const err = checkExternalUrl(obj.url);
  return err ? { error: err } : { value: { url: obj.url as string } };
}

function intInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The models the chat model picker offers, per provider.
export interface JudgeModelCatalog {
  optionsFor(vendor: LLMVendor): readonly string[];
}

// Static-only catalog, for callers that have no live `llm` settings (tests, schema checks).
const STATIC_JUDGE_MODEL_CATALOG: JudgeModelCatalog = {
  optionsFor: (vendor) => llmVendorModelOptions(vendor),
};

// Parse `<vendor>/<model>` (split on the FIRST slash; model ids may contain slashes) and check it against the chat model picker's option list.
function parseJudgeModel(
  raw: unknown,
  catalog: JudgeModelCatalog = STATIC_JUDGE_MODEL_CATALOG,
): { value?: JudgeModelRef; error?: string } {
  if (typeof raw !== "string" || raw.length === 0) return { error: "model must be a '<provider>/<model>' string" };
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return { error: `model '${raw}' must be '<provider>/<model>'` };
  const vendor = raw.slice(0, slash);
  const model = raw.slice(slash + 1);
  if (!isLLMVendor(vendor)) return { error: `model provider '${vendor}' is not a configured LLM provider` };
  if (!catalog.optionsFor(vendor).includes(model)) {
    return { error: `model '${model}' is not offered for provider '${vendor}' by the model picker` };
  }
  return { value: { vendor, model } };
}

export function formatJudgeModel(ref: JudgeModelRef): string {
  return `${ref.vendor}/${ref.model}`;
}

const STAGE_KEYS = new Set(["provider", "id", "escalateBelow", "model", "external"]);

function parseStage(raw: unknown, index: number, catalog: JudgeModelCatalog): { value?: JudgeStageSettings; error?: string } {
  const at = `chain[${index}]`;
  if (!isPlainObject(raw)) return { error: `${at} must be an object` };
  const extra = Object.keys(raw).filter((k) => !STAGE_KEYS.has(k));
  if (extra.length > 0) return { error: `${at} has unknown keys: ${extra.join(", ")}` };
  if (!(JUDGE_STAGE_PROVIDERS as readonly unknown[]).includes(raw.provider)) {
    return { error: `${at}.provider must be one of ${JUDGE_STAGE_PROVIDERS.join(" | ")}` };
  }
  const provider = raw.provider as JudgeStageProvider;
  const id = raw.id === undefined ? provider : raw.id;
  if (typeof id !== "string" || !STAGE_ID.test(id)) return { error: `${at}.id invalid: '${String(id)}'` };
  const stage: JudgeStageSettings = { provider, id };
  if (raw.escalateBelow !== undefined) {
    const t = raw.escalateBelow;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
      return { error: `${at}.escalateBelow must be a number in [0, 1]` };
    }
    stage.escalateBelow = t;
  }
  if (provider === "builtin-llm") {
    if (raw.external !== undefined) return { error: `${at}.external applies to provider 'external' only` };
    // The builtin reviewer reports a risk level, never a confidence, so a threshold could never be met.
    if (raw.escalateBelow !== undefined) {
      return { error: `${at} (stage '${id}').escalateBelow is not supported by builtin-llm (it reports no confidence)` };
    }
    if (raw.model !== undefined) {
      const { value, error } = parseJudgeModel(raw.model, catalog);
      if (error) return { error: `${at}.${error}` };
      stage.model = value;
    }
  } else {
    if (raw.model !== undefined) return { error: `${at}.model applies to provider 'builtin-llm' only` };
    const { value, error } = checkExternal(raw.external);
    if (error) return { error: `${at}: ${error}` };
    stage.external = value;
  }
  return { value: stage };
}

// Parse a chain array; any invalid stage invalidates the whole chain.
function parseChain(raw: unknown, catalog: JudgeModelCatalog): { value?: JudgeStageSettings[]; error?: string } {
  if (!Array.isArray(raw)) return { error: "chain must be an array of stages" };
  if (raw.length > MAX_PERMISSION_JUDGE_STAGES) return { error: `chain allows at most ${MAX_PERMISSION_JUDGE_STAGES} stages` };
  const stages: JudgeStageSettings[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const { value, error } = parseStage(raw[i], i, catalog);
    if (error || !value) return { error };
    if (ids.has(value.id)) return { error: `chain stage id '${value.id}' is duplicated` };
    ids.add(value.id);
    stages.push(value);
  }
  return { value: stages };
}

// Legacy `{ provider, external? }` → chain.
function migrateLegacyProvider(obj: Record<string, unknown>, catalog: JudgeModelCatalog): { value?: JudgeStageSettings[]; error?: string } {
  if (!(LEGACY_PROVIDERS as readonly unknown[]).includes(obj.provider)) {
    return { error: `provider invalid: '${String(obj.provider)}'` };
  }
  if (obj.provider === "off") {
    return obj.external === undefined ? { value: [] } : { error: "external is set but provider is 'off'" };
  }
  return parseChain([{ provider: obj.provider, ...(obj.external !== undefined ? { external: obj.external } : {}) }], catalog);
}

function defaults(): JudgeSettings {
  return {
    model: null,
    chain: [],
    mode: DEFAULT_JUDGE_SETTINGS.mode,
    categories: { ...DEFAULT_JUDGE_SETTINGS.categories },
    timeoutMs: DEFAULT_JUDGE_SETTINGS.timeoutMs,
    chainDeadlineMs: DEFAULT_JUDGE_SETTINGS.chainDeadlineMs,
    breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker },
  };
}

export interface NormalizedJudgeSettings {
  settings: JudgeSettings;
  issues: string[];
  // The supplied chain could not be accepted; an empty chain is not an explicit off choice.
  chainRejected?: true;
  // True when the legacy single-provider form was read; the caller persists the chain form.
  migrated: boolean;
  // A reviewer model is configured but is not one the connected providers offer. The reviewer must then fail as unavailable; it never substitutes the chat model or any other model for the user's choice.
  modelRejected?: true;
  // A rejected reviewer model that is still a well-formed `<provider>/<model>`, for display.
  rejectedModel?: JudgeModelRef;
}

// Read path: settings file content is user input. Each invalid field falls back to its default and is reported in `issues` so the caller can surface it. An invalid chain resolves to an empty chain plus `chainRejected`; the host applies unavailable behavior under the normalized mode. It never adopts a partial chain or a different provider.
export function normalizeJudgeSettings(
  parsed: unknown,
  catalog: JudgeModelCatalog = STATIC_JUDGE_MODEL_CATALOG,
): NormalizedJudgeSettings {
  const settings = defaults();
  const issues: string[] = [];
  let migrated = false;
  let chainRejected = false;
  if (parsed === undefined) return { settings, issues, migrated };
  if (!isPlainObject(parsed)) {
    issues.push(`${JUDGE_SETTINGS_KEY} must be an object`);
    return { settings, issues, migrated, chainRejected: true };
  }
  const obj = parsed;

  const hasChain = obj.chain !== undefined;
  const hasLegacy = obj.provider !== undefined || obj.external !== undefined;
  if (hasChain && hasLegacy) {
    issues.push("set either chain or the legacy provider/external fields, not both; judge disabled");
    chainRejected = true;
  } else if (hasChain || hasLegacy) {
    const { value, error } = hasChain ? parseChain(obj.chain, catalog) : migrateLegacyProvider(obj, catalog);
    if (error || !value) {
      issues.push(`${error ?? "chain invalid"}; judge disabled`);
      chainRejected = true;
    }
    else {
      settings.chain = value;
      migrated = hasLegacy;
    }
  }
  let modelRejected = false;
  let rejectedModel: JudgeModelRef | undefined;
  if (obj.model !== undefined && obj.model !== null) {
    const { value, error } = parseJudgeModel(obj.model, catalog);
    if (error || !value) {
      issues.push(`${error ?? "model invalid"}; permission reviewer unavailable`);
      modelRejected = true;
      const wellFormed = parseJudgeModel(obj.model, { optionsFor: () => [String(obj.model).slice(String(obj.model).indexOf("/") + 1)] });
      if (wellFormed.value) rejectedModel = wellFormed.value;
    } else {
      settings.model = value;
    }
  }
  if (obj.mode !== undefined) {
    if ((JUDGE_MODES as readonly unknown[]).includes(obj.mode)) settings.mode = obj.mode as JudgeMode;
    else issues.push(`mode invalid: '${String(obj.mode)}'`);
  }
  if (obj.categories !== undefined) {
    if (isPlainObject(obj.categories)) {
      const cats = obj.categories;
      for (const key of Object.keys(settings.categories) as JudgeCategory[]) {
        if (cats[key] === undefined) continue;
        if (typeof cats[key] === "boolean") settings.categories[key] = cats[key] as boolean;
        else issues.push(`categories.${key} must be boolean`);
      }
    } else {
      issues.push("categories must be an object");
    }
  }
  if (obj.timeoutMs !== undefined) {
    const v = intInRange(obj.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
    if (v !== null) settings.timeoutMs = v;
    else issues.push(`timeoutMs must be an integer in [${TIMEOUT_MIN_MS}, ${TIMEOUT_MAX_MS}]`);
  }
  if (obj.chainDeadlineMs !== undefined) {
    const v = intInRange(obj.chainDeadlineMs, CHAIN_DEADLINE_MIN_MS, CHAIN_DEADLINE_MAX_MS);
    if (v !== null) settings.chainDeadlineMs = v;
    else issues.push(`chainDeadlineMs must be an integer in [${CHAIN_DEADLINE_MIN_MS}, ${CHAIN_DEADLINE_MAX_MS}]`);
  }
  if (obj.breaker !== undefined) {
    if (!isPlainObject(obj.breaker) ||
        (obj.breaker.consecutive !== undefined && obj.breaker.consecutive !== JUDGE_BLOCK_THRESHOLDS.consecutive) ||
        (obj.breaker.total !== undefined && obj.breaker.total !== JUDGE_BLOCK_THRESHOLDS.total)) {
      issues.push("breaker thresholds must be 3 consecutive or 20 total");
      chainRejected = true;
    }
  }
  return {
    settings, issues, migrated,
    ...(chainRejected ? { chainRejected: true as const } : {}),
    ...(modelRejected ? { modelRejected: true as const } : {}),
    ...(rejectedModel ? { rejectedModel } : {}),
  };
}

// Write path (Settings UI patch): any invalid field is a clear error, nothing is coerced. Returns the validated settings to persist (always the chain form).
export function validateJudgeSettings(
  patch: unknown,
  catalog: JudgeModelCatalog = STATIC_JUDGE_MODEL_CATALOG,
): JudgeSettings {
  const { settings, issues } = normalizeJudgeSettings(patch, catalog);
  if (issues.length > 0) {
    throw new JudgeSettingsError(`${JUDGE_SETTINGS_KEY} invalid: ${issues.join("; ")}`);
  }
  return settings;
}

export { serializePermissionJudgeSettings as serializeJudgeSettings } from "../../shared/permission-judge-settings.js";

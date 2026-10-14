/**
 * `permissions.judge` settings block (issue #28 P2).
 *
 * Default provider is `off` — today's behavior, no automated judge. When a
 * provider is chosen the mode defaults to `shadow` (the judge runs and is
 * audited, the user still decides) until the user explicitly selects `active`.
 *
 * The whole `permissions.judge` subtree is a floor: the agent never writes it.
 * Only the user (Settings UI / hand edit) may change it.
 */
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { classifyAddress } from "../../core/network-guard.js";
import type { JudgeCategory } from "./judge-contract.js";

/** Settings path of the subtree. Enforcement as a write floor lives with the P1 floors list. */
export const JUDGE_SETTINGS_KEY = "permissions.judge";

export const JUDGE_PROVIDERS = ["off", "builtin-llm", "external"] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

export const JUDGE_MODES = ["shadow", "active"] as const;
export type JudgeMode = (typeof JUDGE_MODES)[number];

export interface JudgeExternalSettings {
  /** argv array; argv[0] must be an absolute path. Run without a shell. */
  command?: readonly string[];
  /** HTTPS URL, or HTTP on a loopback host only. */
  url?: string;
  /**
   * Extra environment variable NAMES forwarded to the command judge on top of
   * the minimal base set. Ave's own variables are refused.
   */
  env?: readonly string[];
}

export interface JudgeBreakerSettings {
  /** Consecutive judge denials per session that pause automation. */
  consecutive: number;
  /** Total judge denials per session that pause automation. */
  total: number;
}

export interface JudgeSettings {
  provider: JudgeProvider;
  mode: JudgeMode;
  categories: Record<JudgeCategory, boolean>;
  timeoutMs: number;
  breaker: JudgeBreakerSettings;
  external?: JudgeExternalSettings;
}

export const DEFAULT_JUDGE_SETTINGS: Readonly<JudgeSettings> = Object.freeze({
  provider: "off",
  mode: "shadow",
  categories: Object.freeze({ shell: true, write: true, network: false }),
  timeoutMs: 15_000,
  breaker: Object.freeze({ consecutive: 3, total: 20 }),
}) as Readonly<JudgeSettings>;

const TIMEOUT_MIN_MS = 500;
const TIMEOUT_MAX_MS = 120_000;
const BREAKER_MAX = 1_000;

export class JudgeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeSettingsError";
  }
}

/** Returns an error message, or null when the command is acceptable. */
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
/** Ave / Electron runtime variables are never handed to an external judge. */
const REFUSED_ENV_PREFIX = /^(AVE|RETIREDNAME|ELECTRON)_/i;

/** Returns an error message, or null when the env name list is acceptable. */
export function checkExternalEnv(env: unknown): string | null {
  if (!Array.isArray(env)) return "external.env must be an array of variable names";
  for (const name of env) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) return `external.env name invalid: '${String(name)}'`;
    if (REFUSED_ENV_PREFIX.test(name)) return `external.env must not forward Ave runtime variable '${name}'`;
  }
  return null;
}

/** Returns an error message, or null when the URL is acceptable. */
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

function defaults(): JudgeSettings {
  return {
    provider: DEFAULT_JUDGE_SETTINGS.provider,
    mode: DEFAULT_JUDGE_SETTINGS.mode,
    categories: { ...DEFAULT_JUDGE_SETTINGS.categories },
    timeoutMs: DEFAULT_JUDGE_SETTINGS.timeoutMs,
    breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker },
  };
}

/**
 * Read path: settings file content is user input. Each invalid field falls back
 * to its default and is reported in `issues` so the caller can surface it. An
 * external provider without a valid endpoint resolves to `off` (no automation),
 * never to a different provider.
 */
export function normalizeJudgeSettings(parsed: unknown): { settings: JudgeSettings; issues: string[] } {
  const settings = defaults();
  const issues: string[] = [];
  if (parsed === undefined) return { settings, issues };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push(`${JUDGE_SETTINGS_KEY} must be an object`);
    return { settings, issues };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.provider !== undefined) {
    if ((JUDGE_PROVIDERS as readonly unknown[]).includes(obj.provider)) settings.provider = obj.provider as JudgeProvider;
    else issues.push(`provider invalid: '${String(obj.provider)}'`);
  }
  if (obj.mode !== undefined) {
    if ((JUDGE_MODES as readonly unknown[]).includes(obj.mode)) settings.mode = obj.mode as JudgeMode;
    else issues.push(`mode invalid: '${String(obj.mode)}'`);
  }
  if (obj.categories !== undefined) {
    if (obj.categories && typeof obj.categories === "object" && !Array.isArray(obj.categories)) {
      const cats = obj.categories as Record<string, unknown>;
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
  if (obj.breaker !== undefined) {
    const b = (obj.breaker && typeof obj.breaker === "object" ? obj.breaker : {}) as Record<string, unknown>;
    const consecutive = b.consecutive === undefined ? settings.breaker.consecutive : intInRange(b.consecutive, 1, BREAKER_MAX);
    const total = b.total === undefined ? settings.breaker.total : intInRange(b.total, 1, BREAKER_MAX);
    if (consecutive === null || total === null || consecutive > total) {
      issues.push(`breaker must be integers 1 ≤ consecutive ≤ total ≤ ${BREAKER_MAX}`);
    } else {
      settings.breaker = { consecutive, total };
    }
  }
  if (settings.provider === "external") {
    const { value, error } = checkExternal(obj.external);
    if (error) {
      issues.push(`${error}; judge provider disabled`);
      settings.provider = "off";
    } else {
      settings.external = value;
    }
  }
  return { settings, issues };
}

/**
 * Write path (Settings UI patch): any invalid field is a clear error, nothing
 * is coerced. Returns the validated settings to persist.
 */
export function validateJudgeSettings(patch: unknown): JudgeSettings {
  const { settings, issues } = normalizeJudgeSettings(patch);
  if (issues.length > 0) {
    throw new JudgeSettingsError(`${JUDGE_SETTINGS_KEY} invalid: ${issues.join("; ")}`);
  }
  return settings;
}

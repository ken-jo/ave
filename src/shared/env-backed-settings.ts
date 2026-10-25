/** Share environment override rules between resolution and UI notices; variables may force on, off, or both. */

import { normalizeShutdownCleanupTimeoutMs } from "./tool-timeout-policy.js";

export interface EnvBackedSetting {
  /** Dotted path into the settings object, as `updateSettings` nests it. */
  readonly settingsPath: string;
  readonly envVar: string;
  /** Undefined means the environment leaves control to settings; forced values retain the setting’s actual type. */
  readonly forcedValue: (envValue: string | undefined) => boolean | string | number | undefined;
}

/** Only the exact opt-in value forces on; other values leave the setting in control. */
function forcesOnAt(onValue: string) {
  return (envValue: string | undefined): boolean | undefined =>
    envValue === onValue ? true : undefined;
}

/** Negative opt-in variables force off rather than on. */
function forcesOffAt(offValue: string) {
  return (envValue: string | undefined): boolean | undefined =>
    envValue === offValue ? false : undefined;
}

/** Unset or blank text leaves settings in control; whitespace is not a usable override. */
function forcesTextWhenNonEmpty(envValue: string | undefined): string | undefined {
  const trimmed = envValue?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

const UPDATE_CHECK_OFF_RE = /^(0|false)$/i;

const USE_CACHE_ON_RE = /^(1|true|yes|on)$/i;

export const ENV_BACKED_SETTINGS: readonly EnvBackedSetting[] = Object.freeze([
  // Loopback and A2A route families opt in independently; outbound and receiver gates cannot widen them.
  { settingsPath: "system.localApiServer", envVar: "AVE_LOCAL_API", forcedValue: forcesOnAt("1") },
  { settingsPath: "features.a2aLoopbackServer", envVar: "AVE_A2A", forcedValue: forcesOnAt("1") },
  { settingsPath: "features.a2aRemoteRouting", envVar: "AVE_A2A_REMOTE", forcedValue: forcesOnAt("1") },
  {
    settingsPath: "features.a2aRemoteReceiver",
    envVar: "AVE_A2A_REMOTE_RECEIVER",
    forcedValue: forcesOnAt("1"),
  },
  // Shell and plugin-worker confinement have independent environment gates.
  { settingsPath: "features.osToolSandbox", envVar: "AVE_SANDBOX_ENABLED", forcedValue: forcesOnAt("1") },
  {
    settingsPath: "features.pluginWorkerConfinement",
    envVar: "AVE_PLUGIN_WORKER_CONFINEMENT",
    forcedValue: forcesOnAt("1"),
  },
  // GPU policy is read before app readiness; edits apply only on next launch.
  { settingsPath: "system.hardwareAcceleration", envVar: "AVE_KEEP_GPU", forcedValue: forcesOnAt("1") },
  // Update-check environment policy can force off only; an on value still respects the setting.
  // Cache policy decides both directions when set; deployment pins outrank saved profiles.
  {
    settingsPath: "marketplace.updateCheckEnabled",
    envVar: "AVE_MARKETPLACE_UPDATE_CHECK",
    forcedValue: (envValue: string | undefined) =>
      envValue !== undefined && UPDATE_CHECK_OFF_RE.test(envValue) ? false : undefined,
  },
  // Corporate CA settings are read before boot, so changes apply on next launch.
  { settingsPath: "system.corpCaEnabled", envVar: "AVE_SKIP_CORP_CA", forcedValue: forcesOffAt("1") },
  { settingsPath: "system.corpCaDebugLog", envVar: "AVE_CORP_CA_DEBUG", forcedValue: forcesOnAt("1") },
  {
    settingsPath: "system.corpCaCommonName",
    envVar: "AVE_CORP_CA_CN",
    forcedValue: forcesTextWhenNonEmpty,
  },
  {
    settingsPath: "telemetry.sentryDsn",
    envVar: "AVE_SENTRY_DSN",
    forcedValue: forcesTextWhenNonEmpty,
  },
  // Report the raw price-correction blob as forced even if parsing yields no entries; parsing owns whole-list precedence.
  {
    settingsPath: "llm.pricingOverrides",
    envVar: "AVE_PRICING_OVERRIDE",
    forcedValue: forcesTextWhenNonEmpty,
  },
  // Numeric environment values must pass the same normalization as settings or fall through.
  {
    settingsPath: "system.shutdownCleanupTimeoutMs",
    envVar: "AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS",
    forcedValue: normalizeShutdownCleanupTimeoutMs,
  },
  {
    settingsPath: "marketplace.offlineCacheEnabled",
    envVar: "AVE_MARKETPLACE_USE_CACHE",
    forcedValue: (envValue: string | undefined) =>
      envValue === undefined ? undefined : USE_CACHE_ON_RE.test(envValue.trim()),
  },
  // Any catalog pin disables refresh; boot refuses pins it cannot honor.
  {
    settingsPath: "llm.modelCatalogRefresh",
    envVar: "AVE_MODEL_CATALOG",
    forcedValue: (envValue: string | undefined) =>
      forcesTextWhenNonEmpty(envValue) === undefined ? undefined : "off",
  },
].map((entry) => Object.freeze(entry)));

const KNOWN_PATHS: ReadonlySet<string> = Object.freeze(
  new Set(ENV_BACKED_SETTINGS.map((entry) => entry.settingsPath)),
);

/** Report only variables whose values actually force known settings, not every set variable. */
export function envForcedSettingsPaths(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return Object.freeze(
    ENV_BACKED_SETTINGS
      .filter((entry) => entry.forcedValue(env[entry.envVar]) !== undefined)
      .map((entry) => entry.settingsPath),
  );
}

/** Resolvers read this rule instead of re-deriving environment precedence. */
export function envForcedValueForSettingsPath(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | string | number | undefined {
  const entry = ENV_BACKED_SETTINGS.find((item) => item.settingsPath === settingsPath);
  if (entry === undefined) return undefined;
  return entry.forcedValue(env[entry.envVar]);
}

/** A type mismatch means not forced, never coercion into another setting type. */
function envForcedBooleanForSettingsPath(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const value = envForcedValueForSettingsPath(settingsPath, env);
  return typeof value === "boolean" ? value : undefined;
}

/** Boolean precedence is forced environment value, saved setting, then default. */
export function resolveEnvBackedBoolean(
  settingsPath: string,
  settingValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fallback = true,
): boolean {
  return envForcedBooleanForSettingsPath(settingsPath, env) ?? settingValue ?? fallback;
}

export function envForcedStringForSettingsPath(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = envForcedValueForSettingsPath(settingsPath, env);
  return typeof value === "string" ? value : undefined;
}

/** Keep forced numeric reads private so callers also apply precedence. */
function envForcedNumberForSettingsPath(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const value = envForcedValueForSettingsPath(settingsPath, env);
  return typeof value === "number" ? value : undefined;
}

/** Numeric precedence is environment, normalized saved value, then default. */
export function resolveEnvBackedNumber(
  settingsPath: string,
  settingValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fallback: number,
): number {
  return envForcedNumberForSettingsPath(settingsPath, env) ?? settingValue ?? fallback;
}

export function envVarForSettingsPath(settingsPath: string): string | null {
  return ENV_BACKED_SETTINGS.find((entry) => entry.settingsPath === settingsPath)?.envVar ?? null;
}

/** Drop unknown IPC paths so renderer notices describe only settings this build recognizes. */
export function parseEnvForcedSettingsPaths(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const paths = value.filter(
    (item): item is string => typeof item === "string" && KNOWN_PATHS.has(item),
  );
  return Object.freeze(paths);
}

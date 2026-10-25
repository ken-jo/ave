/** Keep pre-boot CA precedence independent of settings-store runtime dependencies. */
import {
  envForcedStringForSettingsPath,
  resolveEnvBackedBoolean,
} from "./env-backed-settings.js";
import {
  DEFAULT_CORP_CA_COMMON_NAME,
  normalizeCorpCaCommonName,
} from "./corp-ca-common-name.js";

export interface CorpCaConfig {
  readonly enabled: boolean;
  readonly commonName: string;
  readonly debugLog: boolean;
}

export interface CorpCaSettings {
  readonly enabled?: boolean;
  readonly commonName?: string;
  readonly debugLog?: boolean;
}

/** Environment policy overrides settings; use the shared registry so resolver and UI notices agree. */
export function resolveCorpCaConfig(
  settings: CorpCaSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): CorpCaConfig {
  const forcedName = envForcedStringForSettingsPath("system.corpCaCommonName", env);
  return {
    enabled: resolveEnvBackedBoolean("system.corpCaEnabled", settings.enabled, env, true),
    // Invalid text overrides fall through to the next source rather than searching for an empty name.
    commonName:
      normalizeCorpCaCommonName(forcedName)
      ?? normalizeCorpCaCommonName(settings.commonName)
      ?? DEFAULT_CORP_CA_COMMON_NAME,
    debugLog: resolveEnvBackedBoolean("system.corpCaDebugLog", settings.debugLog, env, false),
  };
}

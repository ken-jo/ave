// Inject the persisted corporate CA before the first outbound request; changes require a new process.
import { resolveCorpCaConfig, type CorpCaConfig } from "../shared/corp-ca-config.js";
import {
  readPersistedSystemBooleanSync,
  readPersistedSystemStringSync,
} from "./persisted-settings-sync.js";

// {@link resolveCorpCaConfig} against the settings file for this profile.
export function readPersistedCorpCaConfigSync(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
): CorpCaConfig {
  return resolveCorpCaConfig(
    {
      enabled: readPersistedSystemBooleanSync(userDataPath, "corpCaEnabled"),
      commonName: readPersistedSystemStringSync(userDataPath, "corpCaCommonName"),
      debugLog: readPersistedSystemBooleanSync(userDataPath, "corpCaDebugLog"),
    },
    env,
  );
}

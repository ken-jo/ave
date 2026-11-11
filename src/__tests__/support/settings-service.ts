import { SettingsService } from "../../data/settings-store.js";
import { unavailableSecretEncryption } from "./host-runtime.js";

/** Read a real settings file without depending on desktop credential storage. */
export function createSettingsService(userDataPath: string): SettingsService {
  return new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
}

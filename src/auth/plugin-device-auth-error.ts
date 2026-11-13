import type { DeviceCodeAuthorizationErrorCode } from "../plugins/public-contract.js";

/** Fixed messages are safe to expose across the plugin process boundary. */
const MESSAGES = {
  "oauth-device-human-required": "Authenticate interactively before running unattended; do not retry.",
  "oauth-device-encrypted-storage-unavailable": "Device authorization requires encrypted storage.",
  "oauth-device-denied": "Device authorization was denied.",
  "oauth-device-expired": "Device authorization expired; start authentication again.",
  "oauth-device-canceled": "Device authorization was canceled.",
  "oauth-device-unsupported": "Device authorization is not supported by this authorization server.",
  "oauth-device-failed": "Device authorization failed.",
} satisfies Record<DeviceCodeAuthorizationErrorCode, string>;

export function isDeviceCodeAuthorizationErrorCode(code: unknown): code is DeviceCodeAuthorizationErrorCode {
  return typeof code === "string" && Object.hasOwn(MESSAGES, code);
}

export class PluginDeviceAuthError extends Error {
  constructor(readonly code: DeviceCodeAuthorizationErrorCode) {
    super(MESSAGES[code]);
    this.name = "PluginDeviceAuthError";
  }
}

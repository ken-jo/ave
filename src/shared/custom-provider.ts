export const CUSTOM_PROVIDER_WIRES = [
  "openai-chat", "openai-responses", "anthropic-messages", "google-gemini",
] as const;

export type CustomProviderWire = (typeof CUSTOM_PROVIDER_WIRES)[number];

export class LlmProviderSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderSettingsError";
  }
}

export function customProviderWire(value: unknown): CustomProviderWire {
  if (value === undefined) return "openai-chat";
  if (typeof value === "string" && (CUSTOM_PROVIDER_WIRES as readonly string[]).includes(value)) {
    return value as CustomProviderWire;
  }
  throw new LlmProviderSettingsError("Custom provider wire is invalid");
}

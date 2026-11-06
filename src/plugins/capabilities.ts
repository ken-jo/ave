// Only known capabilities grant host behavior; unknown format-valid declarations remain harmless.
// UI event ownership is enforced independently of capability declarations.

/** The schema accepts free-form declarations; this list defines only runtime-enforced IDs and their type union. */
const KNOWN_CAPABILITY_IDS = [
  "external-auth-consumer",
  // host:overlay stages conversation triggers through the overlay context.
  "host:overlay",
  "secrets:raw-api-key",
] as const;

export type CapabilityId = (typeof KNOWN_CAPABILITY_IDS)[number];

/** Runtime-enforced capability IDs; the manifest schema also accepts unknown declarations. */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(KNOWN_CAPABILITY_IDS);

/** Shared IDs provide typo safety; enforcement policy remains at each gate. */
export const CAPABILITY_EXTERNAL_AUTH_CONSUMER: CapabilityId = "external-auth-consumer";
export const CAPABILITY_HOST_OVERLAY: CapabilityId = "host:overlay";
export const CAPABILITY_RAW_API_KEY: CapabilityId = "secrets:raw-api-key";

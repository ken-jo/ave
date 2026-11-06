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

/** Only the host may emit these lifecycle and user-state events; declarations cannot authorize spoofing them. */
export const HOST_ONLY_EMIT_NAMESPACES: ReadonlySet<string> = new Set([
  "plugin",
  "host",
  "work_board",
  "alert",
]);

/** Unknown subscription namespaces warn unless private; plugin-owned names stay outside the host allowlist. */
export const PUBLIC_EVENT_NAMESPACES: ReadonlySet<string> = new Set();

/** Exact host event exceptions must not make the whole host.* namespace subscribable or emittable. */
export const PUBLIC_HOST_EVENT_TYPES: ReadonlySet<string> = new Set([
  "host.theme.changed",
]);

/** Reject subscriptions exposing sensitive host state at wiring time. */
export const PLUGIN_PRIVATE_NAMESPACES: ReadonlySet<string> = new Set([
  "memory.private",
  "settings.apiKey",
  "audit",
  "dlp",
]);

export function categorizeEvent(eventType: string): string {
  if (PUBLIC_HOST_EVENT_TYPES.has(eventType)) return "host";
  const prefix = eventType.split(".")[0] ?? "";
  return PUBLIC_EVENT_NAMESPACES.has(prefix) ? prefix : "other";
}

/** UI event names are owned by the emitting plugin, without manifest grants. */
export function canEmitEvent(eventType: string, pluginId: string): boolean {
  return eventType.startsWith(`${pluginId}.`)
    && eventType.length > pluginId.length + 1
    && !HOST_ONLY_EMIT_NAMESPACES.has(pluginId)
    && classifySubscription(eventType) !== "private";
}

/** Private subscriptions reject, public ones pass, and neutral ones pass with a drift warning. */
export function classifySubscription(
  eventType: string,
): "private" | "public" | "neutral" {
  // Private namespaces may be dotted; match the longest prefix.
  for (const priv of PLUGIN_PRIVATE_NAMESPACES) {
    if (eventType === priv || eventType.startsWith(`${priv}.`)) {
      return "private";
    }
  }
  if (PUBLIC_HOST_EVENT_TYPES.has(eventType)) return "public";
  const prefix = eventType.split(".")[0] ?? "";
  if (PUBLIC_EVENT_NAMESPACES.has(prefix)) return "public";
  return "neutral";
}

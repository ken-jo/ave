/** Renderer writes and main broadcasts must share key normalization, reserved-key rejection, and version matching. */

/** Use a null-prototype map because IDs from disk and catalogs must not resolve inherited members. */
export type SkippedPluginUpdateMap = Record<string, string>;

/** Reject keys that could poison prototypes or match inherited members. */
const RESERVED_SKIPPED_PLUGIN_UPDATE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function createSkippedPluginUpdateMap(): SkippedPluginUpdateMap {
  return Object.create(null) as SkippedPluginUpdateMap;
}

export function normalizeSkippedPluginUpdateKey(pluginId: string): string | null {
  const key = pluginId.trim();
  if (!key || RESERVED_SKIPPED_PLUGIN_UPDATE_KEYS.has(key)) return null;
  return key;
}

/** Drop unusable keys and blank versions because they cannot be matched later. */
export function putSkippedPluginUpdate(
  target: SkippedPluginUpdateMap,
  pluginId: string,
  latestVersion: string,
): void {
  const key = normalizeSkippedPluginUpdateKey(pluginId);
  const value = latestVersion.trim();
  if (!key || !value) return;
  target[key] = value;
}

/** Normalize untrusted plain objects, dropping invalid entries; normalization is idempotent and can copy a normalized map. */
export function readSkippedPluginUpdates(input: unknown): SkippedPluginUpdateMap {
  const result = createSkippedPluginUpdateMap();
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [pluginId, version] of Object.entries(input)) {
    if (typeof version !== "string") continue;
    putSkippedPluginUpdate(result, pluginId, version);
  }
  return result;
}

/** Plugins retain their ID key; other families use kind:name. Each installed pair has one bound source. */
export function packageUpdateSkipKey(key: { kind: string; name: string }): string {
  return key.kind === "plugin" ? key.name : `${key.kind}:${key.name}`;
}

/** Skip only the exact offered version; newer releases must notify again. */
export function isSkippedPackageUpdate(
  update: { key: { kind: string; name: string }; to: string },
  skipped: SkippedPluginUpdateMap,
): boolean {
  const key = normalizeSkippedPluginUpdateKey(packageUpdateSkipKey(update.key));
  const version = update.to.trim();
  return Boolean(key && version && skipped[key] === version);
}

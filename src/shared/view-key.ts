/** Main and renderer derive the same destination vocabulary here; all destinations render inline. */

export const BUILTIN_VIEWS = {
  home: {},
  settings: {},
  "work-board": {},
  routines: {},
  memory: {},
  starred: {},
  insights: {},
  // Instance views require a tab ID in ViewLocation.surface.
  terminal: {},
  web: {},
} as const satisfies Record<string, Record<string, never>>;

export type BuiltinViewKey = keyof typeof BUILTIN_VIEWS;

export type InstanceViewKey = "terminal" | "web";

/** Instance views require a live surface ID and cannot be restored as the window view. */
export function isInstanceViewKey(raw: string): raw is InstanceViewKey {
  return raw === "terminal" || raw === "web";
}

export type PluginViewKey = `plugin:${string}:${string}`;

export type InlineViewKey = BuiltinViewKey | PluginViewKey;

/** Validate plugin keys structurally: extension IDs may contain uppercase text, but segments must be non-empty and colon-free. */
const STRUCTURAL_SEGMENT_RE = /^[^:]+$/;

export type ParsedViewKey =
  | { kind: "builtin"; key: BuiltinViewKey }
  | { kind: "plugin"; key: PluginViewKey; pluginId: string; viewId: string };

/** Use this parser rather than prefix checks, which also accept malformed keys. */
export function parseViewKey(raw: string): ParsedViewKey | null {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_VIEWS, raw)) {
    return { kind: "builtin", key: raw as BuiltinViewKey };
  }

  // Do not limit split: trailing segments must be rejected.
  if (raw.startsWith("plugin:")) {
    const rest = raw.slice("plugin:".length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    const pluginId = rest.slice(0, separator);
    const viewId = rest.slice(separator + 1);
    if (!STRUCTURAL_SEGMENT_RE.test(pluginId) || !STRUCTURAL_SEGMENT_RE.test(viewId)) return null;
    return { kind: "plugin", key: raw as PluginViewKey, pluginId, viewId };
  }

  return null;
}

export function pluginViewKey(pluginId: string, viewId: string): PluginViewKey {
  return `plugin:${pluginId}:${viewId}`;
}

export function isInlineViewKey(raw: string): raw is InlineViewKey {
  const kind = parseViewKey(raw)?.kind;
  return kind === "builtin" || kind === "plugin";
}

export type ParsedInlineViewKey =
  | { kind: "builtin"; key: BuiltinViewKey }
  | { kind: "plugin"; key: PluginViewKey; pluginId: string; viewId: string };

/** Return the narrowed location shape so runtime navigability and static types remain linked. */
export function parseInlineViewKey(raw: string): ParsedInlineViewKey | null {
  const parsed = parseViewKey(raw);
  if (!parsed) return null;
  if (parsed.kind === "plugin") return parsed;
  // MCP-app cards are destinations the main window cannot render.
  if (parsed.kind !== "builtin") return null;
  return { kind: "builtin", key: parsed.key };
}

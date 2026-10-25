/** Share boundary shape validation across settings and renderer; runtime registration remains authoritative for whether a shortcut binds. */

export interface ShortcutSettings {
  /** A null accelerator registers nothing even when enabled. */
  toggleWindow: string | null;
  enabled: boolean;
}

export interface ShortcutSettingsPatch {
  toggleWindow?: string | null;
  enabled?: boolean;
}

const MAX_ACCELERATOR_LEN = 128;

/** Reject ASCII controls; accelerators contain printable modifier/key tokens joined by plus signs. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A lone modifier cannot bind. */
const MODIFIERS: ReadonlySet<string> = new Set([
  "command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl",
  "alt", "option", "altgr", "shift", "super", "meta",
]);

/** Reject malformed shape before persistence, keeping the prior value; this superset check does not prove runtime bindability. */
export function normalizeAccelerator(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACCELERATOR_LEN) return null;
  if (hasControlChars(trimmed)) return null;
  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return null;
  const key = parts[parts.length - 1];
  if (MODIFIERS.has(key.toLowerCase())) return null;
  return trimmed;
}

export function normalizeShortcuts(
  input: unknown,
  fallback: ShortcutSettings,
): ShortcutSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...fallback };
  }
  const obj = input as { toggleWindow?: unknown; enabled?: unknown };
  const result: ShortcutSettings = { ...fallback };
  if (obj.toggleWindow === null) {
    result.toggleWindow = null;
  } else if (obj.toggleWindow !== undefined) {
    const accel = normalizeAccelerator(obj.toggleWindow);
    if (accel !== null) result.toggleWindow = accel;
  }
  if (typeof obj.enabled === "boolean") {
    result.enabled = obj.enabled;
  }
  return result;
}

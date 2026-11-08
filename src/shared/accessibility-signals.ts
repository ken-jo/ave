/**
 * Accessibility signals: short sound cues for agent events, modelled on VS Code's Accessibility Signals. Browser-safe so the
 * settings store (main) and the signal engine (renderer) read one contract.
 *
 * Each signal has one mode, mirroring VS Code's signal modes:
 * - `"off"`: never plays;
 * - `"unfocused"`: plays only while the main Ave window does not have focus (the user is looking elsewhere). The renderer reads
 *   its own `document.hasFocus()`, so another Ave window in front (a detached viewer, the floating dock) counts as unfocused;
 * - `"on"`: always plays.
 */
export const ACCESSIBILITY_SIGNAL_MODES = ["off", "unfocused", "on"] as const;
export type AccessibilitySignalMode = (typeof ACCESSIBILITY_SIGNAL_MODES)[number];

export const ACCESSIBILITY_SIGNAL_IDS = ["turnFinished", "approvalNeeded", "turnFailed"] as const;
export type AccessibilitySignalId = (typeof ACCESSIBILITY_SIGNAL_IDS)[number];

/** The `system` settings field that stores each signal's mode. */
export const ACCESSIBILITY_SIGNAL_SETTING_KEYS = {
  turnFinished: "signalTurnFinished",
  approvalNeeded: "signalApprovalNeeded",
  turnFailed: "signalTurnFailed",
} as const satisfies Record<AccessibilitySignalId, string>;

type AccessibilitySignalSettingKey = (typeof ACCESSIBILITY_SIGNAL_SETTING_KEYS)[AccessibilitySignalId];

export type AccessibilitySignalSettings = { [K in AccessibilitySignalSettingKey]?: AccessibilitySignalMode };

/** Owner default (2026-11-08): the two attention cues play only in the background; the failure cue is opt-in. */
export const DEFAULT_ACCESSIBILITY_SIGNAL_MODES: Readonly<Record<AccessibilitySignalId, AccessibilitySignalMode>> = Object.freeze({
  turnFinished: "unfocused",
  approvalNeeded: "unfocused",
  turnFailed: "off",
});

export function isAccessibilitySignalMode(value: unknown): value is AccessibilitySignalMode {
  return typeof value === "string" && (ACCESSIBILITY_SIGNAL_MODES as readonly string[]).includes(value);
}

/** The mode each signal resolves to from a settings snapshot. `normalizeSystem` backfills every key, so a missing key only
 * occurs before the first snapshot arrives; it then reads as the shipped default. */
export function resolveAccessibilitySignalModes(
  system: AccessibilitySignalSettings | undefined,
): Record<AccessibilitySignalId, AccessibilitySignalMode> {
  const out = { ...DEFAULT_ACCESSIBILITY_SIGNAL_MODES };
  for (const id of ACCESSIBILITY_SIGNAL_IDS) {
    const stored = system?.[ACCESSIBILITY_SIGNAL_SETTING_KEYS[id]];
    if (stored !== undefined) out[id] = stored;
  }
  return out;
}

/** Whether a signal in `mode` plays now, given whether the main Ave window has focus. */
export function shouldPlayAccessibilitySignal(mode: AccessibilitySignalMode, windowFocused: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "unfocused") return !windowFocused;
  return false;
}

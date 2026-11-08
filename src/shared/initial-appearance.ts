import type { AppearanceSettings } from "./appearance-settings.js";

export type InitialAppearance = Readonly<AppearanceSettings>;
/**
 * `glass`, as main decided it when it created the window: `on` — the system material is behind it (macOS, Windows 11 22H2+, reduce-transparency off);
 * `reduced` — this OS has the material but the reduce-transparency switch was on; `unsupported` — no material on this OS (Linux, older Windows).
 */
export type InitialGlassState = "on" | "reduced" | "unsupported";
export const INITIAL_GLASS_STATES: readonly InitialGlassState[] = ["on", "reduced", "unsupported"];
export type InitialAppearanceResult =
  | { ok: true; appearance: InitialAppearance; glass: InitialGlassState }
  | { ok: false; error: "unauthorized-frame" | "appearance-unavailable" };

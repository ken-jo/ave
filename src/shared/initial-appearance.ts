import type { AppearanceSettings } from "./appearance-settings.js";

export type InitialAppearance = Readonly<AppearanceSettings>;
/** `glass`: the window was created with the macOS material behind it (darwin, reduce-transparency off). */
export type InitialAppearanceResult =
  | { ok: true; appearance: InitialAppearance; glass: boolean }
  | { ok: false; error: "unauthorized-frame" | "appearance-unavailable" };

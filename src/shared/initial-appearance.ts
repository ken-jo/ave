import type { AppearanceSettings } from "./appearance-settings.js";

export type InitialAppearance = Readonly<AppearanceSettings>;
export type InitialAppearanceResult =
  | { ok: true; appearance: InitialAppearance }
  | { ok: false; error: "unauthorized-frame" | "appearance-unavailable" };

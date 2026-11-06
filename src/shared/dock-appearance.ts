import type { AppearanceSettings } from "./appearance-settings.js";

/** Main-owned appearance snapshot for dock chrome and its app views. */
export interface DockAppearance {
  /** `bundleId` is the host renderer's applied scheme id; the dock root resolves the same scheme from it. */
  theme: { bundleId: string; shell: "light" | "dark"; tokens: Record<string, string> };
  terminalFontFamily: string;
  /** The user's UI font (family and size scale), applied to the dock root exactly as the main window applies it. */
  font: AppearanceSettings["font"];
}

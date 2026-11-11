import type { AppearanceSettings, AppearanceMode } from "../../../shared/appearance-settings.js";
import type { ThemeTokens, ThemeSurfaces } from "../../../shared/theme-tokens.js";

export type ResolvedShell = "light" | "dark";
interface TerminalPalette {
  background: string; foreground: string; cursor: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}
export interface ColorScheme {
  id: string;
  name: string;
  shell: ResolvedShell;
  terminal: TerminalPalette;
}
/** Renderer-only status colours for the glass sidebar, with paired ink for filled badges. */
export type GlassStatusTokens = Pick<ThemeTokens,
  "destructive" | "destructive-foreground" | "warning" | "warning-foreground"
  | "success" | "success-foreground" | "info" | "info-foreground" | "emphasis">;
export interface ResolvedTheme {
  id: string;
  shell: ResolvedShell;
  terminal: ColorScheme["terminal"];
  tokens: ThemeTokens;
  surfaces: ThemeSurfaces;
  glassStatus: GlassStatusTokens;
}
export interface ThemeContextValue {
  appearance: AppearanceSettings;
  mode: AppearanceMode;
  darkScheme: string;
  lightScheme: string;
  setMode: (mode: AppearanceMode) => void;
  setScheme: (shell: ResolvedShell, id: string) => void;
  /** Paint a glass tint now; `persist` also saves it. A slider previews on every step and persists when the drag ends. */
  setGlassTint: (tint: number, persist: boolean) => void;
  resolved: ResolvedShell;
  scheme: ColorScheme;
  appliedTheme: ResolvedTheme;
  appliedRevision: number;
}

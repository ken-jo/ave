/** Main-owned appearance snapshot for dock chrome and its app views. */
export interface DockAppearance {
  theme: { shell: "light" | "dark"; tokens: Record<string, string> };
  terminalFontFamily: string;
}

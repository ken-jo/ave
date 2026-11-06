import { createContext, useContext, type ReactNode } from "react";

export interface HostAppearance {
  readonly shell: "light" | "dark";
  readonly tokens: Readonly<Record<string, string>>;
  readonly terminalFontFamily: string;
}

const HostAppearanceContext = createContext<HostAppearance | null>(null);

/** Supplies an applied host snapshot without settings writes or theme publication. */
export function HostAppearanceProvider({ value, children }: { value: HostAppearance; children: ReactNode }) {
  return <HostAppearanceContext.Provider value={value}>{children}</HostAppearanceContext.Provider>;
}

export function useHostAppearance(): HostAppearance {
  const value = useContext(HostAppearanceContext);
  if (!value) throw new Error("useHostAppearance() must be used inside <HostAppearanceProvider>");
  return value;
}

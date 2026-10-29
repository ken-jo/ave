import { createContext, useContext } from "react";

export interface PaneChatNavigation {
  /** Resolve only bindings whose terminal or page still exists in this window. */
  resolveSession: (sessionId: string) => { tabId: string; name: string } | undefined;
  openPaneChat: (tabId: string) => void;
}

const PaneChatNavigationContext = createContext<PaneChatNavigation | null>(null);

export const PaneChatNavigationProvider = PaneChatNavigationContext.Provider;

export function usePaneChatNavigation(): PaneChatNavigation | null {
  return useContext(PaneChatNavigationContext);
}

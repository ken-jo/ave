import { DEFAULT_APPEARANCE } from "../../../../shared/appearance-settings.js";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { ThemeProvider } from "../../theme/index.js";

interface McpAveStubDependencies {
  readUiResource: unknown;
  disposeUiSession: unknown;
}

export function stubMcpAve({
  readUiResource,
  disposeUiSession,
}: McpAveStubDependencies): void {
  vi.stubGlobal("ave", {
    mcp: {
      readUiResource,
      disposeUiSession,
      onServerDisconnected: () => () => undefined,
    },
  });
  (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;
}

/** Wraps a render in the real `ThemeProvider` — `McpAppView` (and the pip panel that hosts it) call `useTheme()`, which
 * throws without a provider. Shared so the MCP-app renderer suites don't each re-declare an identical wrapper. */
export function ThemeWrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "light" }}>{children}</ThemeProvider>;
}

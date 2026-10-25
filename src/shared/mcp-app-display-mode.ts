/** Advertise only modes backed by one live card mount; moving between inline, fullscreen, and floating slots replaces rather than clones. */

/** Keep the wire union dependency-free for main, renderer bridge, and page bundles. */
export type McpUiDisplayMode = "inline" | "fullscreen" | "pip";

/** Every card mounts inline; it is also the answer to an unavailable-mode request. */
export const MCP_APP_DEFAULT_DISPLAY_MODE: McpUiDisplayMode = "inline";

/** Advertisement and request validation must use the same supported-mode set. */
export const MCP_APP_AVAILABLE_DISPLAY_MODES: readonly McpUiDisplayMode[] = [
  "inline",
  "fullscreen",
  "pip",
];

export function isSupportedMcpAppDisplayMode(mode: unknown): mode is McpUiDisplayMode {
  return (
    typeof mode === "string" &&
    (MCP_APP_AVAILABLE_DISPLAY_MODES as readonly string[]).includes(mode)
  );
}

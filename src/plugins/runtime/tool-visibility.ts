/** Read normalized visibility through one primitive; only the manifest producer materializes semantic defaults. */
import type { Tool as McpTool } from "../types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("plugin-runtime");

export type ToolSurface = "model" | "app";

/** Malformed normalized visibility fails to the minimal governed surface, never the app-only bypass. */
export const FAIL_CLOSED_SURFACE: readonly ToolSurface[] = ["model"];

/** Share raw visibility membership checks while producers choose their own default or refusal policy. */
export function parseToolSurfaces(raw: unknown): ToolSurface[] | null {
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((v) => v === "model" || v === "app")
  ) {
    return raw as ToolSurface[];
  }
  return null;
}

/** Read explicit visibility; missing or malformed normalized values warn and use the minimal governed surface. */
export function toolVisibility(tool: McpTool): ToolSurface[] {
  const parsed = parseToolSurfaces(tool._meta?.ui?.visibility);
  if (parsed) return parsed;
  log.warn(
    { event: "tool-visibility-missing", tool: tool.name },
    "tool reached a host consumer without explicit _meta.ui.visibility — " +
      "normalization-contract violation; applying fail-closed minimal surface [model]",
  );
  return [...FAIL_CLOSED_SURFACE];
}

export const isModelVisible = (t: McpTool): boolean => toolVisibility(t).includes("model");
export const isAppVisible = (t: McpTool): boolean => toolVisibility(t).includes("app");

/** App-only means app without model; malformed input can never satisfy the bypass predicate. */
export const isUiOnly = (t: McpTool): boolean => isAppVisible(t) && !isModelVisible(t);

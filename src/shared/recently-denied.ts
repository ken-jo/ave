import type { ToolCategory, ToolSource } from "./permission-review-status.js";

/** Non-executable references into an existing saved transcript. */
export interface RecentlyDeniedInvocationRef {
  toolUseId: string;
  inputDigest: string;
  rootDigest: string;
  pluginId?: string;
  mcpServerId?: string;
}

/** Display-only denial history. Authority and executable inputs never cross this boundary. */
export interface RecentlyDeniedEntry {
  id: string;
  ts: string;
  sessionId?: string;
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  inputSummary: string;
  reason: string;
  rerunAvailable: boolean;
  invocationRef?: RecentlyDeniedInvocationRef;
}

export type RecentlyDeniedRerunResult =
  | { ok: true }
  | { ok: false; error: "rerun-unavailable" | "rerun-failed" | "rerun-in-progress" };

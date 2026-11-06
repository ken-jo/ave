import { MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";

export interface GlobalWebviewNavigationDecisionInput {
  url: string;
  currentUrl: string;
  distRoot: string;
  authOwned: boolean;
  linkOwned: boolean;
}

export function shouldBlockGlobalWebviewNavigation(
  input: GlobalWebviewNavigationDecisionInput,
): boolean {
  if (input.authOwned || input.linkOwned) return false;

  // Permit the host proxy scheme for guarded re-navigation and recovery; its handler independently validates token and authority.
  if (input.url.startsWith(`${MCP_APP_SCHEME}:`)) return false;

  return !input.url.startsWith("data:") && !input.url.startsWith("about:");
}

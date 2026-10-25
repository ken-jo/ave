import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";
import { isPluginShellFrameUrl } from "../shared/plugin-shell-frame.js";

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

  const isPluginShellFrame = isPluginShellFrameUrl(input.currentUrl);
  if (isPluginShellFrame && input.url.startsWith("file://")) {
    const distSrc = resolve(input.distRoot, "src");
    let targetPath: string | null = null;
    try {
      targetPath = resolve(fileURLToPath(input.url));
    } catch {
      targetPath = null;
    }
    if (targetPath) {
      const rel = relative(distSrc, targetPath);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return false;
      }
    }
  }

  return !input.url.startsWith("data:") && !input.url.startsWith("about:");
}

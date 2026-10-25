/** Shared MCP app payload and webview selectors for panel suites; subject mocks stay in each suite. */
import type { McpUiPayload } from "../../../../mcp/types.js";

export function mcpUiPayload(serverId: string): McpUiPayload {
  return { serverId, resourceUri: "ui://card/1" };
}

export function webviewNodes(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll("webview");
}

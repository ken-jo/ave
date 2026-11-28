import { McpGovernance } from "../../mcp/mcp-governance.js";
import { McpManager } from "../../mcp/mcp-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { unusedNetworkFetch } from "./network-fetch-stubs.js";

export function makeMcpTrustManager(
  policyPath: string,
  configPath: string,
  secrets: ConstructorParameters<typeof McpManager>[6],
): McpManager {
  return new McpManager(
    new McpGovernance(policyPath),
    new ToolRegistry(),
    unusedNetworkFetch,
    configPath,
    undefined,
    undefined,
    secrets,
  );
}

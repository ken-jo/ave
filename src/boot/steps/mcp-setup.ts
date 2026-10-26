/** Create signed artifact stores only when verified downloads are available. */
import { McpGovernance } from "../../mcp/mcp-governance.js";
import { McpManager } from "../../mcp/mcp-manager.js";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import { requireDesktopHost } from "../host-runtime.js";
import { createElicitationResolverFactory } from "../../mcp/mcp-elicitation-resolver.js";
// External and loopback servers share the disconnect sink and event shape.
import { createMcpServerDisconnectedSink } from "../../mcp/mcp-server-disconnect-sink.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

export async function setupMcp(ctx: BootContext): Promise<void> {
  const { approvalGate, toolRegistry, permissionManager, bootAuditLogger } = ctx;

  const mcpGovernance = new McpGovernance();
  // Route server elicitation through the host approval gate.
  const mcpInputResolverFactory = createElicitationResolverFactory({ approvalGate });
  const mcpManager = new McpManager(
    mcpGovernance,
    toolRegistry,
    ctx.singleHopNetworkFetch,
    undefined,
    permissionManager,
    bootAuditLogger,
    mcpInputResolverFactory,
    // Resolve the window manager at emit time; it is installed after boot context creation.
    createMcpServerDisconnectedSink(),
    ctx.settingsService,
    {
      redirectCatchers: new AuthRedirectCatchers(),
      openAuthorizationUrl: async (url, options) => {
        await requireDesktopHost(ctx.host).openOAuthLogin(url, options);
      },
      secrets: {
        getSecret: (key) => ctx.settingsService.getEncryptedSecret(key),
        // The session checks canStoreEncrypted() before any flow starts; this guard keeps a write fail-closed.
        setSecret: async (key, value) => {
          if (!ctx.settingsService.isSecretStorageEncrypted()) throw new Error("MCP authorization requires encrypted storage");
          await ctx.settingsService.setSecret(key, value);
        },
        deleteSecret: (key) => ctx.settingsService.deleteSecret(key),
        canStoreEncrypted: () => ctx.settingsService.isSecretStorageEncrypted(),
      },
    },
  );
  try {
    const configs = await mcpManager.loadFromConfig();
    if (configs.length > 0) {
      await mcpManager.connectAll();
      log.info("boot: MCP servers connected");
    }
  } catch (err) {
    log.warn("boot: MCP initialization failed (non-fatal): %s", (err as Error).message);
  }
  mcpGovernance.startPolicyRefresh((revokedIds) => {
    void mcpManager.handlePolicyWithdrawal(revokedIds).catch((err) => {
      log.error({ err }, "boot: MCP policy withdrawal failed");
    });
  });

  ctx.mcpGovernance = mcpGovernance;
  ctx.mcpManager = mcpManager;
}

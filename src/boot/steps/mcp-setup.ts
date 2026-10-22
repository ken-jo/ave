/**
 * Boot step — MCP server connection + signed marketplace artifact stores
 * (§9.5 + §FU#259, extracted from boot.ts C18).
 *
 * Constructs the MCP governance + manager, connects any configured servers
 * (non-fatal), starts the policy-refresh kill-switch loop, and builds the
 * signed-artifact stores for marketplace MCP servers / agents / skills — each
 * rooted under `~/.ave/<feature>/` and only when the marketplace fetcher
 * supports verified downloads (the disabled fetcher leaves them undefined).
 */
import { McpGovernance } from "../../mcp/mcp-governance.js";
import { McpManager } from "../../mcp/mcp-manager.js";
import { AuthRedirectCatchers } from "../../main/auth-redirect-catcher.js";
import { requireDesktopHost } from "../host-runtime.js";
import { createElicitationResolverFactory } from "../../mcp/mcp-elicitation-resolver.js";
// #885 b3 — the disconnect sink now lives in `mcp/` because BOTH server arms need
// it: McpManager (external) here, and PluginLoopbackManager (in-process plugin
// servers) at its own teardown. One factory, one event shape, identical card UX.
import { createMcpServerDisconnectedSink } from "../../mcp/mcp-server-disconnect-sink.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

export async function setupMcp(ctx: BootContext): Promise<void> {
  const { approvalGate, toolRegistry, permissionManager, bootAuditLogger } = ctx;

  const mcpGovernance = new McpGovernance();
  // MRTR live-resolver wiring (milestone mrtr-input-loop): a server's
  // `input_required` (elicitation) is gathered through the host approval gate.
  const mcpInputResolverFactory = createElicitationResolverFactory({ approvalGate });
  const mcpManager = new McpManager(
    mcpGovernance,
    toolRegistry,
    ctx.singleHopNetworkFetch,
    undefined,
    permissionManager,
    bootAuditLogger,
    mcpInputResolverFactory,
    // #885 b3 — disconnect teardown sink. Resolves WindowManager lazily at emit
    // time (BootContext has no windowManager; it is the module-level singleton
    // in app-state, set at main.ts after window creation).
    createMcpServerDisconnectedSink(),
    ctx.settingsService,
    {
      redirectCatchers: new AuthRedirectCatchers(),
      openAuthorizationUrl: (url) => requireDesktopHost(ctx.host).shellOpenExternal(url),
      secrets: {
        getSecret: (key) => ctx.settingsService.getEncryptedSecret(key),
        setSecret: async (key, value) => {
          if (!ctx.host.encryption.isEncryptionAvailable() || ctx.host.encryption.getSelectedStorageBackend() === "basic_text") {
            throw new Error("MCP authorization requires encrypted storage");
          }
          await ctx.settingsService.setSecret(key, value);
        },
        deleteSecret: (key) => ctx.settingsService.deleteSecret(key),
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

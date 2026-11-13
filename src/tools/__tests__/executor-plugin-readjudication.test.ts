import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { hashReceiptFiles, writeInstallReceipt } from "../../plugins/plugin-install-receipt.js";
import { makeTestTreeWritable, servedAgentPluginsDocument, TestPluginRuntime, writeTestPluginRegistry } from "../../plugins/__tests__/test-helpers.js";
import { mcpToolToPluginTool, type DiscoveredMcpTool } from "../../mcp/plugin-tool-from-mcp.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const PLUGIN_ID = "ea-docs";
const TOOL_NAME = "ea_publish_document";
const ARTIFACT = "a".repeat(64);
const TOOL_DEFINITION: DiscoveredMcpTool = {
  name: TOOL_NAME,
  description: "Publish a document",
  inputSchema: { type: "object", properties: { path: { type: "string" }, operation: { type: "string" } }, required: ["operation"] },
  _meta: { "ai.agent-connector.ave/pathFields": ["path"], ui: { visibility: ["model", "app"] } },
};

describe("executor human re-adjudication card production", () => {
  let root: string | undefined;
  let runtime: TestPluginRuntime | undefined;
  let gate: ApprovalGate | undefined;
  let audit: AuditLogger | undefined;

  afterEach(async () => {
    gate?.disposeAll();
    await runtime?.stopAll();
    await audit?.close();
    vi.unstubAllEnvs();
    if (root) {
      await makeTestTreeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])("keeps the static HIGH and offers EA only with host receipt evidence=%s", async (withReceipt) => {
    root = await mkdtemp(join(homedir(), "ea-"));
    vi.stubEnv("AVE_HOME", join(root, "state"));
    const hostRoot = join(root, "host");
    const pluginsRoot = join(root, "plugins");
    const pluginRoot = join(pluginsRoot, PLUGIN_ID);
    const cacheRoot = join(pluginsRoot, ".cache");
    const registryPath = join(hostRoot, "registry.json");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(hostRoot, { recursive: true });
    await writeFile(join(pluginRoot, "entry.mjs"), `export default async () => ({ handlers: { ${TOOL_NAME}: async () => "published" }, start: async () => {} });\n`);
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(servedAgentPluginsDocument({
      id: PLUGIN_ID, name: "Document fixture", version: "1.0.0", description: "Document publishing fixture", entry: "entry.mjs", tools: [TOOL_DEFINITION],
    })));
    if (withReceipt) {
      await writeInstallReceipt(cacheRoot, {
        schemaVersion: 3, pluginId: PLUGIN_ID, version: "1.0.0", installSource: "marketplace",
        artifactSha256: ARTIFACT, signerKeyId: "receipt-signer", admission: null,
        installedAt: new Date(0).toISOString(), files: await hashReceiptFiles(pluginRoot, ["entry.mjs", "plugin.json"]),
      });
    }
    await writeTestPluginRegistry({ registryPath }, [{ id: PLUGIN_ID, manifestPath: join(pluginRoot, "plugin.json") }]);
    runtime = new TestPluginRuntime({ hostRoot, pluginsRoot, registryPath,
      ...(withReceipt ? { installReceiptCacheRoot: cacheRoot } : {}),
    });
    await runtime.load();
    const projection = runtime.getRuntimeGenerationProjection(PLUGIN_ID);
    const generations = runtime.getGenerationAccess();
    const active = generations?.getActive(PLUGIN_ID);
    if (!projection || !generations || !active) throw new Error("Expected a published plugin generation");
    expect(projection.confinement).toBe("unconfined");
    const invoke = vi.fn(async () => ({ text: "unexpected execution" }));
    const tool = mcpToolToPluginTool(PLUGIN_ID, TOOL_DEFINITION, invoke, undefined, active.generationId);
    const tools = new ToolRegistry();
    tools.register(tool);
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("strict");
    audit = new AuditLogger(join(root, "audit"));
    await audit.setupPermissionAuditChain("a".repeat(64));
    const cards: ApprovalRequest[] = [];
    const snapshots: Array<ReturnType<ApprovalGate["getRequestSnapshot"]>> = [];
    const surface = { send: vi.fn(), isDestroyed: () => false };
    const approvalGate = new ApprovalGate(() => surface as never, undefined, undefined, audit);
    gate = approvalGate;
    surface.send.mockImplementation((channel: string, request: ApprovalRequest) => {
      if (channel !== IPC_APPROVAL_REQUEST) return;
      cards.push(request);
      snapshots.push(approvalGate.getRequestSnapshot(request.id));
      approvalGate.disposeAll();
    });
    const hooks = new ScriptHookManager();
    hooks.setPluginGenerationAccess(generations);
    const executor = new ToolExecutor(tools, undefined, manager, undefined, approvalGate, hooks, audit,
      () => true, () => false, undefined, undefined, () => generations);
    const input = { operation: "publish" };
    const [result] = await executor.executeAll([{ id: "publish-request", name: TOOL_NAME, input }], {
      sessionId: "publishing-session", executionCwd: root,
      permissionContext: userPermissionContext({ headless: false }),
    });
    expect(result.is_error).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card).toMatchObject({ toolName: TOOL_NAME, source: "plugin", args: input,
      ruleVerdict: { level: "high", reason: "write path not declared" }, sandboxCapability: { kind: "none" } });
    expect(card).not.toHaveProperty("readjudicationBasis");
    expect(snapshots[0]?.verdictAtApproval).toBe("high");
    if (withReceipt) {
      expect(card.readjudication).toEqual({ pluginId: PLUGIN_ID, artifactSha256: ARTIFACT,
        signerKeyId: "receipt-signer", staticReason: "write-path-not-declared" });
      expect(snapshots[0]?.readjudication).toEqual(card.readjudication);
    } else {
      expect(card.readjudication).toBeUndefined();
      expect(snapshots[0]?.readjudication).toBeUndefined();
    }
  });
});

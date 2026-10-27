import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { createLocalApi, LOCAL_API_CHANNEL_NOT_PUBLIC } from "../../api/local-api.js";
import { registerBuiltinTools } from "../../boot/tools.js";
import { CHANNELS, EXTERNAL_MUTATION_CHANNELS, PUBLIC_CHANNELS, isPublicChannel } from "../../contract/app-contract.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { configureHostResources } from "../../main/host-resources.js";
import { hostScriptInvocationReadPaths, hostScriptRuntimePaths } from "../../main/host-script-runtime.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import { openEgressInvocation } from "../../permissions/egress-invocations.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { createSandboxActionDirectory } from "../../permissions/sandbox-action-directory.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest } from "../../permissions/sandbox-capability.js";
import { ToolExecutor } from "../executor.js";
import { createFileTools } from "../file-tools.js";
import { ToolRegistry } from "../registry.js";
import { BashTool, PowerShellTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";

let directory: string;
let gate: ApprovalGate | undefined;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-workbook-approval-")));
  const home = join(directory, "host-home");
  mkdirSync(home, { mode: 0o700 });
  vi.stubEnv("AVE_HOME", home);
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
});

afterEach(async () => {
  gate?.disposeAll();
  gate = undefined;
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await cleanupTmpDir(directory);
});

describe("agent workbook editing authority", () => {
  it("sends a pinned workbook edit through the normal shell approval gate", async () => {
    const workbookPath = join(directory, "budget.xlsx");
    const requestPath = join(directory, "edits.json");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Budget", 12]]), "Budget");
    writeFileSync(workbookPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    writeFileSync(requestPath, JSON.stringify({ sheet: 0, edits: [{ cell: "B1", value: 84 }] }));
    const original = readFileSync(workbookPath);
    const runtime = hostScriptRuntimePaths()!;
    const argv = [runtime.javascriptRuntime, join(runtime.bundledScriptsDirectory, "edit-xlsx.cjs"), workbookPath, requestPath];
    expect(hostScriptInvocationReadPaths(argv, { ELECTRON_RUN_AS_NODE: "1" }))
      .toEqual(expect.arrayContaining([runtime.javascriptRuntime, argv[1]]));
    const command = `ELECTRON_RUN_AS_NODE=1 ${argv.map(shellQuote).join(" ")}`;
    const shell = new BashTool();
    const execute = vi.spyOn(shell, "execute");
    const registry = new ToolRegistry();
    registry.register(shell);
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("default");
    manager.setRules([]);
    expect(manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd: directory },
      shellExecution: { runsSandboxed: true }, sessionId: "workbook-agent-session",
    })).toMatchObject({ decision: "ask" });
    const check = vi.spyOn(manager, "checkDetailed");
    let sent!: (request: ApprovalRequest) => void;
    const requested = new Promise<ApprovalRequest>((resolveRequest) => { sent = resolveRequest; });
    const desktop = {
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel === IPC_APPROVAL_REQUEST) sent(request);
      },
    };
    gate = new ApprovalGate(desktop as never);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate);
    const pending = executor.executeAll([{ id: "workbook-agent-save", name: "bash", input: { command } }], {
      sessionId: "workbook-agent-session", executionCwd: directory,
      permissionContext: userPermissionContext({ additionalDirectories: [directory] }),
    });
    const outcome = await Promise.race([requested.then(request => ({ request })), pending.then(results => ({ results }))]);
    if (!("request" in outcome)) throw new Error(`Shell execution returned before requesting approval: ${JSON.stringify(outcome.results)}`);
    const request = outcome.request;
    expect(check.mock.results[0]?.value).toMatchObject({ decision: "ask" });
    expect(request).toMatchObject({ toolName: "bash", args: { command } });
    expect(gate.pendingCount).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(workbookPath)).toEqual(original);
    expect(gate.resolveFromDesktopRenderer(request.id, {
      requestId: request.id, choice: "deny-once", nonce: request.nonce, hmac: request.hmac,
    }, desktop as never)?.choice).toBe("deny-once");
    const [result] = await pending;
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    expect(XLSX.read(readFileSync(workbookPath), { type: "buffer" }).Sheets.Budget!.B1!.v).toBe(12);
  });

  it("does not let an agent shell claim a live panel action directory", async () => {
    const staging = createSandboxActionDirectory();
    const agent = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: "workbook-agent-save",
      context: { sessionId: "workbook-agent-session", workspaceRoot: directory, approvalSurface: "interactive" } });
    try {
      await expect(wrapToolCommand("true", { commandId: agent.token, actionDirectory: staging.path,
        filesystem: { allowWrite: [staging.path] } })).rejects.toThrow("Sandbox action directory is unauthorized");
    } finally { agent.release(); staging.cleanup(); }
  });

  it("keeps the panel editor out of model-facing tool registration", () => {
    const registry = new ToolRegistry();
    registry.registerBatch([new BashTool(), new PowerShellTool(), ...createFileTools()]);
    registerBuiltinTools(registry, {
      get: () => ({ provider: "duckduckgo" }), getSecret: () => null,
    } as unknown as Parameters<typeof registerBuiltinTools>[1], {
      networkFetch: unusedNetworkFetch, singleHopNetworkFetch: unusedNetworkFetch,
    });
    const names = registry.getToolSchemas().map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["bash", "powershell", "read_file", "write_file"]));
    expect(names.filter(name => /xlsx|workbook|edit-xlsx/.test(name))).toEqual([]);
    expect(registry.findByName(CHANNELS.preview.editXlsx)).toBeUndefined();
  });

  it.each(["local-api", "cli", "plugin-frame"] as const)("refuses panel edits from the %s external origin", async (origin) => {
    expect(PUBLIC_CHANNELS as readonly string[]).not.toContain(CHANNELS.preview.editXlsx);
    expect(EXTERNAL_MUTATION_CHANNELS as readonly string[]).not.toContain(CHANNELS.preview.editXlsx);
    expect(isPublicChannel(CHANNELS.preview.editXlsx)).toBe(false);
    const approve = vi.fn(async () => true);
    const execute = vi.fn();
    const api = createLocalApi({ ipc: {} as never,
      conversationCommandPort: { execute } as never, externalMutationApprover: approve });
    expect(await api.dispatch({ channel: CHANNELS.preview.editXlsx, origin,
      args: { action: "save", token: "a".repeat(64), row: 0, column: 1, value: 84 } }))
      .toEqual({ ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC });
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

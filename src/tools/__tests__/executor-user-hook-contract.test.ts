import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { RULE_PROVENANCE } from "../../permissions/decision-provenance.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { createHookCommandAuthorizer } from "../../hooks/hook-command-policy.js";
import { bindHookConfigPaths } from "../../hooks/hook-config-trust.js";
import { parseHookConfig } from "../../hooks/hook-config.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import type { ApprovalChoice, ApprovalGate } from "../../permissions/approval-gate.js";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

function setup(event: string, errored = false, denied = false, targetAsks = false, hookAction = "block", options?: {
  audit: AuditLogger;
  command: string[];
  chooseHookAnswer: () => ApprovalChoice;
}) {
  const root = mkdtempSync(join(tmpdir(), "ave-executor-hook-contract-"));
  roots.push(root);
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => ({ output: errored ? "tool failed" : "tool completed", isError: errored }));
  registry.register(createDynamicTool({ name: "contract_probe", description: "Reads a bounded probe result",
    source: "builtin", category: targetAsks ? "write" : "read", isReadOnly: () => !targetAsks,
    jsonSchema: { type: "object", properties: {} }, execute }));
  const permissions = new PermissionManager(join(root, "permissions.json"));
  permissions.setRules([...(targetAsks ? [] : [{ pattern: "contract_probe", action: denied ? "deny" as const : "allow" as const }]), { pattern: "Bash(node *)", action: "allow" }]);
  const manager = new ScriptHookManager();
  const requestAndWait = answeringRequestAndWait(() => ({ choice: options?.chooseHookAnswer() ?? "allow-once" }));
  const commitStagedAllowSaves = vi.fn(async () => ({ saved: false }));
  const authorizeCommand = vi.fn(createHookCommandAuthorizer({ permissionManager: permissions,
    approvalGate: { requestAndWait, commitStagedAllowSaves } }));
  manager.setCommandAuthorizer(authorizeCommand);
  const parsed = parseHookConfig({ hooks: { [event]: [{ hooks: [{ type: "command", command: options?.command ?? ["node", COMMAND, hookAction] }] }] } });
  bindHookConfigPaths(parsed.entries, dirname(COMMAND));
  manager.setTrustedRegistry([], parsed.entries);
  const targetRequestAndWait = answeringRequestAndWait(() => ({ requestId: "target", choice: "deny-once" as const }));
  const gate = { requestAndWait: targetRequestAndWait } as unknown as ApprovalGate;
  const executor = new ToolExecutor(registry, undefined, permissions, undefined, gate, manager, options?.audit);
  return { execute, authorizeCommand, requestAndWait, targetRequestAndWait, permissions, commitStagedAllowSaves,
    run: () => executor.executeAll([{ id: "contract-tool", name: "contract_probe", input: {} }],
      { sessionId: "contract-session", permissionContext: userPermissionContext(options ? { trustOrigin: "llm-tool-arg" } : {}) }) };
}

// Windows path admission pins through the shipped path-kind helper; boot configures its resources first.
beforeAll(() => configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false }));

describe("user hook model feedback and permission precedence", () => {
  it.each([
    { throws: true, trustOrigin: "unknown", reason: "Permission recheck failed during approval." },
    { throws: false, trustOrigin: "llm-tool-arg", reason: "Hook command denied by a rule." },
  ])("audits a PreToolUse command approval refusal with $trustOrigin origin", async ({ throws, trustOrigin, reason }) => {
    const root = mkdtempSync(join(tmpdir(), "ave-executor-hook-audit-"));
    roots.push(root);
    const audit = new AuditLogger(join(root, "audit"));
    const marker = join(root, "hook-ran.txt");
    try {
      await audit.setupPermissionAuditChain("aa".repeat(32));
      const probe = setup("PreToolUse", false, false, true, "block", {
        audit,
        command: ["node", "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
        chooseHookAnswer: () => {
          vi.spyOn(probe.permissions, "checkDetailed").mockImplementationOnce(() => {
            if (throws) throw new Error("internal hook check detail");
            return { decision: "deny", provenance: RULE_PROVENANCE, reason };
          });
          return "allow-once";
        },
      });
      const [result] = await probe.run();
      expect(result.is_error).toBe(true);
      expect(probe.requestAndWait).toHaveBeenCalledOnce();
      expect(probe.execute).not.toHaveBeenCalled();
      expect(probe.targetRequestAndWait).not.toHaveBeenCalled();
      expect(probe.commitStagedAllowSaves).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
      const terminal = readFileSync(audit.getPermissionAuditLogFile(), "utf8").trim().split("\n")
        .map(line => JSON.parse(line)).filter(row => row.toolUseId === "contract-tool" && row.decision !== "ask");
      expect(terminal).toEqual([expect.objectContaining({ decision: "deny", trustOrigin,
        denyReasons: [expect.objectContaining({ reason: expect.stringContaining(reason) })] })]);
    } finally {
      await audit.close();
    }
  });

  it("returns exit-2 stderr to the model before the tool can execute", async () => {
    const probe = setup("PreToolUse");
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Policy requires a focused correction before proceeding.");
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
  });

  it.each(["PostToolUse", "PostToolUseFailure"])("returns %s stderr after preserving the tool outcome", async (event) => {
    const errored = event === "PostToolUseFailure";
    const probe = setup(event, errored);
    const [result] = await probe.run();
    expect(result.is_error === true).toBe(errored);
    expect(result.content).toContain(errored ? "tool failed" : "tool completed");
    expect(result.content).toContain("Policy requires a focused correction before proceeding.");
    expect(probe.execute).toHaveBeenCalledOnce();
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
  });

  it("runs a blocking pre-hook before target deny rules without executing the target", async () => {
    const probe = setup("PreToolUse", false, true);
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.authorizeCommand).toHaveBeenCalledOnce();
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
    expect(probe.targetRequestAndWait).not.toHaveBeenCalled();
  });

  it("blocks before a target approval card can appear", async () => {
    const probe = setup("PreToolUse", false, false, true);
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Policy requires a focused correction before proceeding.");
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
    expect(probe.targetRequestAndWait).not.toHaveBeenCalled();
    expect(probe.execute).not.toHaveBeenCalled();
  });

  it("cannot use a hook allow response to skip the target approval card", async () => {
    const probe = setup("PreToolUse", false, false, true, "echo");
    const [result] = await probe.run();
    expect(result.is_error).toBe(true);
    expect(probe.requestAndWait).toHaveBeenCalledOnce();
    expect(probe.targetRequestAndWait).toHaveBeenCalledOnce();
    expect(probe.execute).not.toHaveBeenCalled();
  });
});

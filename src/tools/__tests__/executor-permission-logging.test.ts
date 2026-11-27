import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { buildDiagnosticsBundle } from "../../audit/diagnostics-bundle.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { watchPermissionEvents } from "../../__tests__/support/permission-events.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { RULE_PROVENANCE } from "../../permissions/decision-provenance.js";
import { AuditWriter } from "../pipeline/audit-writer.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";

const CANARY = "NESTED_SECRET_CANARY_ba5c1a";
const CREDENTIAL_SHAPED_ID = "ghp_" + "aB1cD2eF3gH4jK5mN6pQ7rS8tU9vW0xY1zA2";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ave-permission-log-"));
  roots.push(root);
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => ({ output: CANARY, isError: false }));
  for (const name of ["allowed_tool", "denied_tool"]) {
    registry.register(createDynamicTool({
      name, description: "fixture", category: "read", source: "builtin",
      isReadOnly: () => true, jsonSchema: { type: "object" }, execute,
    }));
  }
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.checkDetailed = (name) => name === "denied_tool"
    ? { decision: "deny", provenance: RULE_PROVENANCE, reason: CANARY, reasonCode: "rule-deny", denyReasons: [{ source: "rule", reason: CANARY }] }
    : { decision: "allow", provenance: RULE_PROVENANCE, reason: CANARY, reasonCode: "rule-allow" };
  return { executor: new ToolExecutor(registry, undefined, manager), execute };
}

const opts = { sessionId: "permission-session", permissionContext: { trustOrigin: "user-keyboard" } } as const;

it("logs one decision per attempt without recording nested arguments, output, or reasons", async () => {
  const { executor, execute } = fixture();
  const records: Record<string, unknown>[] = [];
  watchPermissionEvents((entry) => {
    if (entry.event === "permission_decision") records.push(entry);
  });
  const result = await executor.executeAll([
    { id: "allow-1", name: "allowed_tool", input: { nested: { authorization: CANARY } } },
    { id: "deny-1", name: "denied_tool", input: { nested: { command: CANARY } } },
  ], opts);
  expect(result.map((row) => row.is_error ?? false)).toEqual([false, true]);
  expect(execute).toHaveBeenCalledOnce();
  expect(records).toHaveLength(2);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolUseId: "allow-1", decision: "allow", category: "read", reasonCode: "rule-allow", sessionId: "permission-session", attempt: 1 }),
    expect.objectContaining({ toolUseId: "deny-1", decision: "deny", terminalKind: "denied", reasonCode: "rule-deny", denialSource: "rule", sessionId: "permission-session", attempt: 1 }),
  ]));
  expect(JSON.stringify(records)).not.toContain(CANARY);
});

it("correlates an ask without recording its rule pattern", async () => {
  const observed = vi.fn();
  watchPermissionEvents(observed);
  await new AuditWriter(undefined).auditPermissionAsk(
    "allowed_tool", "builtin", "read", {},
    { decision: "ask", reasonCode: "rule-ask", reason: CANARY, provenance: RULE_PROVENANCE },
    "", opts.permissionContext, undefined, { toolUseId: "ask-1", attempt: 2 }, opts.sessionId,
  );
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({
    decision: "ask", reasonCode: "rule-ask", sessionId: "permission-session", toolUseId: "ask-1", attempt: 2,
  }));
  expect(JSON.stringify(observed.mock.calls)).not.toContain(CANARY);
});

it("does not change execution or repeat an effect when the logger throws", async () => {
  const { executor, execute } = fixture();
  const failing = vi.fn(() => { throw new Error("sink unavailable"); });
  watchPermissionEvents(failing);
  const result = await executor.executeAll([{ id: "allow-1", name: "allowed_tool", input: {} }], opts);
  expect(result[0]).toMatchObject({ tool_use_id: "allow-1", content: CANARY });
  expect(result[0]?.is_error).not.toBe(true);
  expect(execute).toHaveBeenCalledOnce();
  expect(failing).toHaveBeenCalledWith(expect.objectContaining({ event: "permission_decision", decision: "allow" }));
});

it("keeps the credential-shaped tool-call ID and nested canary out of production console, file and support bundle logs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-permission-log-sink-"));
  roots.push(root);
  const logsDir = join(root, "logs");
  const { VITEST: _vitest, ...inherited } = process.env;
  const script = [
    "import { initFileLogSink, closeFileLogSink } from \"./src/lib/logger.ts\";",
    "import { PermissionManager } from \"./src/permissions/permission-manager.ts\";",
    "import { ToolExecutor } from \"./src/tools/executor.ts\";",
    "import { ToolRegistry } from \"./src/tools/registry.ts\";",
    "import { createDynamicTool } from \"./src/tools/base.ts\";",
    "import { RULE_PROVENANCE } from \"./src/permissions/decision-provenance.ts\";",
    "import { join } from \"node:path\";",
    "import { configureHostResources } from \"./src/main/host-resources.ts\";",
    "configureHostResources({ resourcePath: join(process.cwd(), \"resources\"), isPackaged: false });",
    "const [root, logs, canary, toolUseId] = process.argv.slice(1);",
    "if (!initFileLogSink({ dir: logs })) throw new Error(\"Missing file sink\");",
    "const manager = new PermissionManager(join(root, \"permissions.json\"));",
    "manager.checkDetailed = () => ({ decision: \"allow\", reason: canary, provenance: RULE_PROVENANCE });",
    "const registry = new ToolRegistry();",
    "registry.register(createDynamicTool({ name: \"allow_probe\", description: \"probe\", category: \"read\", source: \"builtin\", isReadOnly: () => true, jsonSchema: { type: \"object\" }, execute: async () => ({ output: canary, isError: false }) }));",
    "const [result] = await new ToolExecutor(registry, undefined, manager).executeAll([{ id: toolUseId, name: \"allow_probe\", input: { nested: { command: canary } } }], { sessionId: \"permission-session\", permissionContext: { trustOrigin: \"user-keyboard\" } });",
    "if (result.is_error || result.content !== canary || result.tool_use_id !== toolUseId) throw new Error(\"Unexpected effect result\");",
    "closeFileLogSink();",
  ].join("\n");
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", script, "--", root, logsDir, CANARY, CREDENTIAL_SHAPED_ID,
  ], { env: { ...inherited, AVE_HOME: root, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", LOG_LEVEL: "info" }, windowsHide: true });
  const file = readdirSync(logsDir).map((name) => readFileSync(join(logsDir, name), "utf8")).join("\n");
  const bundle = new AdmZip(await buildDiagnosticsBundle({
    settings: DEFAULT_SETTINGS, appVersion: "test", crashDumpsDir: join(root, "crashes"), logsDir,
  }));
  const bundleLogs = bundle.getEntries().filter((entry) => entry.entryName.startsWith("logs/"))
    .map((entry) => entry.getData().toString("utf8")).join("\n");
  for (const output of [stdout, file, bundleLogs]) {
    const decisions = output.split("\n").filter((line) => line.includes("\"event\":\"permission_decision\""));
    expect(decisions).toHaveLength(1);
    expect(output).not.toContain(CREDENTIAL_SHAPED_ID);
    expect(output).not.toContain(CANARY);
  }
  expect(stderr).not.toContain(CANARY);
  expect(stderr).not.toContain(CREDENTIAL_SHAPED_ID);
});

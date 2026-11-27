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

it.each(["normal", "slow"])("logs safely to production console, file and support bundle with %s storage", async (storage) => {
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
    "import fs from \"node:fs\";",
    "import { syncBuiltinESMExports } from \"node:module\";",
    "import { setImmediate } from \"node:timers/promises\";",
    "import { desktopApprovalCardPresenters } from \"./src/main/desktop-approval-presentation.ts\";",
    "import { installApprovalCardPresenters } from \"./src/permissions/approval-presentation.ts\";",
    "import { ApprovalGate, IPC_APPROVAL_REQUEST } from \"./src/permissions/approval-gate.ts\";",
    "import { logPermissionEvent } from \"./src/lib/permission-log.ts\";",
    "import { drainToolInvocationsForExit } from \"./src/tools/invocation-ledger.ts\";",
    "import { configureHostResources } from \"./src/main/host-resources.ts\";",
    "configureHostResources({ resourcePath: join(process.cwd(), \"resources\"), isPackaged: false });",
    "const [root, logs, canary, toolUseId, storage] = process.argv.slice(1);",
    "if (!initFileLogSink({ dir: logs, ...(storage === \"slow\" ? { maxBytes: 1 } : {}) })) throw new Error(\"Missing file sink\");",
    "let asyncReads = 0, syncReads = 0, release;",
    "const held = new Promise((resolve) => { release = resolve; });",
    "const syncRead = fs.readdirSync, asyncRead = fs.promises.readdir;",
    "if (storage === \"slow\") {",
    "  fs.readdirSync = (dir, ...args) => { if (dir === logs) syncReads++; return syncRead(dir, ...args); };",
    "  fs.promises.readdir = async (dir, ...args) => { if (dir === logs) { asyncReads++; await held; } return asyncRead(dir, ...args); };",
    "  syncBuiltinESMExports();",
    "}",
    "const manager = new PermissionManager(join(root, \"permissions.json\"));",
    "manager.checkDetailed = () => ({ decision: \"allow\", reason: canary, provenance: RULE_PROVENANCE });",
    "const registry = new ToolRegistry();",
    "registry.register(createDynamicTool({ name: \"allow_probe\", description: \"probe\", category: \"read\", source: \"builtin\", isReadOnly: () => true, jsonSchema: { type: \"object\" }, execute: async () => ({ output: canary, isError: false }) }));",
    "const [result] = await new ToolExecutor(registry, undefined, manager).executeAll([{ id: toolUseId, name: \"allow_probe\", input: { nested: { command: canary } } }], { sessionId: \"permission-session\", permissionContext: { trustOrigin: \"user-keyboard\" } });",
    "if (result.is_error || result.content !== canary || result.tool_use_id !== toolUseId) throw new Error(\"Unexpected effect result\");",
    "await setImmediate();",
    "if (storage === \"slow\") {",
    "  if (syncReads || !asyncReads) throw new Error(\"Permission event used a synchronous roll scan\");",
    "  const uninstall = installApprovalCardPresenters(desktopApprovalCardPresenters);",
    "  let deliverCard;",
    "  const sent = new Promise((resolve) => { deliverCard = resolve; });",
    "  const gate = new ApprovalGate({ isDestroyed: () => false, send: (channel, payload) => { if (channel === IPC_APPROVAL_REQUEST) deliverCard(payload); } });",
    "  const pending = gate.requestAndWait({ id: \"sink-approval\", category: \"tool\", toolName: \"allow_probe\", source: \"builtin\", reason: \"fixture\", args: {}, createdAt: Date.now() });",
    "  const card = await Promise.race([sent, pending]);",
    "  if (!card?.id) throw new Error(\"No approval card was delivered: \" + card?.choice);",
    "  gate.resolve(card.id, { requestId: card.id, nonce: card.nonce, hmac: card.hmac, choice: \"allow-once\" });",
    "  if ((await pending).choice !== \"allow-once\") throw new Error(\"Approval did not settle while storage was slow\");",
    "  uninstall();",
    "  if (await drainToolInvocationsForExit(25) !== \"committed\") throw new Error(\"Forced drain waited on storage\");",
    "}",
    "closeFileLogSink();",
    "release();",
    "if (storage === \"slow\") {",
    "  await setImmediate();",
    "  for (let i = 0; i < 300; i++) logPermissionEvent(\"queue_probe\", { index: i });",
    "  await setImmediate();",
    "}",
  ].join("\n");
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", script, "--", root, logsDir, CANARY, CREDENTIAL_SHAPED_ID, storage,
  ], { env: { ...inherited, AVE_HOME: root, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", LOG_LEVEL: "info" }, windowsHide: true, timeout: 10_000 });
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
  if (storage === "slow") {
    const overflow = stdout.split("\n").find((line) => line.includes('\"event\":\"permission_log_overflow\"'));
    expect(JSON.parse(overflow ?? "{}")).toMatchObject({ dropped: 44 });
  }
  expect(stderr).not.toContain(CANARY);
  expect(stderr).not.toContain(CREDENTIAL_SHAPED_ID);
});

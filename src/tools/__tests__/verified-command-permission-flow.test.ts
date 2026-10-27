import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as childProcess from "node:child_process";
import * as shellResolver from "../../lib/shell-resolver.js";
import { resolveVerifiedExecutable } from "../../shared/verified-executable.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import * as verifiedCommands from "../../permissions/verified-shell-command.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST } from "../../permissions/approval-gate.js";
import { saveApprovalCardRule } from "../../permissions/approval-rule-save.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { preparedShellCommand } from "../prepared-shell-invocation.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";

vi.mock("node:child_process", { spy: true });
vi.mock("../../permissions/verified-shell-command.js", { spy: true });
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn() }));
vi.mock("../../lib/shell-resolver.js", { spy: true });
const originalPlatform = process.platform;
const COMMAND = "bash --noprofile --norc -p -c 'printf ready'";
const EXACT_RULE = "Bash(bash --noprofile --norc -p -c 'printf ready')";
let cwd: string;
let manager: PermissionManager;
let auditLogger: AuditLogger;
let gate: ApprovalGate;
beforeEach(() => {
  vi.clearAllMocks();
  setProcessPlatform("linux");
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "verified-permission-flow-")));
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  auditLogger = new AuditLogger(join(cwd, "audit"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
  __resetActiveSandboxCapabilityForTest();
  setShellSandboxRequestedAtBoot(false);
  vi.mocked(resolveVerifiedExecutable).mockReturnValue({ executable: "/usr/bin/bash" });
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw new Error("Native probes are outside this permission fixture"); });
  vi.mocked(shellResolver.resolveShell).mockReturnValue({ cmd: "/bin/bash", shellArgs: (command) => ["-c", command] });
  vi.mocked(shellResolver.shellEnvForChild).mockImplementation((_, environment) => ({ ...environment, LD_PRELOAD: "/untrusted-loader", DYLD_INSERT_LIBRARIES: "/untrusted-loader" }));
  vi.mocked(shellResolver.getBashCapabilities).mockReturnValue({ unicodeEscapes: true, prefixAssignmentRhs: "sequential" });
});
afterEach(async () => {
  gate?.disposeAll();
  await auditLogger.close();
  expect(auditLogger.getWriterStats()).toMatchObject({ pendingWrites: 0, pendingBytes: 0, acceptingWrites: false });
  setProcessPlatform(originalPlatform);
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

function fixture() {
  const wc = { send: vi.fn(), isDestroyed: () => false };
  gate = new ApprovalGate(wc as never, undefined, 3000);
  const registry = new ToolRegistry();
  const tool = new BashTool();
  const execute = vi.spyOn(tool, "execute").mockImplementation(async (_input, context) => {
    expect(context.verifiedShellCommand).toBeDefined();
    const prepared = preparedShellCommand(context.preparedShellInvocation!);
    expect(prepared.argv.at(-1)).toBe("'/usr/bin/bash' '--noprofile' '--norc' '-p' '-c' 'printf ready'");
    expect(prepared.environment).not.toHaveProperty("LD_PRELOAD");
    expect(prepared.environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(_input).toMatchObject({ command: COMMAND });
    return { output: "bound native output", isError: false };
  });
  registry.register(tool);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
  let serial = 0;
  const run = (headless: boolean, command = COMMAND) => runWithToolExecutionCwd(cwd, () => executor.executeAll(
    [{ id: `native-flow-${++serial}`, name: "bash", input: { command } }],
    { sessionId: "native-flow", permissionContext: userPermissionContext({ headless }) },
  ));
  return { wc, execute, run };
}

it("carries the issued native proof through canonical executor authorization to execution", async () => {
  const f = fixture();
  manager.setRules([withCurrentShellRuleVersion({ pattern: EXACT_RULE, action: "allow" })]);
  const [result] = await f.run(true);
  expect(result!.is_error).not.toBe(true);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.wc.send).not.toHaveBeenCalled();
});

it("keeps proof host-only through the card, persistent save and the next headless match", async () => {
  const f = fixture();
  const pending = f.run(false);
  await vi.waitFor(() => expect(f.wc.send.mock.calls.some(([channel]) => channel === IPC_APPROVAL_REQUEST)).toBe(true));
  const [, card] = f.wc.send.mock.calls.find(([channel]) => channel === IPC_APPROVAL_REQUEST)!;
  expect(card.shellRule).toMatchObject({ exactRule: EXACT_RULE, persistentAllowed: true });
  expect(card).not.toHaveProperty("verifiedShellCommand");
  const snapshot = gate.getRequestSnapshot(card.id)!;
  expect(snapshot.verifiedShellCommand).toBeDefined();
  expect(await saveApprovalCardRule(snapshot, { action: "allow", scope: "always" }, {
    decision: "allow", scope: "persistent", displayedVerdictAtApproval: snapshot.verdictAtApproval,
  }, manager)).toMatchObject({ ok: true });
  expect(await manager.listPersistedRules()).toContainEqual(expect.objectContaining({ pattern: EXACT_RULE, action: "allow" }));
  gate.resolve(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac });
  await pending;
  expect(f.execute).not.toHaveBeenCalled();
  const [next] = await f.run(true);
  expect(next!.is_error).not.toBe(true);
  expect(f.execute).toHaveBeenCalledOnce();
});

it("refuses a startup-proven recipe headlessly under a broad grant", async () => {
  const f = fixture();
  manager.setRules([withCurrentShellRuleVersion({ pattern: "Bash(bash *)", action: "allow" })]);
  const [result] = await f.run(true);
  expect(result!.is_error).toBe(true);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.wc.send).not.toHaveBeenCalled();
});

it.each([
  ["git log", "Bash(git log *)"],
  ["git show --no-patch HEAD", "Bash(git show *)"],
  ["git diff --cached --name-only", "Bash(git diff *)"],
  ["git diff --name-only 'HEAD~1' HEAD", "Bash(git diff *)"],
  ["git rev-parse --verify HEAD", "Bash(git rev-parse *)"],
  ["git branch --list", "Bash(git branch *)"],
])("keeps %s unproven through the canonical executor despite stored grants", async (command, broadRule) => {
  const f = fixture();
  const backend = vi.fn(() => { throw new Error("The reviewer backend must not run for an unproven command"); });
  manager.setReviewer({ classifier: { classify: backend }, cache: new VerdictCache(join(cwd, "verdicts.jsonl")), deferredQueue: new DeferredQueue(join(cwd, "deferred.jsonl")) });
  await manager.addRulePersist({ pattern: `Bash(${command})`, action: "allow" }, { kind: "user" });
  await manager.addRulePersist({ pattern: broadRule, action: "allow" }, { kind: "user" });
  expect(await manager.listPersistedRules()).toEqual(expect.arrayContaining([
    expect.objectContaining({ pattern: `Bash(${command})`, action: "allow" }),
    expect.objectContaining({ pattern: broadRule, action: "allow" }),
  ]));
  const [result] = await f.run(true, command);
  expect(result!.is_error).toBe(true);
  expect(f.execute).not.toHaveBeenCalled();
  expect(backend).not.toHaveBeenCalled();
  expect(f.wc.send).not.toHaveBeenCalled();
  expect(verifiedCommands.prepareVerifiedShellCommand).toHaveBeenCalledWith({ command, dialect: "bash", cwd });
  expect(verifiedCommands.prepareVerifiedShellCommand).toHaveReturnedWith(undefined);
  expect(resolveVerifiedExecutable).not.toHaveBeenCalled();
  expect(childProcess.execFileSync).not.toHaveBeenCalled();
  expect(childProcess.spawn).not.toHaveBeenCalled();
});

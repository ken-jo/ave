import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stabilizeFixtureAncestorStats } from "../../__tests__/support/fixture-ancestor-stats.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

vi.mock("node:fs", { spy: true });
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
  stabilizeFixtureAncestorStats(cwd);
  mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
  mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(cwd, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  auditLogger = new AuditLogger(join(cwd, "audit"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
  __resetActiveSandboxCapabilityForTest();
  setShellSandboxRequestedAtBoot(false);
  vi.mocked(resolveVerifiedExecutable).mockImplementation((candidates) => candidates[0] === undefined ? null : { executable: candidates[0].executable });
  vi.mocked(childProcess.execFileSync).mockImplementation((executable, args) => {
    if (executable === "/usr/bin/git" && args?.includes("--version")) return "git version 2.54.0\n";
    throw new Error("Unexpected native probe in permission fixture");
  });
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

function fixture(command = COMMAND) {
  const wc = { send: vi.fn(), isDestroyed: () => false };
  gate = new ApprovalGate(wc as never, undefined, 3000);
  const registry = new ToolRegistry();
  const tool = new BashTool();
  const execute = vi.spyOn(tool, "execute").mockImplementation(async (_input, context) => {
    expect(context.verifiedShellCommand).toBeDefined();
    const prepared = preparedShellCommand(context.preparedShellInvocation!);
    if (command === COMMAND) expect(prepared.argv.at(-1)).toBe("'/usr/bin/bash' '--noprofile' '--norc' '-p' '-c' 'printf ready'");
    else {
      expect(prepared.argv.at(-1)).toContain("'/usr/bin/git'");
      expect(prepared.argv.at(-1)).toContain(`'--git-dir=${join(cwd, ".git")}'`);
      expect(prepared.argv.at(-1)).toContain(`'--work-tree=${cwd}'`);
      expect(prepared.environment).toMatchObject({ GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, GIT_REFERENCE_BACKEND: "files", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
    }
    expect(prepared.environment).not.toHaveProperty("LD_PRELOAD");
    expect(prepared.environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(_input).toMatchObject({ command });
    return { output: "bound native output", isError: false };
  });
  registry.register(tool);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
  let serial = 0;
  const run = (headless: boolean, inputCommand = command) => runWithToolExecutionCwd(cwd, () => executor.executeAll(
    [{ id: `native-flow-${++serial}`, name: "bash", input: { command: inputCommand } }],
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
  ["git diff --raw HEAD main", "Bash(git diff *)"],
  ["git diff --name-only 'HEAD~1' HEAD", "Bash(git diff *)"],
  ["git rev-parse --verify HEAD", "Bash(git rev-parse *)"],
  ["git branch --list", "Bash(git branch *)"],
])("executes checked %s headlessly only after its exact grant", async (command, broadRule) => {
  const f = fixture(command);
  manager.setRules([withCurrentShellRuleVersion({ pattern: broadRule, action: "allow" })]);
  const [blocked] = await f.run(true);
  expect(blocked!.is_error).toBe(true);
  expect(f.execute).not.toHaveBeenCalled();
  manager.setRules([withCurrentShellRuleVersion({ pattern: `Bash(${command})`, action: "allow" })]);
  const [allowed] = await f.run(true);
  expect(allowed!.is_error).not.toBe(true);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.wc.send).not.toHaveBeenCalled();
});

it("offers the original checked repository command for persistent approval", async () => {
  const command = "git log 'HEAD'";
  const f = fixture(command);
  const pending = f.run(false);
  await vi.waitFor(() => expect(f.wc.send.mock.calls.some(([channel]) => channel === IPC_APPROVAL_REQUEST)).toBe(true));
  const [, card] = f.wc.send.mock.calls.find(([channel]) => channel === IPC_APPROVAL_REQUEST)!;
  expect(card.shellRule).toMatchObject({ exactRule: "Bash(git log 'HEAD')", persistentAllowed: true });
  expect(card).not.toHaveProperty("verifiedShellCommand");
  const snapshot = gate.getRequestSnapshot(card.id)!;
  expect(snapshot.verifiedShellCommand).toBeDefined();
  expect(await saveApprovalCardRule(snapshot, { action: "allow", scope: "always" }, {
    decision: "allow", scope: "persistent", displayedVerdictAtApproval: snapshot.verdictAtApproval,
  }, manager)).toMatchObject({ ok: true });
  gate.resolve(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac });
  await pending;
  const [next] = await f.run(true);
  expect(next!.is_error).not.toBe(true);
  expect(f.execute).toHaveBeenCalledOnce();
});

it.each([
  ["git status", "Bash(git status *)"],
  ["git show HEAD", "Bash(git show *)"],
  ["git diff --name-only", "Bash(git diff *)"],
  ["git diff --cached --name-only", "Bash(git diff *)"],
  ["git diff --staged --name-only", "Bash(git diff *)"],
  ["git diff --staged --raw", "Bash(git diff *)"],
  ["git diff --cached --stat", "Bash(git diff *)"],
  ["git log --show-signature", "Bash(git log *)"],
])("keeps unsupported %s unproven through the canonical executor despite stored grants", async (command, broadRule) => {
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
  expect(childProcess.spawn).not.toHaveBeenCalled();
});

it("rejects unsafe repository inputs despite persisted exact and broad grants", async () => {
  const f = fixture("git log");
  writeFileSync(join(cwd, ".git", "config"), "[include]\n\tpath = outside-config\n");
  manager.setRules([
    withCurrentShellRuleVersion({ pattern: "Bash(git log)", action: "allow" }),
    withCurrentShellRuleVersion({ pattern: "Bash(git *)", action: "allow" }),
  ]);
  const [result] = await f.run(true);
  expect(result!.is_error).toBe(true);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.wc.send).not.toHaveBeenCalled();
  expect(verifiedCommands.prepareVerifiedShellCommand).toHaveReturnedWith(undefined);
});

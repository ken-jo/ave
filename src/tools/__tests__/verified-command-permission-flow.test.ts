import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as childProcess from "node:child_process";
import * as shellResolver from "../../lib/shell-resolver.js";
import { resolveVerifiedExecutable } from "../../shared/verified-executable.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
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
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn() }));
vi.mock("../../lib/shell-resolver.js", { spy: true });
const originalPlatform = process.platform;
let cwd: string;
let manager: PermissionManager;
let gate: ApprovalGate;
beforeEach(() => {
  setProcessPlatform("linux");
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "verified-permission-flow-")));
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
  __resetActiveSandboxCapabilityForTest();
  setShellSandboxRequestedAtBoot(false);
  vi.mocked(resolveVerifiedExecutable).mockReturnValue({ executable: "/usr/bin/git" });
  vi.mocked(childProcess.execFileSync).mockReturnValue("git version 2.45.0\n");
  vi.mocked(shellResolver.resolveShell).mockReturnValue({ cmd: "/bin/bash", shellArgs: (command) => ["-c", command] });
  vi.mocked(shellResolver.getBashCapabilities).mockReturnValue({ unicodeEscapes: true, prefixAssignmentRhs: "sequential" });
});
afterEach(() => {
  gate?.disposeAll();
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
    expect(prepared.argv.at(-1)).toContain("'/usr/bin/git'");
    expect(prepared.environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(prepared.environment.GIT_NO_LAZY_FETCH).toBe("1");
    return { output: "bound native output", isError: false };
  });
  registry.register(tool);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate);
  let serial = 0;
  const run = (headless: boolean) => runWithToolExecutionCwd(cwd, () => executor.executeAll(
    [{ id: `native-flow-${++serial}`, name: "bash", input: { command: "git log" } }],
    { sessionId: "native-flow", permissionContext: userPermissionContext({ headless }) },
  ));
  return { wc, execute, run };
}

it("carries the issued native proof through canonical executor authorization to execution", async () => {
  const f = fixture();
  manager.setRules([withCurrentShellRuleVersion({ pattern: "Bash(git log)", action: "allow" })]);
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
  expect(card.shellRule).toMatchObject({ exactRule: "Bash(git log)", persistentAllowed: true });
  expect(card).not.toHaveProperty("verifiedShellCommand");
  const snapshot = gate.getRequestSnapshot(card.id)!;
  expect(snapshot.verifiedShellCommand).toBeDefined();
  expect(await saveApprovalCardRule(snapshot, { action: "allow", scope: "always" }, {
    decision: "allow", scope: "persistent", displayedVerdictAtApproval: snapshot.verdictAtApproval,
  }, manager)).toMatchObject({ ok: true });
  expect(await manager.listPersistedRules()).toContainEqual(expect.objectContaining({ pattern: "Bash(git log)", action: "allow" }));
  gate.resolve(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac });
  await pending;
  expect(f.execute).not.toHaveBeenCalled();
  const [next] = await f.run(true);
  expect(next!.is_error).not.toBe(true);
  expect(f.execute).toHaveBeenCalledOnce();
});

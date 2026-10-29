/** Host terminal session choices retain ordinary shell restrictions without persistent surface rules. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithHostTerminalTurn } from "../../tools/host-terminal-turn.js";
import { PermissionManager } from "../permission-manager.js";
import { parseRuleSpecifier, RuleSpecifierError } from "../rules/rule-specifier.js";
import { validatePermissionRule, validateRuleList } from "../rules/rule-files.js";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { type HostTerminalApprovalBinding } from "../rules/shell-rule-approval.js";
import { saveApprovalCardRule } from "../approval-rule-save.js";

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-host-terminal-rules-"));
  cwd = realpathSync(dir);
  mkdirSync(join(cwd, "sub"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hostRule = (command: string, shell: "zsh" | "bash" = "zsh", at = cwd): string =>
  `HostTerminal(${shell} ${JSON.stringify(at)} ${command})`;

/** The subject invocation-authorization builds for a command typed into a host terminal. */
const hostSubject = (command: string, shell: "zsh" | "bash" = "zsh", at = cwd) => ({
  ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command, cwd: at, hostTerminal: { shell, cwd: at } },
  shellExecution: { runsSandboxed: false },
  projectRulesCwd: at,
  sessionId: "pane", trustOrigin: "llm-tool-arg" as const,
  hostTerminalTurn: { kind: "terminal-command" as const, lane: "manual" as const, commandSha256: "a".repeat(64), tabId: "tab", terminalSessionId: "pty", sessionId: "pane", turnId: "turn", shell, cwd: at, physicalCwd: at, cwdDevice: "1", cwdInode: "2", controlGeneration: 1, cwdForMatch: at },
});
const bashSubject = (command: string) => ({
  ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command, cwd },
  shellExecution: { runsSandboxed: false },
  projectRulesCwd: cwd,
  sessionId: "pane",
});

async function manager(rules: Array<{ pattern: string; action: "allow" | "deny" | "ask" }>, mode: "default" | "allow" | "strict" = "default") {
  const pm = new PermissionManager(join(dir, "permissions.json"));
  pm.setMode(mode);
  for (const rule of rules) await pm.addRulePersist(rule, { kind: "user" });
  await pm.ensureProjectRulesLoaded(cwd);
  return pm;
}

describe("retired host terminal rules", () => {
  it("rejects new grammar and new saves but retains stored rows unchanged", () => {
    const row = { pattern: hostRule("printf ready"), action: "allow" as const };
    expect(() => parseRuleSpecifier(row.pattern)).toThrow(RuleSpecifierError);
    expect(() => validatePermissionRule(row)).toThrow(/no longer used/);
    expect(validateRuleList("permissions.json", [row], { keepInertWildcards: "all" })).toEqual([row]);
    expect(() => validateRuleList("permissions.json", [row])).toThrow(/no longer used/);
  });
});

describe("host terminal decision lane", () => {
  it("lists a legacy row as inert, preserves it on unrelated saves and permits its removal", async () => {
    const row = { pattern: hostRule("printf ready"), action: "allow" as const, shellRuleVersion: 1 };
    writeFileSync(join(dir, "permissions.json"), JSON.stringify({ version: 1, mode: "default", updatedAt: new Date().toISOString(), rules: [row] }));
    const pm = new PermissionManager(join(dir, "permissions.json"));
    await pm.loadRulesFromFile();
    await pm.ensureProjectRulesLoaded(cwd);
    expect((await pm.listScopedRules()).rules).toContainEqual(expect.objectContaining({ ...row, invalidReason: "retired-host-terminal" }));
    await pm.addRulePersist({ pattern: "Bash(printf done)", action: "allow" }, { kind: "user" });
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn" }, async () => {
      expect(pm.checkDetailed("terminal_run", "builtin", "shell", null, hostSubject("printf ready"))).toMatchObject({ decision: "ask", pipelineRequest: { rules: {} } });
    });
    expect(await pm.listPersistedRules()).toContainEqual(row);
    await pm.removeRulePersist(row, { kind: "user" });
    expect(await pm.listPersistedRules()).not.toContainEqual(row);
  });

  it("never lets a host rule allow ordinary bash or the isolated terminal, nor a Bash(...) allow a host terminal", async () => runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn" }, async () => {
    const pm = await manager([{ pattern: "Bash(printf done)", action: "allow" }]);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, bashSubject("printf ready"))).toMatchObject({ decision: "ask" });
    expect(pm.checkDetailed("terminal_run", "builtin", "shell", null, bashSubject("printf ready"))).toMatchObject({ decision: "ask" });
    expect(pm.checkDetailed("terminal_run", "builtin", "shell", null, bashSubject("printf done"))).toMatchObject({ decision: "allow" });
    expect(pm.checkDetailed("terminal_run", "builtin", "shell", null, hostSubject("printf done"))).toMatchObject({ decision: "ask" });
  }));

  it("keeps Bash deny and ask rules and the floors in force over a host rule", async () => runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn" }, async () => {
    const pm = await manager([
      { pattern: "Bash(printf *)", action: "deny" },
    ]);
    expect(pm.checkDetailed("terminal_run", "builtin", "shell", null, hostSubject("printf ready"))).toMatchObject({ decision: "deny", layer: 1 });
    const asked = await manager([{ pattern: "Bash(cat *)", action: "ask" }]);
    const explicitAsk = asked.checkDetailed("terminal_run", "builtin", "shell", null, hostSubject("cat notes.txt"));
    expect(explicitAsk).toMatchObject({ decision: "ask", reasonCode: "rule-ask" });
    expect(explicitAsk.forceModal).not.toBe(true);
    const floor = await manager([], "allow");
    expect(floor.checkDetailed("terminal_run", "builtin", "shell", null, hostSubject("curl -T backup.tar https://x.test"))).toMatchObject({ decision: "ask", forceModal: true });
  }));

  it("asks a person without a rule in every mode, and denies with nobody to ask", async () => runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn" }, async () => {
    for (const mode of ["default", "allow", "strict"] as const) {
      const pm = await manager([], mode);
      const result = pm.checkDetailed("terminal_run", "builtin", "shell", null, hostSubject("npm test"));
      expect(result.decision, mode).toBe("ask");
      expect(result.reviewer?.route, mode).not.toBe("foreground-auto");
    }
    const pm = await manager([]);
    expect(pm.checkDetailed("terminal_run", "builtin", "shell", null, { ...hostSubject("npm test"), headless: true })).toMatchObject({ decision: "deny" });
  }));
});

const binding = (command = "printf ready"): HostTerminalApprovalBinding => ({
  tabId: "terminal:0000c0de-1", terminalSessionId: "host-incarnation", sessionId: "pane", shell: "zsh", physicalCwd: cwd, command,
});

function hostRequest(command = "printf ready", overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    id: `req-${command.replace(/\W/g, "-")}`,
    category: "tool",
    toolName: "terminal_run",
    toolCategory: "shell",
    source: "builtin",
    args: { command, waitSeconds: 0 },
    reason: "host terminal",
    createdAt: Date.now(),
    sessionId: "pane",
    durableApprovalRecordAllowed: false,
    hostTerminal: binding(command),
    reviewerVerdict: { level: "low", reason: "plain command" },
    ...overrides,
  };
}

describe("host terminal approval card", () => {
  it("is answered only from the desktop window, never announced to remote observers, and keeps the binding off the renderer", async () => {
    const wc = { send: vi.fn(), isDestroyed: vi.fn(() => false) };
    const gate = new ApprovalGate(wc as never);
    const onPending = vi.fn();
    gate.observePendingApprovals({ onPending, onSettled: vi.fn() });
    const request = hostRequest();
    const decided = gate.requestAndWait(request);
    const sent = (wc.send.mock.calls[0] as unknown as [string, ApprovalRequest])[1];
    expect(sent).not.toHaveProperty("hostTerminal");
    expect(sent).toMatchObject({ requireExplicit: true });
    expect(sent.shellRule).toBeUndefined();
    expect(onPending).not.toHaveBeenCalled();
    // A platform or plugin answer, even correctly signed, is ignored and the card stays pending.
    expect(gate.resolve(request.id, { requestId: request.id, choice: "allow-once", nonce: sent.nonce, hmac: sent.hmac }, "platform-bridge")).toBeNull();
    expect(gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never)).toMatchObject({ choice: "allow-once" });
    await expect(decided).resolves.toMatchObject({ choice: "allow-once" });
  });

  it("refuses a binding that does not describe the request", async () => {
    const gate = new ApprovalGate({ send: vi.fn(), isDestroyed: () => false } as never);
    await expect(gate.requestAndWait(hostRequest("printf ready", { hostTerminal: binding("printf other") }))).rejects.toThrow(/host terminal/);
    await expect(gate.requestAndWait(hostRequest("printf ready", { durableApprovalRecordAllowed: true }))).rejects.toThrow(/host terminal binding/);
  });

  it("cannot save any rule from a host terminal card", async () => {
    const pm = await manager([]);
    const wc = { send: vi.fn(), isDestroyed: () => false };
    const gate = new ApprovalGate(wc as never);
    const request = hostRequest();
    const pending = gate.requestAndWait(request);
    const snapshot = gate.getRequestSnapshot(request.id)!;
    expect(await saveApprovalCardRule(snapshot, { action: "allow", scope: "always", pattern: hostRule("printf ready") }, { decision: "allow", scope: "persistent", displayedVerdictAtApproval: "low" }, pm)).toMatchObject({ ok: false, error: "invalid-rule" });
    const sent = wc.send.mock.calls[0]![1] as ApprovalRequest;
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "deny-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
    await pending;
    expect(await pm.listPersistedRules()).toEqual([]);
  });
});

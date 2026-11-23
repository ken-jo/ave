// windows-permission
import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { canonicalRuleSpecifier } from "../rules/rule-specifier.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { countDecisionWork, decisionWorkSummary, expectLinearDecisionWork } from "../../__tests__/support/permission-decision-cost.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
// #223 executable-bound startup admission: win32 literal text cannot offer or replay exact rules.
const UNPROVEN_STARTUP = process.platform === "win32";
let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "visible-literal-")));
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("default");
});
afterEach(() => {
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

function check(command: string, dialect: ShellRuleDialect, sandboxed = false, headless = false) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd },
    shellExecution: { runsSandboxed: sandboxed }, sessionId: SESSION_ID, headless,
  });
}

// Bounded work, not latency: the decision's work is counted at module boundaries (see permission-decision-cost.ts), so the result is the
// same on every host and under any load. Repeating a decision must repeat exactly the same work.
function measured(command: string, dialect: ShellRuleDialect, sandboxed: boolean) {
  const results = [];
  const counted = [];
  for (let observation = 0; observation < 3; observation += 1) {
    const { result, work } = countDecisionWork(() => check(command, dialect, sandboxed));
    results.push(result);
    counted.push(work);
  }
  const work = counted[0]!;
  for (const repeated of counted) expect(decisionWorkSummary(repeated)).toEqual(decisionWorkSummary(work));
  return { results, work };
}

describe("visible literal decision regressions", () => {
  it("bounds repeated ambiguous path segments inside one quoted argument", () => {
    manager.setMode("allow");
    const observations = [64, 128, 256].map((repetitions) => {
      const command = `printf %s './${"AppData/Local/a/User Data/b/".repeat(repetitions)}tail'`;
      return { repetitions, command, ...measured(command, "bash", true) };
    });
    process.stdout.write(`literal path work ${JSON.stringify(observations.map(({ repetitions, command, work }) => ({ repetitions, chars: command.length, work: decisionWorkSummary(work) })))}\n`);
    for (const { results } of observations) {
      for (const result of results) expect(result).toMatchObject({ decision: "allow" });
    }
    // 64 repetitions stay under the literal-proof length (a read-only proof); from 112 on the decision takes the allow-mode lane, so the work at
    // 256 is compared with 112 (a spread above two).
    const full = observations.find(({ repetitions }) => repetitions === 256);
    if (full === undefined) throw new Error("the 256-repetition observation is missing");
    const half = { command: `printf %s './${"AppData/Local/a/User Data/b/".repeat(112)}tail'` };
    const smaller = measured(half.command, "bash", true);
    for (const result of [...smaller.results, ...full.results]) expect(result).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    // The one quoted argument (and the two words before it) is the only operand.
    expectLinearDecisionWork(smaller.work, full.work, full.command.length / half.command.length, 3);
  });

  it("keeps quoted numeric text distinct through persisted exact rule replay", async () => {
    const saved = "Write-Output '0x10'";
    const different = "Write-Output 0x10";
    const approval = buildShellRuleApproval("powershell", saved, cwd, { allow: true, deny: true });
    expect(approval.exactRule).toBe(UNPROVEN_STARTUP ? null : "PowerShell(Write-Output '0x10')");
    await manager.addRulePersist({ pattern: "PowerShell(Write-Output '0x10')", action: "allow" }, { kind: "user" });
    manager = new PermissionManager(join(cwd, "permissions.json"));
    await manager.loadRulesFromFile();
    const keys = [saved, different].map((command) => canonicalRuleSpecifier(`PowerShell(${command})`));
    const savedResult = check(saved, "powershell");
    const other = check(different, "powershell");
    const headless = check(different, "powershell", false, true);
    process.stdout.write(`literal identity ${JSON.stringify({ keys, exactRule: approval.exactRule, savedResult, other, headless })}\n`);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe("PowerShell(Write-Output '0x10')");
    expect(savedResult).toMatchObject(UNPROVEN_STARTUP
      ? { decision: "ask", reasonCode: "shell-approval" } : { decision: "allow" });
    expect(check(saved, "powershell", false, true).decision).toBe(UNPROVEN_STARTUP ? "deny" : "allow");
    expect(other.decision).toBe("ask");
    expect(headless.decision).toBe("deny");
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) => [
    { dialect, command: "pwsh -File - -enc P" },
    { dialect, command: "pwsh '\u0085-enc\u0085' P" },
  ]))("excludes ambiguous encoded launcher options in $dialect: $command", async ({ dialect, command }) => {
    const exactRule = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule;
    const kind = dialect === "bash" ? "Bash" : "PowerShell";
    // A manually saved current-format rule must not bypass the proof gate either.
    await manager.addRulePersist({ pattern: canonicalRuleSpecifier(`${kind}(${command})`), action: "allow" }, { kind: "user" });
    const interactive = check(command, dialect);
    const headless = check(command, dialect, false, true);
    process.stdout.write(`literal launcher ${JSON.stringify({ dialect, command, exactRule, interactive, headless })}\n`);
    expect(exactRule).toBeNull();
    expect(interactive.decision).toBe("ask");
    expect(headless.decision).toBe("deny");
  });

  it("allows a literal pipeline without speculative per-span reservations", async () => {
    const sentence = "Document the configuration options and clarify the expected behavior for developers. ";
    const prefix = "Write-Output '";
    const suffix = "' | Select-Object -First 1 | Out-String";
    // The same pipeline at a quarter of the length, with its own saved stage rules, for the growth comparison.
    const pipeline = (length: number): { command: string; first: string } => {
      const count = length - prefix.length - suffix.length;
      const first = `${prefix}${sentence.repeat(Math.ceil(count / sentence.length)).slice(0, count)}'`;
      return { command: `${first} | Select-Object -First 1 | Out-String`, first };
    };
    const { command, first } = pipeline(1_800);
    const small = pipeline(450);
    expect(command.length).toBe(1_800);
    for (const stage of [first, small.first, "Select-Object -First 1", "Out-String"]) {
      await manager.addRulePersist({ pattern: canonicalRuleSpecifier(`PowerShell(${stage})`), action: "allow" }, { kind: "user" });
    }
    const work = measured(command, "powershell", false);
    const smaller = measured(small.command, "powershell", false);
    const headless = check(command, "powershell", false, true);
    process.stdout.write(`literal pipeline work ${JSON.stringify({ chars: command.length, smallChars: small.command.length, work: decisionWorkSummary(work.work), smallWork: decisionWorkSummary(smaller.work), headless })}\n`);
    for (const result of [...work.results, ...smaller.results]) expect(result).toMatchObject(UNPROVEN_STARTUP
      ? { decision: "ask", reasonCode: "shell-approval" } : { decision: "allow" });
    expect(headless).toMatchObject(UNPROVEN_STARTUP ? { decision: "deny", reasonCode: "no-approver" } : { decision: "allow" });
    expectLinearDecisionWork(smaller.work, work.work, command.length / small.command.length, 0);
  });
});

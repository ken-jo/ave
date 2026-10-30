import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, type Profiler } from "node:inspector";
import { gzipSync } from "node:zlib";
import { PermissionManager } from "../permission-manager.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { canonicalRuleSpecifier } from "../rules/rule-specifier.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DECISION_COST_TARGET_MS = 40;
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

function measured(command: string, dialect: ShellRuleDialect, sandboxed: boolean) {
  const samples: number[] = [];
  const starts: number[] = [];
  const results = [];
  for (let observation = 0; observation < 3; observation += 1) {
    const start = performance.now();
    starts.push(start);
    const result = check(command, dialect, sandboxed);
    samples.push(performance.now() - start);
    results.push(result);
  }
  return { starts, samples, median: [...samples].sort((a, b) => a - b)[1]!, results };
}

async function captureCostProfile<T>(observe: () => T): Promise<T> {
  if (process.platform !== "win32") return observe();
  const session = new Session();
  session.connect();
  const post = (method: "Profiler.enable" | "Profiler.start") => new Promise<void>((resolve, reject) => {
    session.post(method, error => error ? reject(error) : resolve());
  });
  await post("Profiler.enable");
  await post("Profiler.start");
  process.stdout.write(`literal cost profile clock ${JSON.stringify({ now: performance.now(), monotonicMicros: Number(process.hrtime.bigint() / 1000n) })}\n`);
  try { return observe(); }
  finally {
    try {
      const profile = await new Promise<Profiler.Profile>((resolve, reject) => {
        session.post("Profiler.stop", (error, result) => error ? reject(error) : resolve(result.profile));
      });
      const packed = gzipSync(JSON.stringify(profile)).toString("base64");
      for (let offset = 0; offset < packed.length; offset += 6000) {
        process.stdout.write(`literal cost profile ${offset / 6000} ${packed.slice(offset, offset + 6000)}\n`);
      }
    } finally { session.disconnect(); }
  }
}

describe("visible literal decision regressions", () => {
  it("bounds literal-body inspection without treating serialized argv as new code", async () => {
    manager.setMode("allow");
    const observations = await captureCostProfile(() => [64, 128, 256].map((repetitions) => {
      const command = `printf %s './${"AppData/Local/a/User Data/b/".repeat(repetitions)}tail'`;
      const timing = measured(command, "bash", true);
      return { repetitions, chars: command.length, ...timing };
    }));
    process.stdout.write(`literal path timing ${JSON.stringify(observations)}\n`);
    for (const { repetitions, median, results } of observations) {
      expect(median).toBeLessThan(DECISION_COST_TARGET_MS);
      for (const result of results) expect(result).toMatchObject(repetitions === 256
        ? { decision: "deny", reasonCode: "shell-analysis-limit" }
        : { decision: "allow", reasonCode: repetitions === 64 ? "read-only-shell" : "allow-mode" });
    }
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

  it("refuses a literal pipeline when required body inspection exceeds the shared budget", async () => {
    const sentence = "Document the configuration options and clarify the expected behavior for developers. ";
    const prefix = "Write-Output '";
    const suffix = "' | Select-Object -First 1 | Out-String";
    const count = 1_800 - prefix.length - suffix.length;
    const first = `${prefix}${sentence.repeat(Math.ceil(count / sentence.length)).slice(0, count)}'`;
    const command = `${first} | Select-Object -First 1 | Out-String`;
    expect(command.length).toBe(1_800);
    for (const stage of [first, "Select-Object -First 1", "Out-String"]) {
      await manager.addRulePersist({ pattern: canonicalRuleSpecifier(`PowerShell(${stage})`), action: "allow" }, { kind: "user" });
    }
    const timing = measured(command, "powershell", false);
    const headless = check(command, "powershell", false, true);
    process.stdout.write(`literal pipeline timing ${JSON.stringify({ chars: command.length, ...timing, headless })}\n`);
    for (const result of timing.results) expect(result).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    expect(headless).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    expect(timing.median).toBeLessThan(DECISION_COST_TARGET_MS);
  });
});

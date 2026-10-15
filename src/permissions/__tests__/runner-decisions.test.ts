import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "../rules/shell-exfiltration.js";
import { analyzeShellForRules, evaluateShellRules } from "../rules/shell-rule-matcher.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";
import { RUNNER_DECISIONS } from "./fixtures/runner-decisions.js";

const CWD = "/work/project";
let directory: string;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "ave-runner-decisions-")); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

function runnerManager(name: string): PermissionManager {
  const manager = new PermissionManager(join(directory, `${name}.json`));
  manager.setMode("allow");
  return manager;
}

function prefixRule(command: string) {
  const shape = analyzeShellForRules(command);
  if (!shape.ok || shape.commands.length !== 1) throw new Error("Expected one literal command");
  const pattern = `Bash(${shape.commands[0]!.argv.slice(0, 2).join(" ")} *)`;
  const spec = parseRuleSpecifier(pattern);
  if (spec.kind !== "bash") throw new Error("Expected shell rule");
  return { pattern, spec };
}

describe("shared runner decisions", () => {
  it.each(["npx", "pnpx", "bunx", "yarn dlx", "pnpm dlx"].flatMap((runner) =>
    ["node", "tsx", "ts-node"].map((interpreter) => ({ runner, interpreter }))))
  ("retains direct interpreter visibility through $runner -> $interpreter", ({ runner, interpreter }) => {
    const direct = `${interpreter} evil.js`;
    const forwarded = `${runner} ${direct}`;
    const shape = analyzeShellForRules(forwarded);
    expect(shape.ok).toBe(true);
    if (shape.ok) {
      expect(shape.hidden).toEqual(analyzeShellForRules(direct).hidden);
      expect(shape.hidden.length).toBeGreaterThan(0);
    }
    for (const command of [direct, forwarded]) {
      expect(evaluateShellRules(command, { allow: [prefixRule(command)], deny: [], ask: [] }).decision).toBeNull();
    }
  });

  it.each(RUNNER_DECISIONS.flatMap((row) => [row, { ...row, command: `& ${row.command}`, powerShell: row.callPowerShell ?? row.powerShell }]))
  ("applies the command decision: $command -> $powerShell", ({ command, powerShell }) => {
    const manager = runnerManager("command");
    const result = manager.checkDetailed("powershell", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "powershell", command, cwd: CWD },
    });
    expect(result.decision).toBe(powerShell === "normal" ? "allow" : "ask");
    expect(result.forceModal === true).toBe(powerShell === "floor");
    if (powerShell === "ordinary") expect(inspectPowerShellCommand(command, CWD).exfiltration).toBeNull();
  });

  it.each(RUNNER_DECISIONS.filter((row) => row.bash !== null))
  ("applies shell visibility and rule coverage: $command -> $bash", ({ command, bash }) => {
    const manager = runnerManager("shell");
    const result = manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd: CWD },
    });
    expect(result.decision).toBe(bash === "ordinary" || bash === "floor" ? "ask" : "allow");
    expect(result.forceModal === true).toBe(bash === "floor");
    if (bash === "ordinary") {
      const shape = analyzeShellForRules(command);
      expect(shape).toMatchObject({ ok: true, hidden: [], allowBlockers: [] });
      if (shape.ok) expect(shape.commands.flatMap((entry) => entry.allowBlockers)).toEqual([]);
      expect(shellExfiltrationSignal(command, CWD)).toBeNull();
      expect(shellSensitivePathSignal(command, CWD)).toBeNull();
      expect(evaluateShellRules(command, { allow: [prefixRule(command)], deny: [], ask: [] }).decision).toBe("allow");
    } else if (bash === "hidden") {
      const shape = analyzeShellForRules(command);
      expect(shape.ok).toBe(true);
      if (shape.ok) expect(shape.hidden.length).toBeGreaterThan(0);
      expect(evaluateShellRules(command, { allow: [prefixRule(command)], deny: [], ask: [] }).decision).toBeNull();
    }
  });

  it.each(["npm run build --future-task-flag", "pnpm build --future-task-flag", "yarn build --future-task-flag", "deno test --future-task-flag"])
  ("honors persisted rules and remembered grants for unknown options: %s", async (command) => {
    const manager = runnerManager(command.split(" ")[0]!);
    const subject = (dialect: "bash" | "powershell") => ({ ruleSubject: { kind: "shell" as const, dialect, command, cwd: CWD } });
    expect(manager.checkDetailed("bash", "builtin", "shell", null, subject("bash"))).toMatchObject({ decision: "ask" });
    await manager.addRulePersist({ pattern: prefixRule(command).pattern, action: "allow" }, { kind: "user" });
    expect(manager.checkDetailed("bash", "builtin", "shell", null, subject("bash"))).toMatchObject({ decision: "allow", layer: 3 });
    const pending = manager.checkDetailed("powershell", "builtin", "shell", null, subject("powershell"));
    expect(pending.decision).toBe("ask");
    expect(pending.forceModal).toBeUndefined();
    await manager.addAlwaysAllowedPersist("powershell");
    expect(manager.checkDetailed("powershell", "builtin", "shell", null, subject("powershell"))).toMatchObject({ decision: "allow" });
  });
});

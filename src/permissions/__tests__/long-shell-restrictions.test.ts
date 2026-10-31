import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { decidePermission, NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { parsePowerShellCommand, powerShellRuleShape } from "../rules/powershell-exfiltration.js";
import { MAX_LITERAL_COMMAND_LENGTH } from "../rules/shell-prefix-values.js";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "long-shell-restrictions-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const MODES = ["strict", "default", "auto", "allow"] as const;
const CASES = (["bash", "powershell"] as const).flatMap(dialect => MODES.map(mode => ({ dialect, mode })));
const COMMAND = `printf ${"x".repeat(MAX_LITERAL_COMMAND_LENGTH + 1)}`;

function managerFor(dialect: "bash" | "powershell", mode: typeof MODES[number], action: PermissionRule["action"]) {
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode(mode);
  const pattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(printf *)`;
  manager.setRules([withCurrentShellRuleVersion({ pattern, action })]);
  return { manager, pattern, check: (headless = false) => manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command: COMMAND, cwd: root },
    shellExecution: { runsSandboxed: false }, headless,
  }) };
}

describe("restrictions beyond reusable shell identity limits", () => {
  it("does not reuse restrictive syntax as long-command allow proof", () => {
    const parsed = parsePowerShellCommand(COMMAND);
    expect(powerShellRuleShape(parsed, { restrictionsOnly: true })).toMatchObject({ ok: true, commands: [["printf", "x".repeat(MAX_LITERAL_COMMAND_LENGTH + 1)]] });
    expect(powerShellRuleShape(parsed)).toEqual({ ok: false, reason: "literal command length limit exceeded", visible: [] });
    expect(parsed.facts.has("restriction-shape")).toBe(true);
    expect(parsed.facts.has("rule-shape")).toBe(false);
  });
  it.each(CASES)("deny still wins for $dialect in $mode", ({ dialect, mode }) => {
    expect(COMMAND.length).toBeGreaterThan(MAX_LITERAL_COMMAND_LENGTH);
    expect(COMMAND.length).toBeLessThan(8_000);
    const { check, pattern } = managerFor(dialect, mode, "deny");
    for (const headless of [false, true]) {
      const result = check(headless);
      expect(result).toMatchObject({ decision: "deny", reasonCode: "rule-deny", pipelineRequest: { rules: { deny: pattern } } });
      expect(result.forceModal).toBeUndefined();
    }
  });

  it.each(CASES)("ask remains a restriction fact for $dialect in $mode", ({ dialect, mode }) => {
    const { check, pattern } = managerFor(dialect, mode, "ask");
    const result = check();
    expect(result.pipelineRequest?.rules?.ask).toBe(pattern);
    expect(result.forceModal).toBeUndefined();
    if (mode === "allow") {
      expect(result).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
      expect(check(true)).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    } else if (mode === "auto") {
      expect(result).toMatchObject({ decision: "ask", reasonCode: "review-required", reviewer: { route: "foreground-auto" } });
      const request = result.pipelineRequest!;
      expect(decidePermission({ ...request, reviewer: { status: "error", breakerOpen: false } })).toMatchObject({ outcome: "ask", reasonCode: "reviewer-human-required" });
      expect(decidePermission({ ...request, headless: true, reviewer: { status: "error", breakerOpen: false } })).toMatchObject({ outcome: "deny", reasonCode: "no-approver", reason: NO_APPROVER_MESSAGE });
    } else {
      expect(result).toMatchObject({ decision: "ask", reasonCode: "rule-ask" });
      expect(check(true)).toMatchObject({ decision: "deny", reasonCode: "no-approver", reason: NO_APPROVER_MESSAGE });
    }
  });

  it.each(CASES)("does not turn a long $dialect allow rule into reusable proof in $mode", ({ dialect, mode }) => {
    const { check } = managerFor(dialect, mode, "allow");
    const result = check();
    expect(result.pipelineRequest?.rules?.allow).toBeUndefined();
    expect(result.reasonCode).not.toBe("rule-allow");
    expect(result).toMatchObject(mode === "allow"
      ? { decision: "allow", reasonCode: "allow-mode" }
      : mode === "auto" ? { decision: "ask", reasonCode: "review-required" }
      : { decision: "ask", reasonCode: "shell-approval" });
    expect(result.forceModal).toBeUndefined();
  });
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../permission-manager.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "ave-shell-deny-prefix-")); });
afterEach(() => { cleanupTmpDir(cwd); });

it("uses the bounded deny scan once and feeds it the decision's rule scopes", () => {
  const source = readFileSync(new URL("../permission-manager.ts", import.meta.url), "utf8");
  expect(source.match(/shellDenyOnBoundedPrefix\(/g)).toHaveLength(1);
  expect(source).toMatch(/shellDenyOnBoundedPrefix\(\{[\s\S]*?ruleScopes[,\s]/);
});

describe.each([
  { dialect: "bash" as const, pattern: "Bash(printf *)", first: "printf ready", long: `printf${" x".repeat(450)}` },
  { dialect: "powershell" as const, pattern: "PowerShell(Write-Output *)", first: "Write-Output ready", long: `Write-Output${" 1".repeat(450)}` },
])("bounded $dialect deny rules", ({ dialect, pattern, first, long }) => {
  const overBudgetTail = `date${" x".repeat(450)}`;
  const longTail = Array.from({ length: 1800 }, () => "date x").join("; ");
  async function savedDeny(generic = false) {
    const manager = new PermissionManager(join(cwd, "permissions.json"));
    manager.setMode("allow");
    await manager.addRulePersist({ pattern, action: "deny" }, { kind: "user" });
    if (generic) await manager.addRulePersist({ pattern: dialect, action: "deny" }, { kind: "user" });
    return (command: string, headless = false) => manager.checkDetailed(dialect, "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect, command, cwd },
      shellExecution: { runsSandboxed: true },
      headless,
    });
  }

  it.each([overBudgetTail, longTail].map((tail, index) => ({ tail, limit: index === 0 ? "token" : "input" })))(
    "keeps a saved deny in the completed prefix at the $limit limit", async ({ tail }) => {
      expect((await savedDeny())(`${first}; ${tail}`)).toMatchObject({ decision: "deny", reasonCode: "rule-deny" });
    },
  );

  it("preserves the merge-base refusal when the first statement exhausts the token budget", async () => {
    const check = await savedDeny();
    expect(check(first)).toMatchObject({ decision: "deny", reasonCode: "rule-deny", reason: pattern });
    for (const headless of [false, true]) {
      expect(check(long, headless)).toMatchObject({ decision: "deny", reasonCode: "shell-analysis-limit" });
    }
  });

  it("takes a generic deny before the exhausted dialect deny check", async () => {
    expect((await savedDeny(true))(long)).toMatchObject({ decision: "deny", reasonCode: "rule-deny", reason: dialect });
  });

  it("asks when the deny target occurs after the bound", async () => {
    expect((await savedDeny())(`date; ${overBudgetTail}; ${first}`))
      .toMatchObject({ decision: "ask", forceModal: true, reasonCode: "shell-analysis-limit" });
  });
});

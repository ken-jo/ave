import "../../__tests__/support/trusted-powershell.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { readPermissionsFile, updatePermissionsFile } from "../permissions-store.js";
import { projectRulesLocation, readProjectRulesFile } from "../rules/project-rule-files.js";
import { evaluatePowerShellSubject, evaluateShellSubject } from "../rules/rule-scopes.js";
import { SHELL_RULE_CANONICAL_VERSION, isCurrentShellRule, withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";

// These cases model a pinned-startup host; win32 is never pinned (permission-policy-design.md, Windows startup proof).
vi.mock("../../shared/powershell-startup-policy.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../../shared/powershell-startup-policy.js")>(), isPowerShellStartupPinned: () => true }));

type Dialect = "bash" | "powershell";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function prepare() {
  const root = mkdtempSync(join(tmpdir(), "shell-rule-version-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  return { root, cwd, file: join(root, "permissions.json") };
}

function commandFor(dialect: Dialect): string {
  return dialect === "bash" ? "printf ready" : "Write-Output ready";
}

function patternFor(dialect: Dialect): string {
  return `${dialect === "bash" ? "Bash" : "PowerShell"}(${commandFor(dialect)})`;
}

function check(manager: PermissionManager, dialect: Dialect, cwd: string, headless = false, extra: { projectRulesCwd?: string; sessionId?: string } = {}) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command: commandFor(dialect), cwd },
    shellExecution: { runsSandboxed: false }, headless, ...extra,
  });
}

function writeUser(file: string, rules: PermissionRule[]) {
  writeFileSync(file, JSON.stringify({ version: 1, rules, mode: "default", updatedAt: "" }));
}

function directDecision(dialect: Dialect, rule: PermissionRule) {
  const command = commandFor(dialect);
  return dialect === "bash"
    ? evaluateShellSubject({ command, exactAllowOnly: true }, [rule]).decision
    : evaluatePowerShellSubject({ command, exactAllowOnly: true }, [rule]).decision;
}

describe("stored shell rule format versions", () => {
  it("loads an older writer's actual output without activating or stamping its allow", async () => {
    const { cwd, file } = prepare();
    copyFileSync(new URL("./fixtures/legacy-permission-rules.json", import.meta.url), file);
    const original = readFileSync(file, "utf8");
    const manager = new PermissionManager(file);
    await manager.loadRulesFromFile();
    expect(await manager.listPersistedRules()).toEqual([{ pattern: "Bash(printf 0x10)", action: "allow" }]);
    for (const command of ["printf 0x10", "printf '0x10'"]) for (const headless of [false, true]) {
      expect(manager.checkDetailed("bash", "builtin", "shell", null, {
        ruleSubject: { kind: "shell", dialect: "bash", command, cwd },
        shellExecution: { runsSandboxed: false }, headless,
      })).toMatchObject({ decision: headless ? "deny" : "ask" });
    }
    expect(readFileSync(file, "utf8")).toBe(original);
    expect((await manager.listScopedRules()).rules[0]).not.toHaveProperty("invalidReason");
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) =>
    [undefined, 0, SHELL_RULE_CANONICAL_VERSION + 1].map((shellRuleVersion) => ({ dialect, shellRuleVersion }))))
  ("ignores stale $dialect allows in loaded, injected and project scopes: $shellRuleVersion", async ({ dialect, shellRuleVersion }) => {
    const { root, cwd, file } = prepare();
    const rule: PermissionRule = { pattern: patternFor(dialect), action: "allow", ...(shellRuleVersion === undefined ? {} : { shellRuleVersion }) };
    expect(isCurrentShellRule(rule)).toBe(false);
    expect(directDecision(dialect, rule)).toBeNull();
    writeUser(file, [rule]);
    const manager = new PermissionManager(file);
    await manager.loadRulesFromFile();
    for (const headless of [false, true]) expect(check(manager, dialect, cwd, headless)).toMatchObject({ decision: headless ? "deny" : "ask" });
    manager.setRules([rule]);
    for (const headless of [false, true]) expect(check(manager, dialect, cwd, headless)).toMatchObject({ decision: headless ? "deny" : "ask" });
    const location = projectRulesLocation(root, cwd);
    mkdirSync(dirname(location.filePath), { recursive: true });
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, rules: [rule], updatedAt: "" }));
    const projectReader = new PermissionManager(file);
    await projectReader.ensureProjectRulesLoaded(cwd);
    for (const headless of [false, true]) expect(check(projectReader, dialect, cwd, headless, { projectRulesCwd: cwd })).toMatchObject({ decision: headless ? "deny" : "ask" });
    expect((await readPermissionsFile(file))?.rules).toEqual([rule]);
    expect((await readProjectRulesFile(location))?.rules).toEqual([rule]);
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) =>
    ["user", "project", "session"].map((scope) => ({ dialect, scope }))))
  ("stamps new $dialect allows in the $scope scope and replays their exact raw text", async ({ dialect, scope }) => {
    const { root, cwd, file } = prepare();
    const manager = new PermissionManager(file);
    if (scope === "session") manager.addSessionRule("conversation", patternFor(dialect));
    else await manager.addRulePersist({ pattern: patternFor(dialect), action: "allow" }, scope === "project" ? { kind: "project", projectCwd: cwd } : { kind: "user" });
    const extra = scope === "session" ? { sessionId: "conversation" } : scope === "project" ? { projectRulesCwd: cwd } : {};
    for (const headless of [false, true]) expect(check(manager, dialect, cwd, headless, extra)).toMatchObject({ decision: "allow" });
    if (scope !== "session") {
      const stored = scope === "project" ? await readProjectRulesFile(projectRulesLocation(root, cwd)) : await readPermissionsFile(file);
      expect(stored?.rules).toEqual([{ pattern: patternFor(dialect), action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
      const restarted = new PermissionManager(file);
      await restarted.loadRulesFromFile();
      if (scope === "project") await restarted.ensureProjectRulesLoaded(cwd);
      expect(check(restarted, dialect, cwd, true, extra)).toMatchObject({ decision: "allow" });
    }
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) =>
    ["user", "project"].map((scope) => ({ dialect, scope }))))
  ("a fresh $scope save replaces a stale $dialect record of the same text", async ({ dialect, scope }) => {
    const { root, cwd, file } = prepare();
    const stale: PermissionRule = { pattern: patternFor(dialect), action: "allow" };
    if (scope === "user") writeUser(file, [stale]);
    else {
      const location = projectRulesLocation(root, cwd);
      mkdirSync(dirname(location.filePath), { recursive: true });
      writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, rules: [stale], updatedAt: "" }));
    }
    const manager = new PermissionManager(file);
    await manager.loadRulesFromFile();
    await manager.addRulePersist(stale, scope === "project" ? { kind: "project", projectCwd: cwd } : { kind: "user" });
    const stored = scope === "user" ? await readPermissionsFile(file) : await readProjectRulesFile(projectRulesLocation(root, cwd));
    expect(stored?.rules).toEqual([withCurrentShellRuleVersion(stale)]);
    expect(check(manager, dialect, cwd, true, scope === "project" ? { projectRulesCwd: cwd } : {})).toMatchObject({ decision: "allow" });
  });

  it.each(["bash", "powershell"] as const)("preserves stale %s allows during unrelated writes", async (dialect) => {
    const { cwd, file } = prepare();
    const stale: PermissionRule = { pattern: patternFor(dialect), action: "allow", shellRuleVersion: 0 };
    writeUser(file, [stale]);
    await updatePermissionsFile(file, (current) => { current.mode = "auto"; });
    const manager = new PermissionManager(file);
    await manager.loadRulesFromFile();
    await manager.addRulePersist({ pattern: "Network(example.test)", action: "deny" }, { kind: "user" });
    expect((await readPermissionsFile(file))?.rules).toContainEqual(stale);
    const decision = check(manager, dialect, cwd, true);
    expect(decision).toMatchObject({ decision: "ask", reasonCode: "review-required" });
    expect(decision.pipelineRequest?.rules?.allow).toBeUndefined();
    expect(decision.pipelineRequest?.headless).toBe(true);
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) =>
    [undefined, 0, SHELL_RULE_CANONICAL_VERSION + 1].flatMap((shellRuleVersion) =>
      ["deny", "ask"].map((action) => ({ dialect, shellRuleVersion, action })))))
  ("keeps $action restrictions effective for $dialect version $shellRuleVersion", ({ dialect, shellRuleVersion, action }) => {
    const rule: PermissionRule = { pattern: patternFor(dialect), action: action as "deny" | "ask", ...(shellRuleVersion === undefined ? {} : { shellRuleVersion }) };
    expect(isCurrentShellRule(rule)).toBe(true);
    expect(directDecision(dialect, rule)).toBe(action);
  });

  it("does not attach a shell format version to other rule kinds or restrictions", () => {
    for (const rule of [{ pattern: "Network(example.test)", action: "allow" }, { pattern: "Bash(printf ready)", action: "deny" }]) {
      expect(withCurrentShellRuleVersion(rule)).toEqual(rule);
    }
  });
});

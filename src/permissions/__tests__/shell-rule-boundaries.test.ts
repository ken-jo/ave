import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { projectRulesLocation } from "../rules/project-rule-files.js";
import { refusedShellPrefix } from "../rules/shell-prefix-values.js";
import { suggestShellPrefix } from "../rules/shell-prefix-policy.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { evaluateShellRules } from "../rules/shell-rule-matcher.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";

let root: string;
let project: string;
let permissionsFile: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "shell-rule-boundaries-")));
  project = join(root, "project");
  mkdirSync(project);
  permissionsFile = join(root, "permissions.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const plainRoute = { runsSandboxed: false };
const shellSubject = (command: string) => ({ kind: "shell" as const, dialect: "bash" as const, command, cwd: project });

describe("stored broad wildcard compatibility", () => {
  it.each([{ source: "builtin" }, { tier: "invalid" }])("still rejects a malformed stored broad rule: %j", async (invalid) => {
    writeFileSync(permissionsFile, JSON.stringify({ version: 1, rules: [{ pattern: "Bash(npm run *)", action: "allow", ...invalid }] }));
    const manager = new PermissionManager(permissionsFile);
    await manager.loadRulesFromFile();
    expect(manager.getRulesLoadError()).toBeDefined();
    expect((await manager.listScopedRules()).errors).toHaveLength(1);
  });

  it.each(["user", "project"] as const)("keeps a %s wildcard inert, lists it and revokes it without disabling healthy rules", async (scope) => {
    const location = projectRulesLocation(root, project);
    const path = scope === "user" ? permissionsFile : location.filePath;
    mkdirSync(dirname(path), { recursive: true });
    const inert = { pattern: "Bash(npm run *)", action: "allow" as const };
    const healthy = withCurrentShellRuleVersion({ pattern: "Bash(printf ready)", action: "allow" as const });
    const unproven = withCurrentShellRuleVersion({ pattern: "Bash(git status)", action: "allow" as const });
    writeFileSync(path, JSON.stringify({ version: 1, mode: "default", projectRoot: location.projectRoot, rules: [inert, healthy, unproven], updatedAt: "" }));
    const manager = new PermissionManager(permissionsFile);
    await manager.loadRulesFromFile();
    await manager.ensureProjectRulesLoaded(project);
    manager.setMode("allow");
    const check = (command: string) => manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: shellSubject(command), shellExecution: plainRoute, projectRulesCwd: project,
    });
    expect(manager.getRulesLoadError()).toBeUndefined();
    expect(check("printf ready")).toMatchObject({ decision: "allow", layer: 3 });
    expect(check("git status")).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(check("git status").pipelineRequest?.rules?.allow).toBeUndefined();
    expect(check("npm run build")).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(check("npm run build").pipelineRequest?.rules?.allow).toBeUndefined();
    manager.setMode("default");
    expect(check("npm run build")).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    expect(check("npm run build").forceModal).not.toBe(true);
    const listed = await manager.listScopedRules();
    expect(listed.errors).toEqual([]);
    const row = listed.rules.find((rule) => rule.pattern === inert.pattern)!;
    expect(row).toMatchObject({ ...inert, scope, invalidReason: "wildcard-not-allowlisted" });
    const target = scope === "user" ? { kind: "user" as const } : { kind: "project" as const, projectCwd: row.projectCwd!, storedFile: row.storedFile! };
    await manager.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, target);
    expect(JSON.parse(readFileSync(path, "utf8")).rules).toContainEqual(inert);
    await expect(manager.addRulePersist({ pattern: "Bash(node *)", action: "allow" }, target)).rejects.toThrow(/refused allow prefix/);
    await manager.removeRulePersist(row, target);
    expect(JSON.parse(readFileSync(path, "utf8")).rules).toContainEqual(healthy);
    expect((await manager.listScopedRules()).rules.some((rule) => rule.pattern === inert.pattern)).toBe(false);
    const restarted = new PermissionManager(permissionsFile);
    await restarted.loadRulesFromFile();
    await restarted.ensureProjectRulesLoaded(project);
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, { ruleSubject: shellSubject("printf ready"), projectRulesCwd: project })).toMatchObject({ decision: "allow", layer: 3 });
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, { ruleSubject: shellSubject("git status"), projectRulesCwd: project })).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
  });
});

describe("bounded rule consent", () => {
  it.each([
    ["bash", "-x"], ["/bin/bash", "-x"], ["/usr/bin/python3"], ["python3.12"], ["pythonX"], ["node22"],
    ["ruby3.3"], ["git", "-c"], ["git", "-c", "core.pager=less"], ["env", "VAR="],
  ])("rejects a normalized broad wildcard %j", (...tokens) => {
    expect(refusedShellPrefix(tokens)).toBe("broad-prefix");
    expect(suggestShellPrefix(tokens)).toBeNull();
  });

  it.each([
    ["printf ready", true],
    ["git status --short", false],
    ["git -c core.pager=less log", false],
  ] as const)("defaults to positive exact argv proof when supported: %s", (command, exactAllowed) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation")).toMatchObject(exactAllowed
      ? { exactRule: `Bash(${command})`, persistentAllowed: true, sessionAllowed: true }
      : { exactRule: null, persistentAllowed: false, sessionAllowed: false });
    expect(suggestShellPrefix(command.split(" "))).toEqual(command.split(" "));
  });

  it.each([
    ["bash -x build.sh", "Bash(bash -x *)", null, false],
    ["bash -x -c 'touch ~/x'", "Bash(bash -x *)", null, false],
    ["/usr/bin/python3 -c 'os.system(\"id\")'", "Bash(/usr/bin/python3 *)", null, false],
    ["echo $(id)", "Bash(echo *)", null, false], ["eval id", "Bash(eval id)", "allow", true],
  ] as const)("distinguishes literal visible code from expansion: %s", (command, pattern, ruleDecision, exactAllowed) => {
    const spec = parseRuleSpecifier(pattern);
    if (spec.kind !== "bash") throw new Error("Expected shell rule");
    expect(evaluateShellRules(command, { allow: [{ pattern, spec }], ask: [], deny: [] }, project).decision).toBe(ruleDecision);
    const approval = buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation");
    if (exactAllowed) expect(approval).toMatchObject({ exactRule: expect.any(String), persistentAllowed: true });
    else expect(approval).toMatchObject({ exactRule: null, persistentAllowed: false });
    const manager = new PermissionManager(permissionsFile);
    manager.setRules(([{ pattern, action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
    expect(manager.checkDetailed("bash", "builtin", "shell", null, { ruleSubject: shellSubject(command), shellExecution: plainRoute }).decision).toBe(pattern === "Bash(eval id)" ? "allow" : "ask");
    if (approval.exactRule !== null) {
      manager.setRules(([{ pattern: approval.exactRule, action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
      expect(manager.checkDetailed("bash", "builtin", "shell", null, { ruleSubject: shellSubject(command), shellExecution: plainRoute })).toMatchObject({ decision: "allow", layer: 3 });
    }
  });
});

describe("missing shell route", () => {
  it("uses plain unavailable execution for any shell subject", () => {
    const manager = new PermissionManager(permissionsFile);
    manager.setMode("allow");
    manager.setRules(([{ pattern: "Bash(printf *)", action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
    expect(manager.checkDetailed("terminal_run", "builtin", "shell", null, { ruleSubject: shellSubject("printf ready") })).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
    manager.setRules(([{ pattern: "Bash(printf ready)", action: "allow" }] satisfies PermissionRule[]).map(withCurrentShellRuleVersion));
    expect(manager.checkDetailed("terminal_run", "builtin", "shell", null, { ruleSubject: shellSubject("printf ready") })).toMatchObject({ decision: "allow", layer: 3 });
    expect(manager.checkDetailed("terminal_run", "builtin", "shell", null, { ruleSubject: shellSubject("rm -rf build") })).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(manager.checkDetailed("terminal_run", "builtin", "shell", null, { ruleSubject: shellSubject("rm -rf /") })).toMatchObject({ decision: "ask", reasonCode: "critical-delete", forceModal: true });
    expect(manager.checkDetailed("terminal_run", "builtin", "shell", null, { ruleSubject: shellSubject("cat ~/.ssh/id_rsa") })).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    manager.setMode("default");
    const secret = manager.checkDetailed("terminal_run", "builtin", "shell", null, { ruleSubject: shellSubject("cat ~/.ssh/id_rsa") });
    expect(secret).toMatchObject({ decision: "ask" });
    expect(secret.forceModal).not.toBe(true);
  });

  // Owner 2026-10-25 (five-choice shell card): This session saves the same exact rule as the persistent scopes, so it needs no sandbox evidence, only a conversation to hold it.
  it("offers This session as the exact rule on a dock request with a conversation", async () => {
    let displayed: ApprovalRequest | undefined;
    const nativeWebContents = { isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel === "ave:approval:request") displayed = request;
    } };
    const gate = new ApprovalGate(nativeWebContents as never);
    const pending = gate.requestAndWait({
      id: "missing-route", sessionId: "conversation", category: "tool", toolName: "bash", toolCategory: "shell", source: "builtin",
      args: { command: "printf ready" }, reason: "Approval required", createdAt: Date.now(), trustOrigin: "user-keyboard", ruleVerdict: { level: "medium", reason: "Bounded command" },
      evaluationContext: buildPermissionEvaluationContext({ policyMode: "default", headless: false, source: "builtin", category: "shell", trustOrigin: "user-keyboard", executionCwd: project, allowedDirectories: [project], pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [] }),
    });
    expect(displayed?.shellRule).toMatchObject({ exactRule: "Bash(printf ready)", sessionAllowed: true, persistentAllowed: true });
    gate.resolveFromDesktopRenderer("missing-route", { requestId: "missing-route", choice: "deny-once", nonce: displayed!.nonce, hmac: displayed!.hmac }, nativeWebContents as never);
    await pending;
  });
});

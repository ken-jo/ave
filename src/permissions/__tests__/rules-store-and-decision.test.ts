/**
 * Issue #28 P1a — rule files (user-global Store A + per-project files in Ave
 * home), corrupt-data handling, Store B coexistence, and the decision path:
 * floors > deny > ask > allow across scopes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "ave-rules-home-"));
process.env.AVE_HOME = TEST_HOME;

import { PermissionManager } from "../permission-manager.js";
import { readPermissionsFile, updatePermissionsFile } from "../permissions-store.js";
import { PermissionRulesFileCorruptError } from "../rules/rule-files.js";
import { projectRulesLocation } from "../rules/project-rule-files.js";
import {
  UserApprovalStoreCorruptError,
  lookupApproval,
  readApprovals,
  recordApproval,
  __resetSessionStoreForTest,
} from "../user-approval-store.js";
import { resolveUserApprovalVerdict } from "../../shared/permissions-events.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { classifyApprovalRuleVerdict } from "../../tools/pipeline/approval-memory-skip.js";

let dir: string;
let permissionsFile: string;
let project: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ave-rules-")));
  permissionsFile = join(dir, "permissions.json");
  project = join(dir, "project");
  mkdirSync(project);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const shell = (command: string) => ({ ruleSubject: { kind: "shell" as const, command } });

describe("Store A (user-global permissions.json)", () => {
  it("fails clearly on corrupt JSON and never overwrites the file", async () => {
    writeFileSync(permissionsFile, "{ not json");
    await expect(readPermissionsFile(permissionsFile)).rejects.toBeInstanceOf(PermissionRulesFileCorruptError);
    await expect(updatePermissionsFile(permissionsFile, (f) => { f.rules.push({ pattern: "x", action: "allow" }); }))
      .rejects.toBeInstanceOf(PermissionRulesFileCorruptError);
    expect(readFileSync(permissionsFile, "utf8")).toBe("{ not json");
  });

  it.each([
    [{ pattern: "Bash(bash *)", action: "allow" }, /refused allow prefix/],
    [{ pattern: "Bash(*)", action: "allow" }, /bare \*/],
    [{ pattern: "Bash(git  status)", action: "deny" }, /single spaces/],
    [{ pattern: "Mcp(github)", action: "allow" }, /not enforced yet/],
    [{ pattern: "web_fetch", action: "maybe" }, /unknown action/],
  ])("treats an out-of-language rule as corrupt: %j", async (rule, message) => {
    writeFileSync(permissionsFile, JSON.stringify({ version: 1, rules: [rule], mode: "default", updatedAt: "" }));
    await expect(readPermissionsFile(permissionsFile)).rejects.toThrow(message);
  });

  it("keeps legacy glob rules and refused prefixes as deny rules", async () => {
    const legacy = { version: 1, rules: [
      { pattern: "web_fetch", action: "allow", tier: "read" },
      { pattern: "write_file:path:/abs/a(b)", action: "allow" },
      { pattern: "Bash(sudo *)", action: "deny" },
    ], mode: "default", updatedAt: "" };
    writeFileSync(permissionsFile, JSON.stringify(legacy));
    await expect(readPermissionsFile(permissionsFile)).resolves.toMatchObject({ rules: legacy.rules });
  });

  it("a corrupt file fails every decision closed with a visible reason", async () => {
    writeFileSync(permissionsFile, "[]");
    const pm = new PermissionManager(permissionsFile);
    pm.setRules([{ pattern: "skill_list", action: "allow" }]);
    await pm.loadRulesFromFile();
    expect(pm.getRulesLoadError()).toMatch(/is corrupt/);
    for (const [tool, category] of [["skill_list", "meta"], ["read_file", "read"], ["bash", "shell"]] as const) {
      if (category === "meta") continue;
      expect(pm.checkDetailed(tool, "builtin", category)).toMatchObject({ decision: "ask", forceModal: true, reason: expect.stringMatching(/is corrupt/) });
    }
    pm.setMode("allow");
    expect(pm.checkDetailed("bash", "builtin", "shell", null, shell("ls"))).toMatchObject({ decision: "ask", forceModal: true });
  });
});

describe("decision path", () => {
  it("Bash allow rules persist, survive restart, and match only via the shell subject", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(git status *)", action: "allow" }, { kind: "user" });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, shell("git status -s"))).toMatchObject({ decision: "allow", layer: 3 });

    const restarted = new PermissionManager(permissionsFile);
    await restarted.loadRulesFromFile();
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, shell("git status"))).toMatchObject({ decision: "allow", layer: 3 });
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, shell("git push"))).toMatchObject({ decision: "ask" });
    // No subject → the specifier never matches the tool name.
    expect(restarted.checkDetailed("bash", "builtin", "shell")).toMatchObject({ decision: "ask" });
    // A compound with an uncovered part is not allowed.
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, shell("git status && curl x"))).toMatchObject({ decision: "ask" });
  });

  it("refuses to persist an interpreter-wide or wrapper allow prefix", async () => {
    const pm = new PermissionManager(permissionsFile);
    for (const pattern of ["Bash(python *)", "Bash(sh *)", "Bash(env *)", "Bash(xargs *)", "Bash(node -e *)", "Bash(git *)"]) {
      await expect(pm.addRulePersist({ pattern, action: "allow" }, { kind: "user" }), pattern).rejects.toThrow(/refused allow prefix/);
    }
    await expect(pm.addRulePersist({ pattern: "web_fetch", action: "allow" }, { kind: "user" })).rejects.toThrow(/legacy pattern/);
    await expect(readPermissionsFile(permissionsFile)).resolves.toBeNull();
  });

  it("deny > ask > allow across user and project scopes; ask beats allow mode", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(git push *)", action: "allow" }, { kind: "user" });
    await pm.addRulePersist({ pattern: "Bash(git push --force *)", action: "deny" }, { kind: "project", projectCwd: project });
    await pm.addRulePersist({ pattern: "Bash(git push origin main)", action: "ask" }, { kind: "project", projectCwd: project });
    await pm.ensureProjectRulesLoaded(project);
    const ctx = (command: string) => ({ ...shell(command), projectRulesCwd: project });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("git push --force x"))).toMatchObject({ decision: "deny", layer: 1 });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("git push origin main"))).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("git push origin dev"))).toMatchObject({ decision: "allow", layer: 3 });
    pm.setMode("allow");
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("git push origin main"))).toMatchObject({ decision: "ask", forceModal: true });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("sudo git push --force x"))).toMatchObject({ decision: "deny" });
    // A deny rule that cannot see inside `bash -c` makes the call ask, even in allow mode.
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("bash -c 'git push --force x'"))).toMatchObject({ decision: "ask", forceModal: true });
  });

  it("project rules live in Ave home, keyed by the canonical project root, and never in the repo", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(npm test *)", action: "allow" }, { kind: "project", projectCwd: project });
    const location = projectRulesLocation(dir, project);
    expect(location.filePath.startsWith(join(dir, "permissions", "project-rules"))).toBe(true);
    expect(JSON.parse(readFileSync(location.filePath, "utf8"))).toMatchObject({ version: 1, projectRoot: location.projectRoot, rules: [{ pattern: "Bash(npm test *)", action: "allow" }] });
    await expect(pm.listProjectRules(project)).resolves.toMatchObject({ ok: true, rules: [{ pattern: "Bash(npm test *)" }] });
    // A sibling project does not inherit it.
    const sibling = join(dir, "sibling");
    mkdirSync(sibling);
    await pm.ensureProjectRulesLoaded(sibling);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("npm test"), projectRulesCwd: sibling })).toMatchObject({ decision: "ask" });
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("npm test"), projectRulesCwd: project })).toMatchObject({ decision: "allow" });
    await pm.removeRulePersist({ pattern: "Bash(npm test *)", action: "allow" }, { kind: "project", projectCwd: project });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("npm test"), projectRulesCwd: project })).toMatchObject({ decision: "ask" });
  });

  it("a corrupt project file fails that project closed; a decision for an unloaded project throws", async () => {
    const pm = new PermissionManager(permissionsFile);
    const location = projectRulesLocation(dir, project);
    mkdirSync(join(dir, "permissions", "project-rules"), { recursive: true });
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: "/elsewhere", rules: [] }));
    expect(() => pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("ls"), projectRulesCwd: project })).toThrow(/not loaded/);
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("ls"), projectRulesCwd: project }))
      .toMatchObject({ decision: "ask", forceModal: true, reason: expect.stringMatching(/projectRoot does not match/) });
    await expect(pm.addRulePersist({ pattern: "Bash(ls *)", action: "allow" }, { kind: "project", projectCwd: project })).rejects.toBeInstanceOf(PermissionRulesFileCorruptError);
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, rules: [{ pattern: "web_fetch", action: "allow" }] }));
    await expect(pm.listProjectRules(project)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/specifiers only/) });
  });

  it("a specifier deny never hides the tool from the model", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(rm *)", action: "deny" }, { kind: "user" });
    await pm.addAlwaysDeniedPersist("web_fetch");
    expect(pm.getVisibilityDenyRules()).toEqual([{ pattern: "web_fetch" }]);
  });
});

describe("Store B coexistence", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_HOME, "permissions"), { recursive: true });
    __resetSessionStoreForTest();
  });
  afterEach(() => rmSync(join(TEST_HOME, "permissions"), { recursive: true, force: true }));

  it("existing exact entries keep matching unchanged", async () => {
    await recordApproval("bash", "{\"command\":\"npm test\"}", "builtin", { scope: "persistent", verdictAtApproval: "medium", nlJustification: null });
    await expect(lookupApproval("bash", "{\"command\":\"npm test\"}", "builtin")).resolves.toMatchObject({ scope: "persistent" });
    await expect(lookupApproval("bash", "{\"command\":\"npm test -- x\"}", "builtin")).resolves.toBeNull();
  });

  it("a malformed approvals file fails clearly instead of reading as empty", async () => {
    writeFileSync(join(TEST_HOME, "permissions", "user-approvals.json"), JSON.stringify({ entries: {} }));
    await expect(readApprovals()).rejects.toBeInstanceOf(UserApprovalStoreCorruptError);
    await expect(recordApproval("bash", "{}", "builtin", { scope: "persistent", verdictAtApproval: "low", nlJustification: null }))
      .rejects.toBeInstanceOf(UserApprovalStoreCorruptError);
    expect(JSON.parse(readFileSync(join(TEST_HOME, "permissions", "user-approvals.json"), "utf8"))).toEqual({ entries: {} });
  });
});

describe("gate: unreviewed shell in default mode", () => {
  beforeEach(() => __resetSessionStoreForTest());

  it.each([
    ["ls -la", "low", true],
    ["npm test", "medium", true],
    ["rm -rf build", "high", false],
    [null, undefined, false],
  ] as const)("%s → verdict %s, remember offered: %s", async (command, level, rememberable) => {
    const args = { command: command ?? "ls" };
    const ruleVerdict = command === null ? undefined : classifyApprovalRuleVerdict({
      toolName: "bash", source: "builtin", category: "shell", pathFields: [], finalInput: args,
      executionCwd: project, allowedDirectories: [project], sensitivePathsAdjacent: [],
      context: { trustOrigin: "user-keyboard" } as never, sandboxAttestation: {},
    }).verdict;
    expect(ruleVerdict?.level).toBe(level);
    let displayed: ApprovalRequest | undefined;
    const gate = new ApprovalGate({ isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel === "ave:approval:request") displayed = request;
    } } as never);
    const id = `unreviewed-${String(level)}`;
    const pending = gate.requestAndWait({
      id, category: "tool", toolName: "bash", toolCategory: "shell", source: "builtin",
      args, reason: "user confirmation required", createdAt: Date.now(), trustOrigin: "user-keyboard",
      ...(ruleVerdict ? { ruleVerdict } : {}),
      evaluationContext: buildPermissionEvaluationContext({
        policyMode: "default", headless: false, source: "builtin", category: "shell",
        trustOrigin: "user-keyboard", executionCwd: project, allowedDirectories: [project],
        pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [],
      }),
    });
    expect(displayed).toMatchObject({ persistentAllowAllowed: rememberable });
    if (!rememberable) expect(displayed!.allowedChoices).toEqual(["allow-once", "deny-once"]);
    gate.resolveFromDesktopRenderer(id, { requestId: id, choice: "deny-once", nonce: displayed!.nonce, hmac: displayed!.hmac });
    await pending;
  });
});

describe("shell verdict for the dock (no blanket shell → HIGH)", () => {
  it("uses the host rule verdict, keeps HIGH for destructive, and fails closed without one", () => {
    expect(resolveUserApprovalVerdict({ toolCategory: "shell", ruleVerdict: { level: "low" } })).toBe("low");
    expect(resolveUserApprovalVerdict({ toolCategory: "shell", ruleVerdict: { level: "medium" } })).toBe("medium");
    expect(resolveUserApprovalVerdict({ toolCategory: "shell", ruleVerdict: { level: "high" } })).toBe("high");
    expect(resolveUserApprovalVerdict({ toolCategory: "shell" })).toBe("high");
    expect(resolveUserApprovalVerdict({ toolCategory: "shell", reviewerVerdict: { level: "high" }, ruleVerdict: { level: "low" } })).toBe("high");
  });
});

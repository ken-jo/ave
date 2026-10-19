import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
/**
 * Issue #28 P1a — rule files (user-global Store A + per-project files in Ave
 * home), corrupt-data handling, Store B coexistence, and the decision path:
 * floors > deny > ask > allow across scopes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { resolve } = await import("node:path");
  return {
    ...actual,
    // Temporary projects may live inside this checkout in a confined test run.
    existsSync: (path: import("node:fs").PathLike) => {
      const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
      return fold(resolve(String(path))) !== fold(resolve(process.cwd(), ".git")) && actual.existsSync(path);
    },
  };
});

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
  captureApprovalWorkingDirectory,
} from "../user-approval-store.js";
import { resolveUserApprovalVerdict } from "../../shared/permissions-events.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { classifyApprovalRuleVerdict } from "../../tools/pipeline/approval-memory-skip.js";
import { runWithToolExecutionCwd } from "../../tools/execution-context.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { BashTool } from "../../tools/shell-tools.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";

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

const shell = (command: string) => ({ ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command } });

describe("Store A (user-global permissions.json)", () => {
  it("fails clearly on corrupt JSON and never overwrites the file", async () => {
    writeFileSync(permissionsFile, "{ not json");
    await expect(readPermissionsFile(permissionsFile)).rejects.toBeInstanceOf(PermissionRulesFileCorruptError);
    await expect(updatePermissionsFile(permissionsFile, (f) => { f.rules.push({ pattern: "x", action: "allow" }); }))
      .rejects.toBeInstanceOf(PermissionRulesFileCorruptError);
    expect(readFileSync(permissionsFile, "utf8")).toBe("{ not json");
  });

  it("names the one bad rule and its line so the user can fix it", async () => {
    const text = [
      "{",
      "  \"version\": 1,",
      "  \"note\": \"rules: [a, b]\",",
      "  \"rules\": [",
      "    { \"pattern\": \"Bash(git status)\", \"action\": \"allow\" },",
      "    {",
      "      \"pattern\": \"Bash(node scripts/build.mjs)\",",
      "      \"action\": \"allow\"",
      "    }",
      "  ]",
      "}",
    ].join("\n");
    writeFileSync(permissionsFile, text);
    await expect(readPermissionsFile(permissionsFile)).rejects.toThrow(
      /rule 2 at line 6: Invalid permission rule "Bash\(node scripts\/build\.mjs\)": .*refused allow prefix/,
    );
    // A missing comma: the parser reports a position, surfaced as line/column.
    writeFileSync(permissionsFile, "{\n  \"version\": 1\n  \"rules\": []\n}");
    await expect(readPermissionsFile(permissionsFile)).rejects.toThrow(/invalid JSON at line 3 column \d+/);
    // A project file names the rule the same way.
    const location = projectRulesLocation(dir, project);
    mkdirSync(join(dir, "permissions", "project-rules"), { recursive: true });
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, rules: [{ pattern: "Bash(ls *)", action: "allow" }, { pattern: "Bash(*)", action: "allow" }] }, null, 2));
    const pm = new PermissionManager(permissionsFile.replace("permissions.json", "other.json"));
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("ls"), projectRulesCwd: project }))
      .toMatchObject({ decision: "ask", reason: expect.stringMatching(/rule 2 at line 9: Invalid permission rule "Bash\(\*\)"/) });
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
    for (const [tool, category] of [["write_file", "write"], ["web_fetch", "network"], ["bash", "shell"]] as const) {
      expect(pm.checkDetailed(tool, "builtin", category)).toMatchObject({ decision: "ask", forceModal: true, reason: expect.stringMatching(/is corrupt/) });
    }
    // Reads keep the normal matrix so the app stays usable during repair.
    expect(pm.checkDetailed("read_file", "builtin", "read")).toMatchObject({ decision: "allow" });
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

  it("a Store B corruption reported by the pipeline asks for non-read calls only", () => {
    const pm = new PermissionManager(permissionsFile);
    pm.setMode("allow");
    const error = "Saved approvals file /x/user-approvals.json is corrupt: invalid JSON";
    expect(pm.checkDetailed("write_file", "builtin", "write", null, { permissionStoreError: error }))
      .toMatchObject({ decision: "ask", forceModal: true, reason: error });
    expect(pm.checkDetailed("read_file", "builtin", "read", null, { permissionStoreError: error })).toMatchObject({ decision: "allow" });
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

  it("project rules key to the git root, so subdirectory sessions share them", async () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(npm test *)", action: "allow" }, { kind: "project", projectCwd: join(repo, "packages", "app") });
    expect(projectRulesLocation(dir, join(repo, "packages", "app")).filePath).toBe(projectRulesLocation(dir, repo).filePath);
    expect(projectRulesLocation(dir, join(repo, "packages", "app")).projectRoot).toBe(captureApprovalWorkingDirectory(repo).path);
    await pm.ensureProjectRulesLoaded(repo);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("npm test"), projectRulesCwd: repo })).toMatchObject({ decision: "allow" });
    // Outside a repository the cwd itself is the project.
    expect(projectRulesLocation(dir, project).projectRoot).toBe(captureApprovalWorkingDirectory(project).path);
  });

  it.skipIf(!canCreateSymlinks())("project rules follow the shell call's own cwd, resolved with realpath", async () => {
    // The session runs in repo A; the call runs in a nested repo B, reached
    // through a symlink (inside A, so no out-of-directory grant is involved).
    const repoA = join(dir, "a");
    const repoB = join(repoA, "vendor", "b");
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });
    symlinkSync(repoB, join(repoA, "b-link"));
    const pm = new PermissionManager(permissionsFile);
    pm.setMode("allow");
    await pm.addRulePersist({ pattern: "Bash(printf *)", action: "deny" }, { kind: "project", projectCwd: repoB });
    const check = vi.spyOn(pm, "checkDetailed");
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    registry.register(bash);
    const executor = new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait: vi.fn() } as never);

    const [result] = await runWithToolExecutionCwd(repoA, () => executor.executeAll(
      [{ id: "project-cwd", name: "bash", input: { command: "printf hi", cwd: "b-link" } }],
      { sessionId: "project-cwd", permissionContext: userPermissionContext() },
    ));

    const context = check.mock.calls[0]![4]!;
    expect(projectRulesLocation(dir, context.projectRulesCwd!).projectRoot).toBe(captureApprovalWorkingDirectory(repoB).path);
    expect(context.ruleSubject).toMatchObject({ kind: "shell", cwd: join(repoA, "b-link") });
    expect(check.mock.results[0]!.value).toMatchObject({ decision: "deny" });
    expect(execute).not.toHaveBeenCalled();
    expect(result!.is_error).toBe(true);
    // The session cwd's (empty) project file is not what decided the call.
    await pm.ensureProjectRulesLoaded(repoA);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf hi"), projectRulesCwd: repoA })).toMatchObject({ decision: "allow" });
  });

  it("re-reads a project rule file when it changes on disk", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.ensureProjectRulesLoaded(project);
    const ctx = { ...shell("npm test"), projectRulesCwd: project };
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx)).toMatchObject({ decision: "ask" });
    const location = projectRulesLocation(dir, project);
    mkdirSync(join(dir, "permissions", "project-rules"), { recursive: true });
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, rules: [{ pattern: "Bash(npm test *)", action: "allow" }] }));
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx)).toMatchObject({ decision: "allow" });
    writeFileSync(location.filePath, "{ broken");
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx)).toMatchObject({ decision: "ask", forceModal: true });
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

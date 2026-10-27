import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PermissionManager, type PermissionRule } from "../permission-manager.js";
import { editDepthCandidates, evaluateScopedRules, type ScopedRuleSubject } from "../rules/scoped-rule-matcher.js";
import { canonicalRuleSpecifier, matchesWebFetchHost, parseRuleSpecifier } from "../rules/rule-specifier.js";
import { projectRulesLocation } from "../rules/project-rule-files.js";
import { caseFoldForMatch, foldCanonicalPathSeparators, protectedControlEntryFor } from "../sensitive-paths.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { WriteFileTool, ReadFileTool, createFileTools } from "../../tools/file-tools.js";
import { runWithToolExecutionCwd } from "../../tools/execution-context.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { scopedRuleSubjectFor } from "../../tools/pipeline/scoped-rule-subject.js";
import { createWebFetchTool } from "../../tools/web-fetch.js";
import { createDynamicTool } from "../../tools/base.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let directory: string;
let project: string;
let manager: PermissionManager;
let audit: AuditLogger;
beforeEach(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-scoped-rules-")));
  project = join(directory, "project");
  mkdirSync(join(project, "src", "nested"), { recursive: true });
  mkdirSync(join(project, ".git", "objects"), { recursive: true });
  mkdirSync(join(project, ".git", "refs"));
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  vi.stubEnv("AVE_HOME", join(directory, "ave-home"));
  manager = new PermissionManager(join(directory, "permissions.json"));
  audit = new AuditLogger(join(directory, "audit"));
});
afterEach(async () => { vi.unstubAllEnvs(); await audit.close(); await cleanupTmpDir(directory); });

const allow = (pattern: string): PermissionRule => ({ pattern, action: "allow" });
const edit = (...paths: string[]): ScopedRuleSubject => ({ kind: "edit", cwd: project, paths });
const network = (url: string): ScopedRuleSubject => ({ kind: "webfetch", url });
const mcp = (tool = "lookup", nonDestructive = true): ScopedRuleSubject => ({ kind: "mcp", server: "catalog", tool, nonDestructive });
const evaluate = (subject: ScopedRuleSubject, rules: PermissionRule[]) => evaluateScopedRules(subject, project, rules);
const PROTECTED_FILE_CALLS = [
  { name: "delete_file", input: { path: "src/secret/keep.txt" } },
  { name: "move_file", input: { sourcePath: "src/public.txt", destinationPath: "src/secret/moved.txt" } },
  { name: "move_file", input: { sourcePath: "src/secret/keep.txt", destinationPath: "src/moved.txt" } },
  { name: "copy_path", input: { sourcePath: "src/public.txt", destinationPath: "src/secret/copied.txt" } },
  { name: "copy_path", input: { sourcePath: "src/secret/keep.txt", destinationPath: "src/copied.txt" } },
  { name: "extract_archive", input: { archivePath: "src/public.txt", destinationPath: "src/secret/extracted" } },
] as const;

describe("scoped permission rules", () => {
  it("builds an Edit subject for every registered canonical write with paths", () => {
    const tools = createFileTools().filter((tool) => tool.category === "write" && tool.pathFields?.length);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const input = { path: "src/a.txt", sourcePath: "src/a.txt", destinationPath: "src/b.txt", archivePath: "src/a.tar", patch: "*** Begin Patch\n*** Add File: src/a.txt\n+hello\n*** End Patch" };
      expect(scopedRuleSubjectFor(tool, input, project), tool.name).toMatchObject({ kind: "edit", cwd: project, paths: expect.arrayContaining([expect.any(String)]) });
    }
  });

  it.each((["allow", "always-allow"] as const).flatMap((mode) => PROTECTED_FILE_CALLS.map((call) => ({ mode, ...call }))))("denies $name $input in $mode mode", async ({ mode, name, input }) => {
    const tools = createFileTools();
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    if (mode === "allow") manager.setMode("allow");
    else for (const tool of tools) await manager.addAlwaysAllowedPersist(tool.name);
    await manager.loadRulesFromFile();
    await manager.addRulePersist({ pattern: "Edit(src/secret/**)", action: "deny" }, { kind: "user" });
    mkdirSync(join(project, "src", "secret"));
    writeFileSync(join(project, "src", "secret", "keep.txt"), "keep");
    writeFileSync(join(project, "src", "public.txt"), "public");
    const requestAndWait = vi.fn(async () => ({ choice: "deny-once" }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const checkDetailed = vi.spyOn(manager, "checkDetailed");
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "protected-file", name, input },
    ], { sessionId: "protected-files", permissionContext: userPermissionContext() }));
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("Edit(src/secret/**)") });
    expect(checkDetailed.mock.lastCall?.[4]?.ruleSubject).toMatchObject({
      kind: "edit", paths: Object.values(input),
      targets: expect.arrayContaining(Object.values(input).map((path) => ({
        filePath: join(project, path), canonicalPath: caseFoldForMatch(foldCanonicalPathSeparators(join(project, path))),
        runtimePath: foldCanonicalPathSeparators(join(project, path)),
      }))),
    });
    expect(readFileSync(join(project, "src", "secret", "keep.txt"), "utf8")).toBe("keep");
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it.each([
    ".git/hooks/pre-commit", ".git/config", ".husky/pre-commit",
    ".claude/settings.json", ".claude/settings.local.json",
    ".vscode/tasks.json", ".vscode/settings.json", ".vscode/launch.json", ".idea/workspace.xml",
    ".githooks/pre-commit", ".claude/hooks/stop.sh", ".claude/commands/x.md", ".pre-commit-config.yaml", ".envrc", "lefthook.yml",
  ])("keeps broad Edit grants below the write floor for %s", async (path) => {
    await manager.ensureProjectRulesLoaded(project);
    manager.setMode("allow");
    for (const pattern of ["Edit(**)", `Edit(${foldCanonicalPathSeparators(project)}/**)`]) {
      await manager.addRulePersist(allow(pattern), { kind: "user" });
      expect(manager.checkDetailed("write_file", "builtin", "write", null, {
        ruleSubject: edit(path), projectRulesCwd: project,
      })).toMatchObject({ decision: "ask", forceModal: true });
    }
  });

  async function writeUnderGrant(rule: string, path: string) {
    const registry = new ToolRegistry();
    registry.register(new WriteFileTool());
    await manager.loadRulesFromFile();
    await manager.addRulePersist(allow(rule), { kind: "user" });
    const requestAndWait = vi.fn(async () => ({ choice: "deny-once" }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "control-file", name: "write_file", input: { path, content: "#!/bin/sh" } },
    ], { sessionId: "control-files", permissionContext: userPermissionContext() }));
    return requestAndWait;
  }

  it.runIf(process.platform !== "linux").each([".GIT/hooks/pre-push", ".VSCODE/tasks.json", ".Claude/Settings.json"])(
    "asks before writing the case-variant control file %s under Edit(**)", async (path) => {
      const requestAndWait = await writeUnderGrant("Edit(**)", path);
      expect(requestAndWait).toHaveBeenCalledOnce();
      expect(existsSync(join(project, path))).toBe(false);
    });

  it("asks before writing a control file under an external absolute Edit grant", async () => {
    const external = join(directory, "external");
    mkdirSync(join(external, ".git", "hooks"), { recursive: true });
    const target = join(external, ".git", "hooks", "pre-commit");
    const requestAndWait = await writeUnderGrant(`Edit(${foldCanonicalPathSeparators(external)}/**)`, target);
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(existsSync(target)).toBe(false);
  });

  it.each([["darwin", ".git"], ["win32", ".git"], ["linux", undefined]] as const)("folds control entries like sensitive paths on %s", (platform, expected) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    try {
      expect(protectedControlEntryFor("/Users/Example/Repo/.GIT/hooks/pre-push")).toBe(expected);
      expect(protectedControlEntryFor("/elsewhere/.vscode/tasks.json")).toBe(".vscode");
    } finally { vi.restoreAllMocks(); }
  });

  it("keeps relative recursive and single-segment rules within the project", () => {
    for (const pattern of ["Edit(**)", "Edit(*.txt)"]) {
      expect(evaluate(edit(join(directory, "outside.txt")), [allow(pattern)]).decision).toBeUndefined();
      expect(evaluate(edit(join(directory, "project-evil", "outside.txt")), [allow(pattern)]).decision).toBeUndefined();
    }
  });

  it.each(["user", "project"] as const)("fails closed when a stored %s Edit rule has a partial recursive segment", async (kind) => {
    await manager.addRulePersist(allow("Edit(src/**)"), kind === "user" ? { kind } : { kind, projectCwd: project });
    const file = kind === "user" ? join(directory, "permissions.json") : projectRulesLocation(directory, project).filePath;
    writeFileSync(file, readFileSync(file, "utf8").replace("Edit(src/**)", "Edit(src**)"));
    const restarted = new PermissionManager(join(directory, "permissions.json"));
    await restarted.loadRulesFromFile();
    await restarted.ensureProjectRulesLoaded(project);
    expect(restarted.checkDetailed("write_file", "builtin", "write", null, {
      ruleSubject: edit("src/a.ts"), projectRulesCwd: project,
    })).toMatchObject({ decision: "ask", forceModal: true });
  });

  it("round-trips relative globs, normalized separators and ports", () => {
    for (const pattern of ["Edit(src/**/*.ts)", "Edit(src/a?.ts)", "WebFetch(domain:*.example.com:8443)", "Mcp(catalog:lookup)"]) {
      expect(canonicalRuleSpecifier(pattern)).toBe(pattern);
    }
    expect(canonicalRuleSpecifier(String.raw`Edit(C:\project\src\**)`)).toBe("Edit(C:/project/src/**)");
    expect(parseRuleSpecifier(String.raw`Edit(C:\project\src\**)`)).toEqual(parseRuleSpecifier("Edit(C:/project/src/**)"));
    expect(canonicalRuleSpecifier("Edit(src/cafe\u0301/**)")).toBe("Edit(src/caf\u00e9/**)");
    for (const path of ["../outside/**", "src/../../outside", "src/./a", "src//a", "//server/share/**", "~/src/**"]) {
      expect(() => parseRuleSpecifier(`Edit(${path})`)).toThrow();
    }
    for (const host of ["example.com:0", "example.com:65536", "example.com:0443", "example.com:443/path", "example.com@evil.com", "example.com:443:80"]) {
      expect(() => parseRuleSpecifier(`WebFetch(domain:${host})`)).toThrow();
    }
  });

  it("matches file globs by segment and requires every write target to be covered", () => {
    const rules = [allow("Edit(src/**/*.ts)")];
    expect(evaluate(edit("src/a.ts", "src/nested/b.ts"), rules).decision).toBe("allow");
    expect(evaluate(edit("src/a.ts", "src/b.js"), rules).decision).toBeUndefined();
    expect(evaluate(edit("src/nested/b.ts"), [allow("Edit(src/*.ts)")]).decision).toBeUndefined();
    expect(evaluate(edit("src/a.ts"), [allow("Edit(src/a?.ts)")]).decision).toBeUndefined();
    expect(evaluate(edit(), rules).decision).toBeUndefined();
    expect(evaluate(edit("src/a.ts"), [{ ...rules[0]!, tier: "read" }]).decision).toBeUndefined();
  });

  it("distinguishes native separators from literal backslashes in filenames", async () => {
    const subject = edit(String.raw`src\new.ts`);
    const result = evaluate(subject, [allow("Edit(src/**)")]);
    if (process.platform === "win32") expect(result.decision).toBe("allow");
    else expect(result).toMatchObject({ floor: expect.any(String) });
    const paths = [String.raw`src\new.ts`];
    if (process.platform !== "win32") {
      const literal = join(project, String.raw`src\alias`);
      mkdirSync(literal);
      symlinkSync(literal, join(project, "alias"));
      paths.push("alias/new.ts");
      expect(evaluate(edit("alias/new.ts"), [allow("Edit(src/**)")])).toMatchObject({ floor: expect.any(String) });
      expect(evaluate(edit("src/alias/new.ts"), [allow("Edit(alias/**)")]).decision).toBeUndefined();
    }
    await manager.addRulePersist(allow("Edit(src/**)"), { kind: "user" });
    const registry = new ToolRegistry();
    registry.register(new WriteFileTool());
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    for (const path of paths) {
      const [output] = await runWithToolExecutionCwd(project, () => executor.executeAll([
        { id: "native-separator", name: "write_file", input: { path, content: "created" } },
      ], { sessionId: "native-separator", permissionContext: userPermissionContext() }));
      expect(output?.is_error === true, output?.content).toBe(process.platform !== "win32");
      if (process.platform !== "win32") expect(output?.content).toBe("Cannot resolve write target");
      else expect(readFileSync(join(project, "src", "new.ts"), "utf8")).toBe("created");
    }
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("refuses symlink, parent-component and dangling-link escapes including new files", () => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(project, "src", "escape"), "junction");
    symlinkSync(join(directory, "absent"), join(project, "src", "dangling"), "junction");
    for (const path of ["src/escape/new.ts", "src/escape/../new.ts", "../outside/new.ts", "src/dangling/new.ts"]) {
      // A link followed by a parent component has ambiguous shell semantics and must stay on the floor.
      expect(evaluate(edit(path), [allow("Edit(**)")]), path).toMatchObject({ floor: expect.any(String) });
    }
    expect(evaluate(edit(join(outside, "new.ts")), [allow("Edit(src/**)")]).decision).toBeUndefined();
    const escapedAnchor = `Edit(${join(project, "src", "escape")}/**)`;
    expect(evaluate(edit(join(outside, "new.ts")), [allow(escapedAnchor)]).decision).toBeUndefined();
    expect(evaluate(edit(join(outside, "new.ts")), [{ pattern: escapedAnchor, action: "deny" }]).decision).toBe("deny");
    expect(evaluate(edit("src/escape/new.ts"), [allow("Edit(src/escape/**)")]).decision).toBeUndefined();
    symlinkSync(join(project, "src", "nested"), join(project, "linked"), "junction");
    expect(evaluate(edit("linked/new.ts"), [allow("Edit(src/**)")]).decision).toBe("allow");
  });

  it("enforces deny then ask then allow across scopes, including multi-file writes", () => {
    const subject = edit("src/a.ts", "src/nested/b.ts");
    expect(evaluateScopedRules(subject, project, [allow("Edit(src/**)")], [{ pattern: "Edit(src/nested/**)", action: "ask" }])).toMatchObject({ decision: "ask" });
    expect(evaluateScopedRules(subject, project, [{ pattern: "Edit(src/**)", action: "ask" }], [{ pattern: "Edit(src/nested/**)", action: "deny" }])).toMatchObject({ decision: "deny" });
  });

  it("keeps rule decisions tied to the sealed path after a symlink changes", () => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    const link = join(project, "src", "link");
    symlinkSync(outside, link, "junction");
    const filePath = join(link, "new.ts");
    const canonicalPath = join(outside, "new.ts");
    unlinkSync(link);
    symlinkSync(join(project, "src", "nested"), link, "junction");
    const subject: ScopedRuleSubject = { kind: "edit", paths: [filePath], cwd: project, targets: [{ filePath, canonicalPath }] };
    expect(evaluate(subject, [allow("Edit(src/**)")])).toMatchObject({ floor: expect.any(String) });
    expect(evaluate({ ...subject, targets: [] }, [allow("Edit(src/**)")])).toMatchObject({ floor: expect.any(String) });
  });

  it.each(["deny", "ask"] as const)("retains a lexical %s when a rule anchor symlink changes", (action) => {
    const link = join(project, "alias");
    symlinkSync(join(project, "src", "nested"), link, "junction");
    const filePath = join(link, "new.ts");
    const canonicalPath = join(project, "src", "nested", "new.ts");
    unlinkSync(link);
    mkdirSync(join(project, "public"));
    symlinkSync(join(project, "public"), link, "junction");
    const subject: ScopedRuleSubject = { kind: "edit", cwd: project, paths: [filePath], targets: [{ filePath, canonicalPath }] };
    expect(evaluate(subject, [allow("Edit(**)"), { pattern: "Edit(alias/**)", action }])).toMatchObject({ decision: action });
  });

  it("matches hostname boundaries and effective ports, never command text or URL substrings", async () => {
    const rules = [allow("WebFetch(domain:*.example.com:443)")];
    for (const url of ["https://API.EXAMPLE.COM/page", "https://api.example.com.:443/page"]) expect(evaluate(network(url), rules).decision).toBe("allow");
    for (const url of ["https://example.com", "https://api.example.com:8443", "http://api.example.com", "https://api.example.com.evil.test", "https://evil.test/?next=api.example.com"]) expect(evaluate(network(url), rules).decision).toBeUndefined();
    expect(evaluate(network("https://api.example.com@evil.test"), rules).floor).toBeDefined();
    expect(evaluate(network("file:///api.example.com"), rules).floor).toBeDefined();
    const spec = parseRuleSpecifier("WebFetch(domain:example.com)");
    if (spec.kind !== "webfetch") throw new Error("Expected host rule");
    expect(matchesWebFetchHost(spec, "example.com:443")).toBe(false);
    expect(matchesWebFetchHost(spec, "example.com/path")).toBe(false);
    expect(evaluate(network("https://example.com:8443"), [allow("WebFetch(domain:example.com)")]).decision).toBe("allow");
    await manager.addRulePersist(allow("WebFetch(domain:example.com)"), { kind: "user" });
    await manager.ensureProjectRulesLoaded(project);
    expect(manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command: "curl https://example.com", cwd: project },
      projectRulesCwd: project,
    })).not.toMatchObject({ decision: "allow", layer: 3 });
  });

  it("matches server and original tool identity, and grants only annotated tools", () => {
    const rules = [allow("Mcp(catalog:lookup)")];
    expect(evaluate(mcp(), rules).decision).toBe("allow");
    expect(evaluate(mcp("remove"), rules).decision).toBeUndefined();
    expect(evaluate({ ...mcp(), server: "catalog-copy" } as ScopedRuleSubject, rules).decision).toBeUndefined();
    expect(evaluate(mcp("remove"), [allow("Mcp(catalog)")]).decision).toBe("allow");
    // An unannotated tool is not a floor: the allow rule just does not cover it.
    expect(evaluate(mcp("lookup", false), rules)).toEqual({});
    expect(evaluate(mcp("lookup", false), [{ pattern: "Mcp(catalog)", action: "deny" }]).decision).toBe("deny");
    expect(evaluate(mcp(), []).decision).toBeUndefined();
  });

  it("preserves floors and strict mode over persisted and legacy allows", async () => {
    await manager.addRulePersist(allow("Edit(**)"), { kind: "user" });
    await manager.addRulePersist(allow("WebFetch(domain:example.com)"), { kind: "user" });
    await manager.addRulePersist(allow("Mcp(catalog)"), { kind: "user" });
    await manager.ensureProjectRulesLoaded(project);
    manager.setMode("allow");
    for (const subject of [edit(".env"), edit(join(directory, "ave-home", "permissions.json"))]) {
      expect(manager.checkDetailed("operation", "builtin", "write", null, { ruleSubject: subject, projectRulesCwd: project })).toMatchObject({ decision: "ask", forceModal: true });
    }
    // An unannotated MCP tool and a screened request follow the mode; the matching allow rule never answers them.
    const ungranted = [mcp("lookup", false), network(`https://example.com/?token=${"sk-" + "a".repeat(50)}`)];
    for (const mode of ["allow", "default"] as const) {
      manager.setMode(mode);
      for (const subject of ungranted) {
        const result = manager.checkDetailed("operation", subject.kind === "mcp" ? "mcp" : "builtin", "network", null, { ruleSubject: subject, projectRulesCwd: project });
        expect(result.layer, `${mode} ${subject.kind}`).not.toBe(3);
        expect(result.decision, `${mode} ${subject.kind}`).toBe(mode === "allow" ? "allow" : "ask");
      }
    }
    manager.setMode("strict");
    expect(manager.checkDetailed("write_file", "builtin", "write", null, { ruleSubject: edit("src/a.ts"), projectRulesCwd: project }).decision).toBe("ask");
  });

  it("requires an explicit loaded project scope instead of falling back to global rules", async () => {
    await manager.addRulePersist(allow("Edit(**)"), { kind: "user" });
    const ruleSubject = edit("src/a.ts");
    expect(() => manager.checkDetailed("write_file", "builtin", "write", null, { ruleSubject })).toThrow("explicit project scope");
    expect(() => manager.checkDetailed("write_file", "builtin", "write", null, { ruleSubject, projectRulesCwd: project })).toThrow("not loaded before the decision");
    await manager.ensureProjectRulesLoaded(project);
    expect(manager.checkDetailed("write_file", "builtin", "write", null, { ruleSubject, projectRulesCwd: project })).toMatchObject({ decision: "allow", layer: 3 });
  });

  it("keeps private-network approval separate from a public host allow", async () => {
    const subject: ScopedRuleSubject = { kind: "webfetch", url: "https://example.com", privateNetwork: true };
    await manager.addRulePersist(allow("WebFetch(domain:example.com)"), { kind: "user" });
    await manager.ensureProjectRulesLoaded(project);
    expect(manager.checkScopedRules(subject, project)).toEqual({});
    expect(manager.checkDetailed("web_fetch", "builtin", "network", null, { ruleSubject: subject, projectRulesCwd: project })).toMatchObject({ decision: "ask" });
    // The explicit global mode keeps its existing authority; no new floor is added.
    manager.setMode("allow");
    expect(manager.checkDetailed("web_fetch", "builtin", "network", null, { ruleSubject: subject, projectRulesCwd: project })).toMatchObject({ decision: "allow" });
  });

  it("persists all kinds in the existing global and project files and reloads them", async () => {
    const patterns = ["Edit(src/**/*.ts)", "WebFetch(domain:example.com:443)", "Mcp(catalog:lookup)"];
    for (const pattern of patterns) await manager.addRulePersist(allow(pattern), { kind: "project", projectCwd: project });
    const restarted = new PermissionManager(join(directory, "permissions.json"));
    await restarted.ensureProjectRulesLoaded(join(project, "src"));
    for (const subject of [{ kind: "edit", cwd: join(project, "src"), paths: ["a.ts"] } as ScopedRuleSubject, network("https://example.com"), mcp()]) {
      expect(restarted.checkDetailed("operation", subject.kind === "mcp" ? "mcp" : "builtin", subject.kind === "edit" ? "write" : "network", null, { ruleSubject: subject, projectRulesCwd: join(project, "src") })).toMatchObject({ decision: "allow", layer: 3 });
    }
    for (const pattern of patterns) await manager.addRulePersist({ pattern, action: "deny" }, { kind: "user" });
    await restarted.loadRulesFromFile();
    expect(await restarted.checkNetworkRules("https://example.com", project)).toMatchObject({ decision: "deny" });
    const location = projectRulesLocation(directory, project);
    writeFileSync(location.filePath, "broken");
    expect(await restarted.checkNetworkRules("https://example.com", project)).toMatchObject({ floor: expect.any(String) });
  });

  it("resolves external depth candidates to existing Edit rules without widening to ancestors", () => {
    const external = join(directory, "external");
    mkdirSync(join(external, ".git", "objects"), { recursive: true });
    mkdirSync(join(external, ".git", "refs"));
    writeFileSync(join(external, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(external, "nested"));
    const target = join(external, "nested", "new.txt");
    const candidates = editDepthCandidates(target, project);
    expect(candidates.map((candidate) => candidate.depth)).toEqual(["file", "parent", "project"]);
    expect(candidates.map((candidate) => candidate.path)).toEqual([target, dirname(target), external].map((path) => foldCanonicalPathSeparators(path)));
    expect(editDepthCandidates(join(external, "direct.txt"), project).map((candidate) => candidate.depth)).toEqual(["file", "parent"]);
    expect(evaluate(edit(target), [allow(candidates[0]!.pattern)]).decision).toBe("allow");
    expect(evaluate(edit(join(external, "nested", "other.txt")), [allow(candidates[0]!.pattern)]).decision).toBeUndefined();
    expect(evaluate(edit(join(external, "nested", "other.txt")), [allow(candidates[1]!.pattern)]).decision).toBe("allow");
    expect(editDepthCandidates("/", project)).toEqual([]);
    expect(editDepthCandidates(join(project, ".env"), project)).toEqual([]);
    expect(editDepthCandidates(join(external, "a*.txt"), project)).toEqual([]);
    expect(editDepthCandidates(join(external, "[literal].txt"), project)).toEqual([]);
  });

  it("builds subjects from host-created tools and refuses name impersonation", () => {
    const tool = mcpToolToTool("catalog", "mcp_catalog_lookup", { name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }, async () => ({ text: "ok" }));
    expect(scopedRuleSubjectFor(tool, {}, project)).toEqual(mcp());
    const unannotated = mcpToolToTool("catalog", "mcp_catalog_lookup", { name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: {} } }, async () => ({ text: "ok" }));
    expect(scopedRuleSubjectFor(unannotated, {}, project)).toEqual(mcp("lookup", false));
    const destructive = mcpToolToTool("catalog", "mcp_catalog_lookup", { name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: true } }, async () => ({ text: "ok" }));
    expect(scopedRuleSubjectFor(destructive, {}, project)).toEqual(mcp("lookup", false));
    const malformed = mcpToolToTool("catalog", "mcp_catalog_lookup", { name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: "false" as unknown as boolean } }, async () => ({ text: "ok" }));
    expect(scopedRuleSubjectFor(malformed, {}, project)).toEqual(mcp("lookup", false));
    const namedWrite = createDynamicTool({ name: "write_file", source: "plugin", category: "write", description: "Write", jsonSchema: { type: "object", properties: {} }, execute: async () => ({ output: "", isError: false }) });
    expect(scopedRuleSubjectFor(namedWrite, { path: "src/a.ts" }, project)).toBeUndefined();
    expect(scopedRuleSubjectFor({ ...createWebFetchTool(fetch) }, { url: "https://example.com" }, project)).toBeUndefined();
  });

  it("uses a saved external file rule through both directory and tool gates without broadening a later call", async () => {
    const external = join(directory, "external");
    mkdirSync(external);
    const target = join(external, "new.txt");
    await manager.addRulePersist(allow(`Edit(${foldCanonicalPathSeparators(target)})`), { kind: "project", projectCwd: project });
    const registry = new ToolRegistry();
    registry.register(new WriteFileTool());
    registry.register(new ReadFileTool());
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "external-file", name: "write_file", input: { path: target, content: "created" } },
    ], { sessionId: "external-file", permissionContext: userPermissionContext() }));
    expect(result?.is_error === true, result?.content).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("created");
    expect(requestAndWait).not.toHaveBeenCalled();
    const sibling = join(external, "sibling.txt");
    requestAndWait.mockResolvedValueOnce({ choice: "deny-once" });
    const [blocked] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "external-sibling", name: "write_file", input: { path: sibling, content: "must not write" } },
    ], { sessionId: "external-file", permissionContext: userPermissionContext() }));
    expect(blocked?.is_error).toBe(true);
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ kind: "out-of-allowed-dir" }));
    expect(() => readFileSync(sibling, "utf8")).toThrow();
  });

  it("does not turn a generic tool allow into an external Edit grant", async () => {
    await manager.addAlwaysAllowedPersist("write_file");
    await manager.loadRulesFromFile();
    await manager.ensureProjectRulesLoaded(project);
    const subject = edit(join(directory, "external.txt"));
    expect(manager.checkDetailed("write_file", "builtin", "write", null, { ruleSubject: subject, projectRulesCwd: project })).toMatchObject({ decision: "allow", layer: 3 });
    expect(manager.checkScopedRules(subject, project)).toEqual({});
    const registry = new ToolRegistry();
    registry.register(new WriteFileTool());
    const requestAndWait = vi.fn(async () => ({ choice: "deny-once" }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "generic-allow", name: "write_file", input: { path: join(directory, "external.txt"), content: "must not write" } },
    ], { sessionId: "generic-allow", permissionContext: userPermissionContext() }));
    expect(result?.is_error).toBe(true);
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ kind: "out-of-allowed-dir" }));
  });

  it("refuses unresolved native write ancestors before granting an Edit rule", async () => {
    symlinkSync(join(directory, "absent"), join(project, "dangling"), "junction");
    await manager.addRulePersist(allow("Edit(**)"), { kind: "user" });
    const registry = new ToolRegistry();
    registry.register(new WriteFileTool());
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "dangling-write", name: "write_file", input: { path: "dangling/new.ts", content: "must not write" } },
    ], { sessionId: "dangling-write", permissionContext: userPermissionContext() }));
    expect(result).toMatchObject({ is_error: true, content: "Cannot resolve write target" });
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it.each(["read-only", "destructive", "absent"] as const)("uses the registered MCP identity in execution: %s annotations", async (annotation) => {
    await manager.addRulePersist(allow("Mcp(catalog:lookup)"), { kind: "user" });
    const callTool = vi.fn(async () => ({ text: "looked up" }));
    const tool = mcpToolToTool("catalog", "mcp_catalog_lookup", {
      name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: {} },
      ...(annotation === "absent" ? {} : { annotations: { destructiveHint: annotation === "destructive", readOnlyHint: annotation === "read-only" } }),
    }, callTool);
    const registry = new ToolRegistry();
    registry.register(tool);
    const requestAndWait = vi.fn(async () => ({ choice: "deny-once" }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "mcp-rule", name: tool.name, input: {} },
    ], { sessionId: "mcp-rule", permissionContext: userPermissionContext() }));
    expect(result?.is_error === true, result?.content).toBe(annotation !== "read-only");
    expect(callTool).toHaveBeenCalledTimes(annotation === "read-only" ? 1 : 0);
    expect(requestAndWait).toHaveBeenCalledTimes(annotation === "read-only" ? 0 : 1);
  });

  it.each(["deny", "ask", "unmatched", "port", "allow", "generic"] as const)("checks a redirected destination before transport: %s", async (action) => {
    const origin = "https://93.184.216.34/start";
    const redirected = action === "port" ? "https://93.184.216.34:8443/next" : "https://93.184.216.35/next";
    const requests: string[] = [];
    const transport = vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: redirected } })
        : new Response("arrived", { headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    if (action === "generic") manager.setMode("allow");
    else await manager.addRulePersist(allow("WebFetch(domain:93.184.216.34:443)"), { kind: "user" });
    if (action === "deny" || action === "ask" || action === "allow") await manager.addRulePersist({ pattern: "WebFetch(domain:93.184.216.35)", action }, { kind: "user" });
    const registry = new ToolRegistry();
    registry.register(createWebFetchTool(transport));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "redirect", name: "web_fetch", input: { url: origin } },
    ], { sessionId: "redirect", permissionContext: userPermissionContext() }));
    expect(requestAndWait).not.toHaveBeenCalled();
    const permitted = action === "allow" || action === "generic";
    expect(requests).toEqual(permitted ? [origin, redirected] : [origin]);
    expect(result?.is_error === true, result?.content).toBe(!permitted);
    if (!permitted) expect(result?.content).toContain("new permission decision");
  });

  // A screened request without a host rule is an ordinary mode ask, not a mandatory per-call one, so its redirects follow like any approved fetch.
  it.each(["none", "same-origin", "other-origin"] as const)("asks for a screened request without a host rule through the mode: %s", async (redirect) => {
    let requests = 0;
    const transport = vi.fn(async () => {
      requests += 1;
      return requests === 1 && redirect !== "none"
        ? new Response(null, { status: 302, headers: { location: redirect === "same-origin" ? "https://93.184.216.34/clean" : "https://93.184.216.35/clean" } })
        : new Response("approved", { headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const registry = new ToolRegistry();
    registry.register(createWebFetchTool(transport));
    const requestAndWait = vi.fn(async () => ({ choice: "allow-once" }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "request-floor", name: "web_fetch", input: { url: `https://93.184.216.34/start?token=${"sk-" + "a".repeat(50)}` } },
    ], { sessionId: "request-floor", permissionContext: userPermissionContext() }));
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(redirect === "none" ? 1 : 2);
    expect(result?.is_error === true, result?.content).toBe(false);
  });

  it.each(["none", "same-origin", "same-origin-sensitive", "other-origin"] as const)("honors an initial per-call approval and keeps redirect checks: %s", async (redirect) => {
    await manager.addRulePersist({ pattern: "WebFetch(domain:93.184.216.34)", action: "ask" }, { kind: "user" });
    let requests = 0;
    const nextUrl = redirect === "same-origin-sensitive"
      ? `https://93.184.216.34/next?token=${"sk-" + "a".repeat(50)}`
      : redirect === "same-origin" ? "https://93.184.216.34/next" : "https://93.184.216.35/next";
    const transport = vi.fn(async () => {
      requests += 1;
      return requests === 1 && redirect !== "none"
        ? new Response(null, { status: 302, headers: { location: nextUrl } })
        : new Response("approved", { headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const registry = new ToolRegistry();
    registry.register(createWebFetchTool(transport));
    const requestAndWait = vi.fn(async () => ({ choice: "allow-once" }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
    const [result] = await runWithToolExecutionCwd(project, () => executor.executeAll([
      { id: "ask-host", name: "web_fetch", input: { url: "https://93.184.216.34/start" } },
    ], { sessionId: "ask-host", permissionContext: userPermissionContext() }));
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(redirect === "same-origin" ? 2 : 1);
    expect(result?.is_error === true, result?.content).toBe(redirect === "other-origin" || redirect === "same-origin-sensitive");
  });
});

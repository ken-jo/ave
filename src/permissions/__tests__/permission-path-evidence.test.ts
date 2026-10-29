import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createPermissionPathEvidence, criticalDeleteTargetFor, isAdmissionDeniedPath, isSensitivePath, protectedControlEntryFor } from "../sensitive-paths.js";
import { evaluateScopedRules } from "../rules/scoped-rule-matcher.js";
import { inspectPowerShellPermissionPaths } from "../rules/powershell-exfiltration.js";
import { inspectShellPermissionPaths } from "../../tools/shell-path-policy.js";
import { SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
import { MAX_SHELL_ANALYSIS_TOKENS } from "../../shared/shell-analysis-limits.js";
import { PermissionManager } from "../permission-manager.js";

let root: string;
let project: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "permission-evidence-")));
  project = join(root, "project");
  mkdirSync(project);
  vi.stubEnv("AVE_HOME", join(root, "profile"));
});
afterEach(async () => { vi.unstubAllEnvs(); await cleanupTmpDir(root); });

describe("permission path facts", () => {
  it.each([".env", ".env.production", ".ssh/id_rsa", ".aws/credentials", ".kube/config"])("separates an ordinary secret from host admission for %s", (name) => {
    const path = join(project, name);
    expect(isSensitivePath(path, "read")).not.toBeNull();
    expect(isAdmissionDeniedPath(path, "read")).toBeNull();
    expect(createPermissionPathEvidence(project)({ lexical: path, canonical: path, effect: "read" })).toMatchObject({
      secret: expect.any(String), admissionDenial: null, protectedControl: undefined, projectEscape: false,
    });
  });

  it("keeps read and write facts separate while sharing each decision's policy roots", () => {
    const collect = createPermissionPathEvidence(project);
    const cases = ["ordinary", ".env", ".env.example", ".git/config", "../profile/keys/secret"];
    for (const effect of ["read", "write", "read"] as const) {
      for (const name of cases) {
        const target = join(project, name);
        const path = { lexical: target, canonical: target, effect };
        expect(collect(path)).toEqual({
          ...path,
          secret: isSensitivePath(target, effect),
          admissionDenial: isAdmissionDeniedPath(target, effect),
          protectedControl: effect === "write" ? protectedControlEntryFor(target) : undefined,
          projectEscape: false,
        });
      }
    }
    const secret = join(project, ".env");
    const redirected = join(root, "profile", "keys", "secret");
    expect(collect({ lexical: secret, canonical: redirected, effect: "read" })).toMatchObject({ secret: expect.any(String), admissionDenial: expect.any(String) });
    expect(collect({ lexical: secret, canonical: secret, effect: "read" }).admissionDenial).toBeNull();
  });

  it("refreshes relocated policy roots between decisions without reinterpreting frozen targets", () => {
    const firstHome = join(root, "first-host");
    const nextHome = join(root, "next-host");
    mkdirSync(firstHome);
    mkdirSync(nextHome);
    const homeLink = join(root, "host-state");
    symlinkSync(firstHome, homeLink, "junction");
    vi.stubEnv("AVE_HOME", homeLink);
    const collectFirst = createPermissionPathEvidence(project);
    const firstKey = join(firstHome, "keys", "secret");
    const nextKey = join(nextHome, "keys", "secret");
    const path = (target: string) => ({ lexical: target, canonical: target, effect: "read" as const });
    expect(collectFirst(path(firstKey)).admissionDenial).not.toBeNull();
    expect(collectFirst(path(nextKey)).admissionDenial).toBeNull();
    unlinkSync(homeLink);
    symlinkSync(nextHome, homeLink, "junction");
    const collectNext = createPermissionPathEvidence(project);
    expect(collectNext(path(nextKey)).admissionDenial).not.toBeNull();
    expect(collectNext(path(firstKey)).admissionDenial).toBeNull();
    expect(collectFirst(path(firstKey)).admissionDenial).not.toBeNull();
  });

  it.each([".env.example", ".env.sample", ".env.template", ".env.dist"])("retains the environment template exclusion for %s", (name) => {
    expect(isSensitivePath(join(project, name), "read")).toBeNull();
  });

  it.each([".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".claude", ".config/git", ".bashrc", ".zshrc", ".zprofile", ".profile", ".envrc", ".gitconfig", ".npmrc", ".mcp.json", ".claude.json"])("reports protected paths across case and separators for %s", (name) => {
    const target = `${project}/${name}/child`;
    expect(protectedControlEntryFor(target)).toBe(name);
    expect(createPermissionPathEvidence(project)({ lexical: target, canonical: target, effect: "read" }).protectedControl).toBeUndefined();
    expect(createPermissionPathEvidence(project)({ lexical: target, canonical: target, effect: "write" }).protectedControl).toBe(name);
    expect(protectedControlEntryFor(`C:\\workspace\\${name.toUpperCase().replaceAll("/", "\\")}\\child`)).toBe(name);
  });

  it.each([".githooks", ".pre-commit-config.yaml", "lefthook.yml", ".bash_profile"])("does not extend the protected set with %s", (name) => {
    expect(protectedControlEntryFor(join(project, name))).toBeUndefined();
  });

  it.each([".ave/secrets/token", ".ave/keys/key", ".ave/subscription-runtimes/profile/auth.json", "Library/Keychains/login.keychain-db", "AppData/Roaming/Microsoft/Protect/key", ".config/chromium/Default/Cookies"])("keeps host credential admission for %s", (name) => {
    expect(isAdmissionDeniedPath(join(root, name), "read")).not.toBeNull();
    expect(isAdmissionDeniedPath(join(root, name), "write")).not.toBeNull();
  });

  it("protects relocated application control state without credential admission", () => {
    const path = join(root, "profile", "permissions.json");
    expect(protectedControlEntryFor(path)).toBe("application-home");
    expect(isAdmissionDeniedPath(path)).toBeNull();
  });

  it("retains lexical and canonical protection across a link", () => {
    mkdirSync(join(project, ".git"));
    symlinkSync(join(project, ".git"), join(project, "alias"), process.platform === "win32" ? "junction" : "dir");
    const lexical = join(project, "alias", "config");
    writeFileSync(join(project, ".git", "config"), "synthetic");
    expect(createPermissionPathEvidence(project)({ lexical, canonical: realpathSync.native(lexical), effect: "write" }).protectedControl).toBe(".git");
  });

  it("reports link and parent escape without flooring ordinary absolute external writes", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(project, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(createPermissionPathEvidence(project)({ lexical: join(project, "link", "new"), canonical: join(outside, "new"), effect: "write" }).projectEscape).toBe(true);
    expect(createPermissionPathEvidence(project)({ lexical: `${project}/../outside/new`, canonical: join(outside, "new"), effect: "write" }).projectEscape).toBe(true);
    expect(createPermissionPathEvidence(project)({ lexical: join(outside, "new"), canonical: join(outside, "new"), effect: "write" }).projectEscape).toBe(false);
  });

  it("does not turn ordinary secret edits into a forced floor", () => {
    expect(evaluateScopedRules({ kind: "edit", paths: [".env"], cwd: project }, project, [{ pattern: "Edit(**)", action: "allow" }])).toMatchObject({ decision: "allow" });
  });

  it("retains a protected target among multiple edits", () => {
    expect(evaluateScopedRules({ kind: "edit", paths: ["ordinary", ".GIT/config"], cwd: project }, project, [{ pattern: "Edit(**)", action: "allow" }])).toMatchObject({ floor: "Protected control path: .git" });
  });

  it("distinguishes critical delete intent from ordinary recursive deletion", () => {
    for (const command of ["rm -rf /", "rm -rf .", "rm -rf .."]) {
      const result = inspectShellPermissionPaths(command, project);
      expect(result.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined), command).toBe(true);
    }
    const ordinary = inspectShellPermissionPaths("rm -rf src", project);
    expect(ordinary.paths.some((path) => path.deleteIntent)).toBe(true);
    expect(ordinary.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined)).toBe(false);
    const home = { lexical: join(project, "alias"), canonical: homedir() };
    expect(criticalDeleteTargetFor(home, [project])).toBe(homedir());
    const removed = inspectPowerShellPermissionPaths("Remove-Item -LiteralPath . -Recurse -Force", project);
    expect(removed.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined)).toBe(true);
    const removedHome = inspectPowerShellPermissionPaths("Remove-Item $HOME -Recurse", project);
    expect(removedHome.paths.some((path) => path.deleteIntent && criticalDeleteTargetFor(path, [project]) !== undefined)).toBe(true);
    expect(inspectShellPermissionPaths("mkdir ordinary", project).paths.some((path) => path.deleteIntent)).toBe(false);
  });

  it("reports secret reads and protected endpoints from parsed shell bindings", () => {
    const copied = inspectShellPermissionPaths("cp .env ordinary", project);
    expect(copied.paths.find((path) => path.secret !== null)?.effect).toBe("read");
    const command = inspectPowerShellPermissionPaths("Get-Content .env; Copy-Item -LiteralPath .env -Destination .GIT/config", project);
    expect(command.paths.some((path) => path.secret !== null && path.effect === "read")).toBe(true);
    expect(command.paths.some((path) => path.protectedControl === ".git")).toBe(true);
    expect(inspectPowerShellPermissionPaths("Get-Secret token", project).credentialStore).not.toBeNull();
    expect(inspectPowerShellPermissionPaths("Write-Output '.git/config'", project).paths).toEqual([]);
  });

  it("retains proven read-only status commands", () => {
    expect(inspectShellPermissionPaths("git status", project)).toMatchObject({ unproven: null });
  });

  it("collects both endpoints and later protected targets without a policy short circuit", () => {
    const evidence = inspectShellPermissionPaths(`cp .env ../outside; mv ordinary .GIT/config`, project);
    expect(evidence.unproven).toBeNull();
    expect(evidence.paths.some((path) => path.secret !== null && path.admissionDenial === null)).toBe(true);
    expect(evidence.paths.some((path) => path.projectEscape)).toBe(true);
    expect(evidence.paths.some((path) => path.protectedControl === ".git")).toBe(true);
    expect(evidence.paths).toHaveLength(4);
  });
});

describe("implicit and unresolved shell mutation targets", () => {
  it.each([
    "git config core.hooksPath /tmp", "git config --global core.hooksPath /tmp",
    "git config -- core.hooksPath --get", "git config -- core.hooksPath --help",
    "git remote add origin https://example.test/repo", "git remote -v add origin https://example.test/repo",
    "git remote --verbose set-url origin https://example.test/repo", "git remote -- remove origin",
    "git update-ref refs/heads/topic HEAD", "git symbolic-ref HEAD refs/heads/topic", "git init",
    "git branch topic", "git tag release", "git stash push", "git update-index --refresh",
    "git read-tree HEAD", "git pack-refs --all", "git reflog expire --all", "git worktree add ../worktree",
    "git submodule update", "git notes add -m note", "git --git-dir=../metadata config key value",
  ])("retains a protected metadata mutation fact for %s", (command) => {
    const facts = inspectShellPermissionPaths(command, project);
    expect(facts.unknownProtectedWrite).toMatch(/protected.*(?:repository|configuration)|repository.*protected/u);
    expect(facts.paths.some((path) => path.effect === "write")).toBe(true);
  });

  it.each([
    "git config --get remote.origin.url", "git config --list", "git config core.hooksPath",
    "git config --file .git/config remote.origin.url", "git config --type path remote.origin.url",
    "git remote -v", "git symbolic-ref HEAD", "git branch --list", "git tag --list",
    "git stash list", "git reflog --date=iso", "git notes --ref=commits show HEAD", "git submodule --quiet status",
  ])("does not invent a protected mutation for %s", (command) => {
    const facts = inspectShellPermissionPaths(command, project);
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.paths.filter((path) => path.protectedControl !== undefined)).toEqual([]);
  });

  it.each([
    'echo x > $AVE_HOME/config/settings.json', 'echo x > "$UNKNOWN"', 'echo x > "$(printf out.txt)"',
    'echo x > *.txt', 'tee "$UNKNOWN"', 'cp "$SOURCE" "$DESTINATION"', 'mv source "$DESTINATION"',
    'cp "-t$DESTINATION" source', 'gcc "-o$OUTPUT" source.c', 'gcc "--output=$OUTPUT" source.c',
    'curl -o "$OUTPUT" https://example.test/resource', 'OUT=out.txt; tee "$OUT"',
    'DEST=out.txt; cp -- source "$DEST"', 'cat "$READ"; echo x > "$WRITE"',
  ])("retains an unresolved protected-write possibility for %s", (command) => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toBeDefined();
  });

  it.each(['cat "$READ"', 'python -c "$CODE"', 'echo "$TEXT"', 'cp -- "$SOURCE" out.txt'])
  ("does not turn ordinary read/program uncertainty into a protected write: %s", (command) => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toBeUndefined();
  });

  it("binds a simple write target only to the actual initial host environment", () => {
    const environment = { OUTPUT: join(project, "out.txt"), PWD: project };
    const facts = inspectShellPermissionPaths('echo x > "$OUTPUT"', project, { dialect: "bash", environment });
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.resolvedWriteTargetsOnly).toBe(true);
    expect(facts.paths).toContainEqual(expect.objectContaining({ canonical: join(project, "out.txt"), effect: "write" }));
    expect(inspectShellPermissionPaths('OUTPUT=out.txt; echo x > "$OUTPUT"', project).unknownProtectedWrite).toBeDefined();
    expect(inspectShellPermissionPaths('echo "$TEXT" > "$OUTPUT"', project, { dialect: "bash", environment: { ...environment, TEXT: "x" } }).resolvedWriteTargetsOnly).toBeUndefined();
  });
});

describe("shell target operand roles", () => {
  it.each(['pwsh -enc $env:PAYLOAD > out.txt', '$COMMAND > out.txt'])("keeps a literal current-command redirect outside callee opacity: %s", command => {
    const facts = inspectShellPermissionPaths(command, project);
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.paths).toContainEqual(expect.objectContaining({ canonical: join(project, "out.txt"), effect: "write" }));
  });

  it("retains prefix-assignment state for an unknown callee's redirect", () => {
    const facts = inspectShellPermissionPaths('OUTPUT=.git/config $COMMAND > "$OUTPUT"', project,
      { dialect: "bash", environment: { OUTPUT: join(project, "out.txt") } });
    expect(facts.paths).toContainEqual(expect.objectContaining({ canonical: join(project, ".git", "config"), effect: "write", protectedControl: ".git" }));
    expect(facts.unknownProtectedWrite).toBeDefined();
  });

  it("retains a host-bound redirect before an unknown callee but invalidates later write state", () => {
    const environment = { OUTPUT: join(project, "out.txt") };
    expect(inspectShellPermissionPaths('$COMMAND > "$OUTPUT"', project, { dialect: "bash", environment }).unknownProtectedWrite).toBeUndefined();
    expect(inspectShellPermissionPaths('$COMMAND > "$OUTPUT"; echo x > later.txt', project, { dialect: "bash", environment }).unknownProtectedWrite).toBeDefined();
  });

  it.each(["strict", "default", "auto", "allow"] as const)("retains critical deletion from inherited group stdin in %s", mode => {
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode(mode);
    manager.setRules([{ pattern: "bash", action: "allow" }]);
    for (const headless of [false, true]) {
      const result = manager.checkDetailed("bash", "builtin", "shell", null, {
        ruleSubject: { kind: "shell", dialect: "bash", command: "( bash ) <<'EOF'\nrm -rf /\nEOF", cwd: project },
        shellExecution: { runsSandboxed: true }, headless,
      });
      expect(result).toMatchObject(headless ? { decision: "deny", reasonCode: "no-approver" }
        : { decision: "ask", reasonCode: "critical-delete", forceModal: true });
      expect(result.reviewer).toBeUndefined();
    }
  });

  it.each(["( bash </dev/null )", "( bash 0</dev/null )", "( echo ready | bash )", "( bash ) 3<<'OTHER'\nrm -rf /\nOTHER"])("keeps inherited input out of an overridden descriptor: %s", body => {
    const command = body.includes("OTHER") ? body : `${body} <<'EOF'\nrm -rf /\nEOF`;
    const facts = inspectShellPermissionPaths(command, project);
    expect(facts.paths.some(path => path.deleteIntent)).toBe(false);
    expect(facts.unknownProtectedWrite).toBeUndefined();
  });

  it("retains repeated operand facts while observing one physical identity per decision", () => {
    const target = join(project, "notes.txt");
    writeFileSync(target, "ordinary");
    const physicalReads = vi.spyOn(realpathSync, "native");
    try {
      const facts = inspectShellPermissionPaths("cat notes.txt notes.txt notes.txt", project);
      expect(facts.paths.filter(path => path.canonical === target)).toHaveLength(3);
      expect(physicalReads.mock.calls.filter(([path]) => path === target)).toHaveLength(1);
    } finally { physicalReads.mockRestore(); }
  });

  it("refreshes physical aliases between separate permission decisions", () => {
    const first = join(project, "first");
    const second = join(project, "second");
    mkdirSync(first); mkdirSync(second);
    writeFileSync(join(first, "notes.txt"), "first");
    writeFileSync(join(second, "notes.txt"), "second");
    const alias = join(project, "current");
    symlinkSync(first, alias, "junction");
    expect(inspectShellPermissionPaths("cat current/notes.txt", project).paths).toContainEqual(expect.objectContaining({ canonical: join(first, "notes.txt") }));
    unlinkSync(alias); symlinkSync(second, alias, "junction");
    expect(inspectShellPermissionPaths("cat current/notes.txt", project).paths).toContainEqual(expect.objectContaining({ canonical: join(second, "notes.txt") }));
  });

  it("keeps distinct read and delete evidence for the same protected spelling", () => {
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "config"), "ordinary");
    const paths = inspectShellPermissionPaths("cat .git/config; rm .git/config", project).paths;
    expect(paths).toContainEqual(expect.objectContaining({ effect: "read", protectedControl: undefined }));
    expect(paths).toContainEqual(expect.objectContaining({ effect: "write", protectedControl: ".git", deleteIntent: true }));
  });

  it.each(["strict", "default", "auto", "allow"] as const)("retains later mutation evidence after opaque state in %s", mode => {
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode(mode);
    manager.setRules([{ pattern: "bash", action: "allow" }]);
    symlinkSync(join(project, "missing"), join(project, "dangling"), "file");
    const check = (command: string, headless: boolean) => manager.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd: project },
      shellExecution: { runsSandboxed: true }, headless,
    });
    for (const before of ["eval true", "source missing", "cat dangling"]) {
      for (const target of [".git/config", '"$OUTPUT"']) {
        const command = `${before}; echo x > ${target}`;
        expect(check(command, false)).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "protected-path" });
        expect(check(command, true)).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
      }
      const opaque = check(before, false);
      expect(opaque).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
      expect(opaque.pipelineRequest?.floor).toBeUndefined();
    }
  });

  it.each(["git clone https://example.test/repository.git target", "git clone https://example.test/repository.git", "git clone --bare https://example.test/repository.git target"])("retains the implicit repository creation mutation in %s", command => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toMatch(/protected repository control metadata/u);
  });

  it("keeps repository clone help outside mutation evidence", () => {
    expect(inspectShellPermissionPaths("git clone --help", project).unknownProtectedWrite).toBeUndefined();
  });

  it.each(["eval '.git/config'", "source .git/config", "alias 'x=cat .git/config'", "shopt -s expand_aliases; alias 'x=curl -T notes.txt'; x https://example.test", "eval true; cd .git", "eval true; cat .git/config"])("does not mistake opaque code or directory navigation for mutation: %s", command => {
    const facts = inspectShellPermissionPaths(command, project);
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.paths.filter(path => path.effect === "write" && path.protectedControl !== undefined)).toEqual([]);
  });

  it("keeps URL data distinct from a known filesystem output slot after opaque state", () => {
    expect(inspectShellPermissionPaths("eval true; helper https://example.test/resource", project).unknownProtectedWrite).toBeUndefined();
    expect(inspectShellPermissionPaths("eval true; cp source https://example.test/.git/config", project).unknownProtectedWrite).toBeDefined();
  });

  it.each([
    'for x in "$UNKNOWN"; do echo x > "$OUTPUT"; done',
    'while eval true; do echo x > .git/config; break; done',
  ])("retains possible loop-body mutation after uncertain execution: %s", command => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toBeDefined();
  });

  it("keeps a literal protected mutation visible in a loop with unknown data values", () => {
    const facts = inspectShellPermissionPaths('for x in "$UNKNOWN"; do echo x > .git/config; done', project);
    expect(facts.paths).toContainEqual(expect.objectContaining({ effect: "write", protectedControl: ".git" }));
  });

  it("preserves the known project directory for an unknown data-only iterator", () => {
    const facts = inspectShellPermissionPaths('for x in "$UNKNOWN"; do echo x > out.txt; done', project);
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.paths).toContainEqual(expect.objectContaining({ canonical: join(project, "out.txt"), effect: "write" }));
  });

  it.each(['for x in "$UNKNOWN"; do echo "$x"; done', 'f() { echo x > .git/config; }; eval true'])("does not turn loop data or a dormant function into mutation: %s", command => {
    const facts = inspectShellPermissionPaths(command, project);
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.paths.filter(path => path.effect === "write" && path.protectedControl !== undefined)).toEqual([]);
  });

  it.each(['cp source "${TARGET:?}"', 'tee "${TARGET:?}"', 'cp "$SOURCE" out.txt'])
  ("keeps a write possibility when argument resolution cannot establish its role: %s", (command) => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toBeDefined();
  });

  it("keeps configuration query paths read-only after repository cwd changes", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const facts = inspectShellPermissionPaths(`git -C '${outside}' config --file relative --get key`, project);
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.paths).toContainEqual(expect.objectContaining({ canonical: join(outside, "relative"), effect: "read" }));
    expect(facts.paths.some((path) => path.canonical === join(project, "relative"))).toBe(false);
  });

  it("does not treat a directory change as a protected file mutation", () => {
    mkdirSync(join(project, ".git"));
    const facts = inspectShellPermissionPaths("cd .git", project);
    expect(facts.unknownProtectedWrite).toBeUndefined();
    expect(facts.paths.every((path) => path.protectedControl === undefined)).toBe(true);
  });
});

describe("non-output option roles", () => {
  it.each(['grep -o "$PATTERN" file', 'ls -o "$READ"', 'ssh -o "$OPTION" host', 'python -c "-o$CODE"'])
  ("does not infer a filesystem write from a non-output option: %s", (command) => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toBeUndefined();
  });
});

describe("nested evidence limits", () => {
  it("retains a real nested parser limit through the nested-command error wrapper", () => {
    const nested = ":;".repeat(MAX_SHELL_ANALYSIS_TOKENS + 1);
    const command = `bash -c '${nested}'`;
    expect(Buffer.byteLength(command)).toBeLessThan(SHELL_ANALYSIS_LIMITS.sourceBytes);
    expect(inspectShellPermissionPaths(command, project).unproven?.kind).toBe("analysis-limit");
  });
});

describe("repository push metadata targets", () => {
  it.each(["git push origin topic", "git push -u https://example.test/repo topic"])("retains a local metadata mutation for %s", (command) => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toBeDefined();
  });
  it.each(["git push http://example.test/repo", "git push --dry-run origin topic"])("does not invent a local metadata target for %s", (command) => {
    expect(inspectShellPermissionPaths(command, project).unknownProtectedWrite).toBeUndefined();
  });
});

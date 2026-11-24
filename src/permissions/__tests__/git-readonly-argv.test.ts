import { describe, expect, it } from "vitest";
import { gitReadOnlyEnvironment, isSupportedGitVersion, readOnlyGitArguments } from "../rules/git-readonly-argv.js";

const GLOBAL_ARGUMENTS = [
  "--no-pager", "--no-lazy-fetch", "--no-optional-locks", "--no-replace-objects",
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null",
  "-c", "core.untrackedCache=false", "-c", "diff.autoRefreshIndex=false",
  "-c", "diff.submodule=short", "-c", "status.submoduleSummary=false", "-c", "submodule.recurse=false",
  "-c", "log.showSignature=false", "-c", "log.mailmap=false", "-c", "log.decorate=false",
  "-c", "format.pretty=medium", "-c", "color.ui=false", "-c", "credential.helper=",
  "-c", "credential.interactive=false", "-c", "core.askPass=", "-c", "protocol.allow=never",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false",
];
const DIFF_ARGUMENTS = [
  "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short", "--no-renames",
  "--no-color", "--no-relative", "-O/dev/null",
];
const HISTORY_ARGUMENTS = [
  ...DIFF_ARGUMENTS, "--no-show-signature", "--no-patch", "--no-use-mailmap", "--no-notes",
  "--no-decorate", "--date=default", "--encoding=UTF-8",
];

describe("closed repository read arguments", () => {
  it.each([
    { input: ["git", "log"], output: ["log", ...HISTORY_ARGUMENTS, "--format=medium", "--"] },
    { input: ["git", "log", "--oneline", "-n", "3", "main..HEAD"], output: ["log", ...HISTORY_ARGUMENTS, "--format=oneline", "--abbrev-commit", "--max-count=3", "main..HEAD", "--"] },
    { input: ["git", "log", "--max-count=0", "refs/heads/main~2^1"], output: ["log", ...HISTORY_ARGUMENTS, "--format=medium", "--max-count=0", "refs/heads/main~2^1", "--"] },
    { input: ["git", "log", "--max-count", "999999", "main...HEAD", "--no-patch"], output: ["log", ...HISTORY_ARGUMENTS, "--format=medium", "--max-count=999999", "main...HEAD", "--"] },
    { input: ["git", "show", "--no-patch", "HEAD"], output: ["show", ...HISTORY_ARGUMENTS, "--format=medium", "HEAD", "--"] },
    { input: ["git", "show", "--no-patch", "--oneline"], output: ["show", ...HISTORY_ARGUMENTS, "--format=oneline", "--abbrev-commit", "--"] },
    { input: ["git", "diff", "HEAD~1", "HEAD", "--name-only"], output: ["diff-tree", "-r", "--no-commit-id", "--abbrev", ...DIFF_ARGUMENTS, "--name-only", "HEAD~1", "HEAD", "--"] },
    { input: ["git", "diff", "--name-status", "main", "HEAD"], output: ["diff-tree", "-r", "--no-commit-id", "--abbrev", ...DIFF_ARGUMENTS, "--name-status", "main", "HEAD", "--"] },
    { input: ["git", "diff", "main", "HEAD", "--raw"], output: ["diff-tree", "-r", "--no-commit-id", "--abbrev", ...DIFF_ARGUMENTS, "--raw", "main", "HEAD", "--"] },
    { input: ["git", "rev-parse", "--verify", "--quiet", "HEAD"], output: ["rev-parse", "--verify", "--quiet", "HEAD"] },
    { input: ["git", "rev-parse", "--verify", "HEAD~1"], output: ["rev-parse", "--verify", "HEAD~1"] },
    { input: ["git", "branch", "--list"], output: ["branch", "--no-sort", "--sort=refname", "--list", "--no-column", "--no-color"] },
    { input: ["git", "branch", "--list", "-a", "--sort=-refname"], output: ["branch", "--no-sort", "--sort=-refname", "--list", "--no-column", "--no-color", "--all"] },
    { input: ["git", "branch", "--remotes", "--list", "--sort=refname"], output: ["branch", "--no-sort", "--sort=refname", "--list", "--no-column", "--no-color", "--remotes"] },
  ])("owns complete argv for $input", ({ input, output }) => {
    const original = [...input];
    const result = readOnlyGitArguments(input);
    expect(result).toEqual([...GLOBAL_ARGUMENTS, ...output]);
    expect(input).toEqual(original);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(["--show-toplevel", "--show-prefix", "--git-dir", "--absolute-git-dir", "--is-inside-work-tree", "--is-bare-repository"])("owns the single %s query", (query) => {
    expect(readOnlyGitArguments(["git", "rev-parse", query])).toEqual([...GLOBAL_ARGUMENTS, "rev-parse", query]);
  });

  it.each([
    [], ["git"], ["/usr/bin/git", "log"], ["GIT", "log"], ["git", "-c", "core.fsmonitor=evil", "log"],
    ["git", "-C", "..", "log"], ["git", "--no-pager", "log"], ["git", "--exec-path=.", "log"],
    ["git", "status"], ["git", "status", "--porcelain"], ["git", "diff"], ["git", "diff", "--name-only"],
    ["git", "diff", "HEAD", "--raw"], ["git", "diff", "HEAD", "main", "--patch"],
    ["git", "diff", "--cached", "--name-only"], ["git", "diff", "--staged", "--name-status"],
    ["git", "diff", "--cached", "--raw", "HEAD"], ["git", "diff", "--staged", "HEAD", "--name-only"],
    ["git", "diff", "HEAD", "main", "--raw", "--cached"], ["git", "diff", "HEAD", "main", "--raw", "--staged"],
    ["git", "diff", "--cached", "--raw", "HEAD", "main"], ["git", "diff", "--cached", "--raw", "--staged"],
    ["git", "diff", "main..HEAD", "--raw"], ["git", "diff", "HEAD", "main", "--name-only", "--output=out"],
    ["git", "diff", "HEAD", "main", "--name-only", "--ext-diff"], ["git", "diff", "--cached", "--raw", "--textconv"],
    ["git", "diff", "HEAD", "main", "--raw", "-Osecret"], ["git", "diff", "HEAD", "main", "--raw", "--", "file"],
    ["git", "show"], ["git", "show", "HEAD"], ["git", "show", "--no-patch", "HEAD:file"],
    ["git", "show", "--no-patch", "HEAD", "--show-signature"], ["git", "log", "--format=%G?"],
    ["git", "log", "--pretty=custom"], ["git", "log", "--use-mailmap"], ["git", "log", "--notes"],
    ["git", "log", "--output=out"], ["git", "log", "--walk-reflogs"], ["git", "log", "HEAD", "main"],
    ["git", "log", "-n", "-1"], ["git", "log", "--max-count=1000000"], ["git", "log", "-n", "01"],
    ["git", "log", "-n"], ["git", "log", "-n", "1", "--max-count=1"], ["git", "log", "--oneline", "--oneline"],
    ["git", "rev-parse", "HEAD"], ["git", "rev-parse", "--verify", "--output-object-format=sha1", "HEAD"],
    ["git", "rev-parse", "--git-path", "config"], ["git", "rev-parse", "--show-toplevel", "--git-dir"],
    ["git", "branch"], ["git", "branch", "--list", "--sort=authordate"], ["git", "branch", "--list", "--format=%(contents)"],
    ["git", "branch", "--list", "*"], ["git", "branch", "--list", "-a", "-r"], ["git", "branch", "--list", "--delete"],
    ["git", "fetch"], ["git", "config", "--get", "core.fsmonitor"], ["git", "alias"],
  ].map((input) => ({ input })))("refuses every unowned argument form $input", ({ input }) => { expect(readOnlyGitArguments(input)).toBeNull(); });

  it.each(["-HEAD", "/HEAD", "HEAD:", "HEAD@{1}", "HEAD^{commit}", "HEAD....main", "HEAD..", "../HEAD", "a//b", "a.lock", "a./b", "a\\b", "a\n", "a\u0000", "a\u007f", ""])("refuses ambiguous revision %j", (revision) => {
    expect(readOnlyGitArguments(["git", "log", revision])).toBeNull();
    expect(readOnlyGitArguments(["git", "rev-parse", "--verify", revision])).toBeNull();
  });
  it("bounds argument count and cumulative bytes", () => {
    expect(readOnlyGitArguments(["git", "log", ...Array<string>(1999).fill("HEAD")])).toBeNull();
    expect(readOnlyGitArguments(["git", "log", "a".repeat(65_531)])).toBeNull();
  });
});

describe("owned child environment", () => {
  const repository = { gitDirectory: "/project/.git", workTree: "/project", referenceBackend: "files" as const };
  const indexFile = "/verified/install/.ave-readonly-index";
  const OWNED_ENVIRONMENT = {
    GIT_DIR: "/project/.git", GIT_WORK_TREE: "/project", GIT_CEILING_DIRECTORIES: "/project",
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0", GIT_REFERENCE_BACKEND: "files", GIT_INDEX_FILE: indexFile, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "",
    GIT_PROTOCOL_FROM_USER: "0", GIT_PAGER: "", GIT_TRACE: "0", GIT_TRACE2: "0", GIT_TRACE2_EVENT: "0", GIT_TRACE2_PERF: "0",
  };
  it("sets complete repository, configuration, transport and tracing boundaries", () => {
    expect(gitReadOnlyEnvironment({ PATH: "/protected/bin", LANG: "C", ordinary: "kept" }, repository, indexFile)).toEqual({
      PATH: "/protected/bin", LANG: "C", ordinary: "kept", ...OWNED_ENVIRONMENT,
    });
  });
  it.each([
    "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_COMMON_DIR",
    "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_EXEC_PATH", "GIT_SSH_COMMAND", "GIT_ASKPASS",
    "GIT_NAMESPACE", "GIT_TRACE_PACKET", "GIT_TRACE_PACK_ACCESS", "GIT_TRACE_CURL", "GIT_TRACE_SETUP", "GIT_TRACE_SHALLOW",
    "PAGER", "MANPAGER", "LESS", "LV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "_RLD_LIST", "LDR_PRELOAD", "LIBPATH",
    "SHLIB_PATH", "GCONV_PATH", "BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "BASH_FUNC_exec%%", "CDPATH", "IFS",
    "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NODE_USE_ENV_PROXY", "PYTHONPATH", "PYTHONHOME",
    "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "GEM_HOME", "BUNDLE_GEMFILE", "SSH_ASKPASS", "SSH_AUTH_SOCK", "SSLKEYLOGFILE",
  ])("removes inherited selector %s without case dependence", (key) => {
    const base = { [key]: "attack", [key.toLowerCase()]: "attack", unrelated: "kept" };
    expect(gitReadOnlyEnvironment(base, repository, indexFile)).toEqual({ unrelated: "kept", ...OWNED_ENVIRONMENT });
    expect(base[key]).toBe("attack");
  });
  it("overwrites inherited host-owned fields and removes their case variants", () => {
    const base = { git_dir: "outside", GIT_DIR: "outside", GIT_REFERENCE_BACKEND: "other", GIT_ALLOW_PROTOCOL: "all", GIT_TRACE2_EVENT: "out" };
    expect(gitReadOnlyEnvironment(base, repository, indexFile)).toEqual(OWNED_ENVIRONMENT);
  });
});

describe("supported installation version", () => {
  it.each(["git version 2.54.0", "git version 2.54.1\n", "git version 2.55.0\r\n", "git version 2.9999.0"])("admits %j", (output) => {
    expect(isSupportedGitVersion(output)).toBe(true);
  });
  it.each(["git version 2.53.9", "git version 1.99.0", "git version 3.0.0", "git version 02.54.0", "git version 2.054.0", "git version 2.54", "git version 2.54.0.windows.1", "git version 2.54.0 (custom)", "git version 2.54.0\nextra", "git version 2.54.0\n\n", " git version 2.54.0", "git version 2.54.0\u0000", "git version 2.10000.0"])("refuses %j", (output) => {
    expect(isSupportedGitVersion(output)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  gitReadOnlyEnvironment,
  isSupportedGitVersion,
  readOnlyGitArguments,
} from "../rules/git-readonly-argv.js";

describe("read-only repository arguments", () => {
  it("owns the complete history invocation and leaves the input unchanged", () => {
    const input = Object.freeze(["git", "log", "--oneline", "-n", "10", "main..topic"]);
    expect(readOnlyGitArguments(input)).toEqual([
      "--no-pager", "--no-lazy-fetch", "--no-optional-locks", "log",
      "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short", "--no-renames",
      "--no-show-signature", "--no-patch", "--format=oneline", "--abbrev-commit", "--max-count=10", "main..topic", "--",
    ]);
    expect(input).toEqual(["git", "log", "--oneline", "-n", "10", "main..topic"]);
    expect(Object.isFrozen(readOnlyGitArguments(input))).toBe(true);
    expect(readOnlyGitArguments(input)).not.toContain("--notes");
  });

  it.each([
    ["git", "log"],
    ["git", "log", "--max-count=0", "HEAD~1"],
    ["git", "log", "--max-count", "25", "main...topic"],
    ["git", "log", "refs/heads/topic", "--no-patch"],
    ["git", "show", "--no-patch"],
    ["git", "show", "--no-patch", "HEAD^1"],
  ])("consumes the bounded history form %j", (...argv) => {
    const result = readOnlyGitArguments(argv);
    expect(result).not.toBeNull();
    expect(result).toContain("--format=medium");
    expect(result).toContain("--notes");
    expect(result).toContain("--no-patch");
    expect(result).toContain("--no-show-signature");
    expect(result?.at(-1)).toBe("--");
    expect(result).not.toContain("--abbrev-commit");
  });

  it.each([
    { input: ["git", "log", "-n", "1"], expected: ["log", "--max-count=1"] },
    { input: ["git", "show", "--no-patch", "HEAD"], expected: ["show", "HEAD"] },
  ])("retains default note display for $input", ({ input, expected }) => {
    expect(readOnlyGitArguments(input)).toEqual([
      "--no-pager", "--no-lazy-fetch", "--no-optional-locks", expected[0],
      "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short", "--no-renames",
      "--no-show-signature", "--no-patch", "--format=medium", "--notes", expected[1], "--",
    ]);
  });

  it.each([
    { input: ["git", "diff", "--cached", "--name-only"], tail: ["--cached", "--name-only"] },
    { input: ["git", "diff", "--staged", "--raw", "HEAD~1"], tail: ["--cached", "--raw", "HEAD~1"] },
    { input: ["git", "diff", "main", "HEAD", "--name-status"], tail: ["--name-status", "main", "HEAD"] },
  ])("owns a content-free difference for $input", ({ input, tail }) => {
    expect(readOnlyGitArguments(input)).toEqual([
      "--no-pager", "--no-lazy-fetch", "--no-optional-locks", "diff",
      "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short", "--no-renames",
      ...tail, "--",
    ]);
  });

  it.each([
    "--show-toplevel", "--show-prefix", "--git-dir", "--absolute-git-dir",
    "--is-inside-work-tree", "--is-bare-repository",
  ])("owns exactly one revision query %s", (query) => {
    expect(readOnlyGitArguments(["git", "rev-parse", query])).toEqual([
      "--no-pager", "--no-lazy-fetch", "--no-optional-locks", "rev-parse", query,
    ]);
  });

  it.each([
    ["git", "rev-parse", "--verify", "HEAD"],
    ["git", "rev-parse", "--verify", "--quiet", "refs/heads/topic"],
  ])("owns one verified revision %j", (...argv) => {
    expect(readOnlyGitArguments(argv)).toEqual([
      "--no-pager", "--no-lazy-fetch", "--no-optional-locks", ...argv.slice(1),
    ]);
  });

  it.each([
    { input: ["git", "branch", "--list"], scope: [] },
    { input: ["git", "branch", "-a", "--list"], scope: ["--all"] },
    { input: ["git", "branch", "--list", "--all"], scope: ["--all"] },
    { input: ["git", "branch", "--list", "-r"], scope: ["--remotes"] },
    { input: ["git", "branch", "--remotes", "--list"], scope: ["--remotes"] },
  ])("clears inherited sort atoms before listing $input", ({ input, scope }) => {
    expect(readOnlyGitArguments(input)).toEqual([
      "--no-pager", "--no-lazy-fetch", "--no-optional-locks", "branch",
      "--no-sort", "--sort=refname", "--list", "--no-column", "--no-color", ...scope,
    ]);
  });

  it.each([
    [], ["git"], ["/usr/bin/git", "log"], ["GIT", "log"], ["env", "git", "log"],
    ["git", "status"], ["git", "show"], ["git", "show", "HEAD"],
    ["git", "diff"], ["git", "diff", "--name-only"], ["git", "diff", "HEAD", "--raw"],
    ["git", "diff", "--cached"], ["git", "diff", "--cached", "--stat"],
    ["git", "diff", "--cached", "--raw", "main", "topic"],
    ["git", "diff", "--raw", "main..topic"], ["git", "diff", "--raw", "main", "topic", "extra"],
    ["git", "diff", "--cached", "--staged", "--raw"],
    ["git", "diff", "--cached", "--name-only", "--raw"],
    ["git", "log", "--max-count=-1"], ["git", "log", "-n"], ["git", "log", "-n10"],
    ["git", "log", "--max-count=01"], ["git", "log", "--max-count=1", "-n", "2"],
    ["git", "log", "--oneline", "--oneline"], ["git", "show", "--no-patch", "--no-patch"],
    ["git", "branch"], ["git", "branch", "--list", "topic"],
    ["git", "branch", "--list", "--all", "--remotes"], ["git", "branch", "--list", "--list"],
    ["git", "branch", "--list", "--sort=refname"], ["git", "branch", "--list", "--format=%(signature)"],
    ["git", "rev-parse"], ["git", "rev-parse", "--verify"],
    ["git", "rev-parse", "--verify", "--quiet"], ["git", "rev-parse", "--quiet", "--verify", "HEAD"],
    ["git", "rev-parse", "--show-toplevel", "HEAD"],
    ["git", "rev-parse", "--verify", "HEAD", "main"],
    ["git", "log", "--", "file.txt"], ["git", "log", ""], ["git", "log", "HEAD\n"],
  ])("refuses unsupported or ambiguous argv %j", (...argv) => {
    expect(readOnlyGitArguments(argv)).toBeNull();
  });

  it.each([
    "--help", "-h", "--paginate", "--no-index", "--ext-diff", "--textconv", "--show-signature",
    "--alternate-refs", "--recurse-submodules", "--output=result", "--pretty=%G?", "--format=%(describe)",
    "--future", "--max", "-L1,2:file", "-p", "--stat", "--name-only", "--oneline=yes",
  ])("does not admit a dangerous or unknown history flag %s", (flag) => {
    expect(readOnlyGitArguments(["git", "log", flag])).toBeNull();
  });

  it.each([
    ["-c", "core.fsmonitor=marker"], ["--config-env=core.pager=PAGER"], ["--exec-path=/tmp/helper"],
    ["--git-dir=/tmp/repository"], ["--work-tree=/tmp/worktree"], ["-C", "."], ["--bare"],
  ])("does not accept global command overrides %j", (...prefix) => {
    expect(readOnlyGitArguments(["git", ...prefix, "log"])).toBeNull();
  });

  it.each([
    "HEAD:file", "HEAD^{commit}", "HEAD@{1}", "main....topic", "main..", "../topic", "/topic", "refs//topic",
    "refs/./topic", "refs/../topic", "refs/topic.lock", "topic.", "topic/", "-HEAD", "topic;id",
    "$(id)", "`id`", "topic\\name", "topic name", "topic*", "HEAD~", "HEAD^", "HEAD~1^",
  ])("does not reinterpret a revision operand %s", (revision) => {
    expect(readOnlyGitArguments(["git", "log", revision])).toBeNull();
    expect(readOnlyGitArguments(["git", "rev-parse", "--verify", revision])).toBeNull();
  });

  it("retains structural limits without truncating an invocation", () => {
    expect(readOnlyGitArguments(["git", "log", ...Array<string>(1_999).fill("HEAD")])).toBeNull();
    expect(readOnlyGitArguments(["git", "log", "r".repeat(65_536)])).toBeNull();
  });
});

describe("read-only repository child environment", () => {
  it("replaces inherited configuration and loader selectors with constant owned settings", () => {
    const input = Object.freeze({
      PATH: "/usr/bin:/bin", HOME: "/synthetic/home", LANG: "C", KEEP: "present",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "marker",
      git_config_parameters: "injected", GiT_DiR: "/outside", GIT_TRACE2_EVENT: "/outside/trace",
      GIT_SSH_COMMAND: "marker", GIT_TEST_FSMONITOR: "marker", GIT_CONFIG_VALUE_999: "residual",
      PAGER: "marker", pager: "marker", LD_PRELOAD: "marker", ld_audit: "marker", DYLD_INSERT_LIBRARIES: "marker",
      BASH_ENV: "marker", ENV: "marker", NODE_OPTIONS: "marker", GCONV_PATH: "marker", "BASH_FUNC_git%%": "marker",
    });
    expect(gitReadOnlyEnvironment(input)).toEqual({
      PATH: "/usr/bin:/bin", HOME: "/synthetic/home", LANG: "C", KEEP: "present",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "8", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "",
      GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "diff.autoRefreshIndex", GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "diff.submodule", GIT_CONFIG_VALUE_3: "short",
      GIT_CONFIG_KEY_4: "status.submoduleSummary", GIT_CONFIG_VALUE_4: "false",
      GIT_CONFIG_KEY_5: "submodule.recurse", GIT_CONFIG_VALUE_5: "false",
      GIT_CONFIG_KEY_6: "log.showSignature", GIT_CONFIG_VALUE_6: "false",
      GIT_CONFIG_KEY_7: "format.pretty", GIT_CONFIG_VALUE_7: "medium",
    });
    expect(input.GIT_CONFIG_VALUE_0).toBe("marker");
  });

  it.each([
    "GIT_EXEC_PATH", "GIT_CONFIG", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY",
    "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_EXTERNAL_DIFF", "GIT_ATTR_SOURCE",
    "GIT_TRACE", "GIT_TRACE_PACKFILE", "GIT_TRACE_SETUP", "GIT_TRACE2_ENV_VARS", "GIT_CONFIG_GLOBAL",
    "DYLD_LIBRARY_PATH", "_RLD_LIST", "LDR_PRELOAD", "LIBPATH", "SHLIB_PATH", "PYTHONPATH",
    "PERL5OPT", "RUBYOPT", "CDPATH", "IFS", "ZDOTDIR", "SHELLOPTS", "BASHOPTS",
  ])("removes inherited selector %s case-insensitively", (key) => {
    const result = gitReadOnlyEnvironment({ [key.toLowerCase()]: "marker" });
    expect(result).not.toHaveProperty(key.toLowerCase());
    expect(Object.values(result)).not.toContain("marker");
  });

  it("can sanitize a previous controlled environment without accumulating config entries", () => {
    const first = gitReadOnlyEnvironment({ KEEP: "present" });
    expect(gitReadOnlyEnvironment(first)).toEqual(first);
    expect(gitReadOnlyEnvironment({})).not.toBe(gitReadOnlyEnvironment({}));
  });
});

describe("supported executable version output", () => {
  it.each(["git version 2.45.0", "git version 2.45.1\n", "git version 2.54.0\r\n"])
    ("accepts a canonical supported release %j", (output) => {
      expect(isSupportedGitVersion(output)).toBe(true);
    });

  it.each([
    "git version 1.99.99", "git version 2.44.99", "git version 3.0.0", "git version 2.45", "git version 02.45.0",
    "git version 2.045.0", "git version 2.45.00", "git version 2.45.0-rc1", "git version 2.45.0.vendor.1",
    "git version 2.45.0 (build)", "git version 2.45.0 ", " git version 2.45.0", "GIT VERSION 2.45.0",
    "git version 2.45.0\nextra", "git version 2.45.0\n\n", "git version 2.45.0\0", "git version 99999.0.0", "",
  ])("refuses old, malformed, prerelease, or unestablished output %j", (output) => {
    expect(isSupportedGitVersion(output)).toBe(false);
  });
});

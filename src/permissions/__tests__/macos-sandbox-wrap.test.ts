import { describe, expect, it } from "vitest";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { hardenMacSandboxGitMetadata, macAppOwnedDirectoryWriteRules, macLinkedNameTargetRules, macWriteRootNameRules } from "../macos-sandbox-wrap.js";
import { parseSandboxWrappedWords, quoteSandboxWrappedWord } from "../sandbox-wrapped-command.js";
import { t } from "../../i18n/index.js";

function wrap(profile = "(version 1)\n(allow default)", command = "printf 'safe ! $HOME'\n") {
  return {
    argv: ["/bin/bash", "-c", ["env", "LABEL=owner's value", "/usr/bin/sandbox-exec", "-p", profile, "/bin/bash", "-c", command].map(quoteSandboxWrappedWord).join(" ")],
    env: { LABEL: "inherited" },
    cleanup: () => undefined,
  };
}

describe("typed repository marker rules", () => {
  it("pins the executable that precedes the sandbox in the runtime's command", () => {
    const platform = process.platform;
    const shell = process.execPath.replaceAll("\\", "/");
    setProcessPlatform("darwin");
    try {
      const command = "printf '%s' 'env is also user data'";
      const runtimeCommand = wrapCommandWithSandboxMacOS({
        command,
        binShell: shell,
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig: undefined,
        setEnvVars: { LABEL: "two words" },
      });
      const wrapped = hardenMacSandboxGitMetadata({ argv: [shell, "-c", runtimeCommand], env: {} });
      const words = parseSandboxWrappedWords(wrapped.argv[2] ?? "").map(word => word.value);
      expect(words.slice(0, 5)).toEqual(["/usr/bin/env", "LABEL=two words", "SANDBOX_RUNTIME=1", "/usr/bin/sandbox-exec", "-p"]);
      expect(words.slice(-3)).toEqual([shell, "-c", command]);
    } finally {
      setProcessPlatform(platform);
    }
  });

  it("keeps the command, environment and callback while adding exact entry rules", () => {
    const original = wrap();
    const originalWords = parseSandboxWrappedWords(original.argv[2]!);
    const hardened = hardenMacSandboxGitMetadata(original);
    const hardenedWords = parseSandboxWrappedWords(hardened.argv[2]!);
    expect(hardened.env).toBe(original.env);
    expect(hardened.cleanup).toBe(original.cleanup);
    expect(hardenedWords.slice(0, 4).map(word => word.value)).toEqual([
      "/usr/bin/env", ...originalWords.slice(1, 4).map(word => word.value),
    ]);
    expect(hardenedWords.slice(5).map(word => word.value)).toEqual(originalWords.slice(5).map(word => word.value));
    expect(hardenedWords[4]?.value).toContain('(deny file-write-create file-write-unlink (regex #"/\\.[gG][iI][tT]$"))');
    expect(hardenedWords[4]?.value).toContain('(deny file-write* file-write-create file-write-unlink (regex #"/srt-sock-[^/]*(/|$)"))');
    // Nothing names a project entry without the wrap's write roots.
    expect(hardenedWords[4]?.value).not.toContain("[aA][vV][eE]");
    expect(hardenedWords[4]?.value).toContain("(vnode-type REGULAR-FILE)");
    expect(hardenedWords[4]?.value.startsWith(originalWords[4]!.value)).toBe(true);
    expect(originalWords[4]?.value).not.toContain("REGULAR-FILE");
  });

  it.each([
    { argv: ["/bin/bash", "-c"] },
    { argv: ["/bin/bash", "-c", "echo sandbox-exec -p profile"] },
    { argv: ["/bin/bash", "-c", "env /tmp/sandbox-exec -p '(version 1)' /bin/bash -c true"] },
    { argv: ["/bin/bash", "-c", "env /usr/bin/sandbox-exec -f /tmp/profile /bin/bash -c true"] },
    { argv: ["/bin/bash", "-c", "env /usr/bin/sandbox-exec -p '(version 1)' /bin/bash -c true ; echo unsafe"] },
  ])("rejects an unsupported runtime command shape: $argv", ({ argv }) => {
    expect(() => hardenMacSandboxGitMetadata({ argv, env: {} })).toThrow("sandbox wrapper");
  });

  it("rejects an unexpected profile before launching anything", () => {
    expect(() => hardenMacSandboxGitMetadata(wrap("(allow default)"))).toThrow("unexpected profile shape");
  });

  it("bounds the expanded wrapper before a backend can launch", () => {
    const small = hardenMacSandboxGitMetadata(wrap(`(version 1)\n;${"x".repeat(190_000)}`));
    expect(Buffer.byteLength(small.argv[2] ?? "")).toBeLessThan(196_608);
    expect(() => hardenMacSandboxGitMetadata(wrap(`(version 1)\n;${"x".repeat(196_608)}`)))
      .toThrow(t("sandboxPolicy.tooLarge"));
  });
});

describe("named entry rules", () => {
  it("adds nothing without a write root", () => {
    expect(macWriteRootNameRules([])).toBe("");
  });

  const patterns = (rule: string) => [...rule.matchAll(/\(regex #"([^"]*)"\)/gu)].map(match => new RegExp(match[1] ?? "", "u"));
  const matches = (rule: string, path: string) => patterns(rule).some(pattern => pattern.test(path));

  it("anchors the entries and their carrying directories directly beneath each root", () => {
    const rules = macWriteRootNameRules(["/Users/example/project/", "/tmp/a.b[1]", "/Users/example/project"]).split("\n");
    expect(rules).toHaveLength(4);
    const entries = [rules[0] ?? "", rules[2] ?? ""];
    const carriers = [rules[1] ?? "", rules[3] ?? ""];
    for (const rule of entries) expect(rule.startsWith("(deny file-write* file-write-create file-write-unlink (regex #")).toBe(true);
    for (const rule of carriers) expect(rule.startsWith("(deny file-write-create file-write-unlink (regex #")).toBe(true);
    for (const denied of [
      "/Users/example/project/.agents", "/Users/example/project/.AGENTS/skills/x/SKILL.md", "/Users/example/project/.agents/plugins/marketplace.json",
      "/Users/example/project/.ave/commands/x.md", "/Users/example/project/.ave/Hooks", "/tmp/a.b[1]/.ave/hooks",
    ]) expect(entries.some(rule => matches(rule, denied)), denied).toBe(true);
    for (const allowed of [
      "/Users/example/project/.ave", "/Users/example/project/.ave/notes", "/Users/example/project/.ave/commands.bak",
      "/Users/example/project/sub/.agents/skills", "/Users/example/project/sub/.ave/commands", "/Users/example/projectx/.agents",
      "/tmp/aXb[1]/.agents", "/Users/example/.agents", "/Users/example/project/.codex/config.toml", "/Users/example/project/.aws/config",
    ]) expect(entries.some(rule => matches(rule, allowed)), allowed).toBe(false);
    // A quote cannot sit in a regex literal; it is matched as any character.
    expect(macWriteRootNameRules(['/tmp/a"b']).split("\n")[1]).toContain('(regex #"^/tmp/a.b/(');
    for (const pinned of ["/Users/example/project/.ave", "/Users/example/project/.Ave", "/tmp/a.b[1]/.ave"]) expect(carriers.some(rule => matches(rule, pinned)), pinned).toBe(true);
    for (const free of ["/Users/example/project/.ave/log", "/Users/example/project/sub/.ave", "/Users/example/project/.agents", "/Users/example/project/.avenue", "/Users/example/project/.codex"]) {
      expect(carriers.some(rule => matches(rule, free)), free).toBe(false);
    }
  });

  it("keeps every pattern under the length Seatbelt reads, whatever the root's length", () => {
    for (const length of [8, 200, 600, 900]) {
      const root = `/${"r".repeat(length - 1)}`;
      const [entries = "", carriers = ""] = macWriteRootNameRules([root]).split("\n");
      for (const literal of [...entries.matchAll(/#"([^"]*)"/gu), ...carriers.matchAll(/#"([^"]*)"/gu)]) expect((literal[1] ?? "").length).toBeLessThan(1000);
      for (const name of [".agents/skills/x", ".ave/commands/x.md", ".ave/hooks/x"]) expect(matches(entries, `${root}/${name}`), `${length} ${name}`).toBe(true);
    }
    // A root too long to anchor one name refuses the wrap instead of leaving the names open.
    expect(() => macWriteRootNameRules([`/${"r".repeat(990)}`])).toThrow(t("sandboxPolicy.tooLarge"));
  });

  it("counts the limit in bytes, for a root whose name takes several bytes a character", () => {
    const root = `/${"가".repeat(300)}`;
    const literals = [...macWriteRootNameRules([root]).matchAll(/#"([^"]*)"/gu)].map(match => match[1] ?? "");
    // 901 bytes of root leave room for one or two names in a pattern, not all three.
    expect(literals.length).toBeGreaterThan(2);
    for (const literal of literals) expect(Buffer.byteLength(literal)).toBeLessThanOrEqual(1000);
    for (const name of [".agents/skills/x", ".ave/commands/x.md", ".ave/hooks/x"]) expect(literals.some(literal => new RegExp(literal, "u").test(`${root}/${name}`)), name).toBe(true);
    expect(() => macWriteRootNameRules([`/${"가".repeat(400)}`])).toThrow(t("sandboxPolicy.tooLarge"));
  });

  it("anchors a root that holds pattern characters at both of its readings", () => {
    const rule = macWriteRootNameRules(["/tmp/a?b/s*r/k[1]"]).split("\n")[0] ?? "";
    for (const denied of ["/tmp/a?b/s*r/k[1]/.agents", "/tmp/axb/sample-r/k[1]/.ave/hooks/x"]) expect(matches(rule, denied), denied).toBe(true);
    for (const allowed of ["/tmp/a/b/s*r/k[1]/.agents", "/tmp/a?b/s/r/k[1]/.agents", "/tmp/a?b/s*r/k1/.agents", "/tmp/a?b/s*r/k[1]/sub/.agents"]) {
      expect(matches(rule, allowed), allowed).toBe(false);
    }
    expect(matches(macWriteRootNameRules(["/tmp/**/out"]).split("\n")[0] ?? "", "/tmp/a/b/out/.agents")).toBe(true);
  });
});

describe("linked name target rules", () => {
  it("adds nothing without a target", () => {
    expect(macLinkedNameTargetRules([], ["/Users/example/project"])).toBe("");
  });

  it("denies each target as a directory and pins it and the folders above it inside a write root", () => {
    expect(macLinkedNameTargetRules(["/Users/example/project/tools/shared/agents", "/Users/example/elsewhere/cmds"], ["/Users/example/project/", "/tmp/x"]).split("\n")).toEqual([
      '(deny file-write* file-write-create file-write-unlink (subpath "/Users/example/project/tools/shared/agents"))',
      '(deny file-write-unlink (literal "/Users/example/project/tools/shared"))',
      '(deny file-write-unlink (literal "/Users/example/project/tools"))',
      '(deny file-write* file-write-create file-write-unlink (subpath "/Users/example/elsewhere/cmds"))',
    ]);
    expect(() => macLinkedNameTargetRules([`/${"가".repeat(400)}`], [])).toThrow(t("sandboxPolicy.tooLarge"));
  });
});

describe("app-owned directory write rules", () => {
  const home = "/Users/example/.ave";
  const runtime = "/Users/example/Library/Caches/app/mxc-runtime";

  it("adds nothing unless a write root holds the directory", () => {
    expect(macAppOwnedDirectoryWriteRules([home, runtime], ["/Users/example/project", `${home}/workspace`, `${home}/sandbox/home/x`])).toBe("");
    // The directory itself as a root is the caller's own grant, not an ancestor.
    expect(macAppOwnedDirectoryWriteRules([home], [home])).toBe("");
    // A sibling that only shares the spelling's prefix holds nothing.
    expect(macAppOwnedDirectoryWriteRules([home], ["/Users/example/.av"])).toBe("");
  });

  it("denies the directory except the wrap's own roots inside it", () => {
    const rules = macAppOwnedDirectoryWriteRules([home, runtime], ["/Users/example", `${home}/workspace`, `${home}/sandbox/home/x`, "/tmp"]).split("\n");
    expect(rules).toEqual([
      `(deny file-write* file-write-create file-write-unlink (require-all (subpath "${home}") (require-not (subpath "${home}/workspace")) (require-not (subpath "${home}/sandbox/home/x"))))`,
      `(deny file-write* file-write-create file-write-unlink (subpath "${runtime}"))`,
    ]);
  });

  it("reads a root spelled in another case as the same folder", () => {
    expect(macAppOwnedDirectoryWriteRules([home], ["/users/EXAMPLE"]).split("\n")[0])
      .toBe(`(deny file-write* file-write-create file-write-unlink (subpath "${home}"))`);
    // The home spelled in another case is the home, not an ancestor of it.
    expect(macAppOwnedDirectoryWriteRules([home], ["/Users/example/.AVE"])).toBe("");
    expect(macAppOwnedDirectoryWriteRules([home], ["/Users/example", "/Users/example/.AVE/Workspace"]).split("\n")[0])
      .toBe(`(deny file-write* file-write-create file-write-unlink (require-all (subpath "${home}") (require-not (subpath "/Users/example/.AVE/Workspace"))))`);
  });

  it("writes a path as one quoted literal whatever it holds", () => {
    const odd = '/Users/example/a "b"\\c/.ave';
    expect(macAppOwnedDirectoryWriteRules([odd], ["/Users/example"]).split("\n")[0])
      .toBe(`(deny file-write* file-write-create file-write-unlink (subpath ${JSON.stringify(odd)}))`);
  });

  it("appends the rules after the entry rules", () => {
    const rules = macAppOwnedDirectoryWriteRules([home], ["/Users/example"]);
    const profileOf = (wrapped: { argv: string[] }) => parseSandboxWrappedWords(wrapped.argv[2] ?? "", "test")[4]?.value ?? "";
    expect(profileOf(hardenMacSandboxGitMetadata(wrap(), rules)).endsWith(`\n${rules}`)).toBe(true);
    expect(profileOf(hardenMacSandboxGitMetadata(wrap()))).toContain("(version 1)");
    expect(profileOf(hardenMacSandboxGitMetadata(wrap()))).not.toContain("require-not");
  });
});

describe("sandbox argument encoding", () => {
  it.each(["", "plain/path", "one two", "owner's file", "line\nnext\tcolumn", "! $HOME `id` ; * \\"])("round-trips %j as one literal word", value => {
    expect(parseSandboxWrappedWords(quoteSandboxWrappedWord(value)).map(word => word.value)).toEqual([value]);
  });
  it.each(["'unterminated", "$(command)", "one; two", '"unexpected"'])("rejects an encoding the runtime does not emit: %j", command => {
    expect(() => parseSandboxWrappedWords(command)).toThrow();
  });
});

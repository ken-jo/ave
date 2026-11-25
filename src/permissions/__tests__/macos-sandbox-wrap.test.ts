import { describe, expect, it } from "vitest";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { hardenMacSandboxGitMetadata, macAppOwnedDirectoryWriteRules } from "../macos-sandbox-wrap.js";
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
    expect(hardenedWords[4]?.value).toContain('(deny file-write-create file-write-unlink (regex #"/\\.[aA][vV][eE]$"))');
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

describe("app-owned directory write rules", () => {
  const home = "/Users/person/.ave";
  const runtime = "/Users/person/Library/Caches/app/mxc-runtime";

  it("adds nothing unless a write root holds the directory", () => {
    expect(macAppOwnedDirectoryWriteRules([home, runtime], ["/Users/person/project", `${home}/workspace`, `${home}/sandbox/home/own`])).toBe("");
    // The directory itself as a root is the caller's own grant, not an ancestor.
    expect(macAppOwnedDirectoryWriteRules([home], [home])).toBe("");
    // A sibling that only shares the spelling's prefix holds nothing.
    expect(macAppOwnedDirectoryWriteRules([home], ["/Users/person/.av"])).toBe("");
  });

  it("denies the directory except the wrap's own roots inside it, and pins its ancestors", () => {
    const rules = macAppOwnedDirectoryWriteRules([home, runtime], ["/Users/person", `${home}/workspace`, `${home}/sandbox/home/own`, "/tmp"]).split("\n");
    expect(rules).toEqual([
      `(deny file-write* file-write-create file-write-unlink (require-all (subpath "${home}") (require-not (subpath "${home}/workspace")) (require-not (subpath "${home}/sandbox/home/own"))))`,
      '(deny file-write-unlink (literal "/Users/person"))',
      '(deny file-write-unlink (literal "/Users"))',
      `(deny file-write* file-write-create file-write-unlink (subpath "${runtime}"))`,
      '(deny file-write-unlink (literal "/Users/person/Library/Caches/app"))',
      '(deny file-write-unlink (literal "/Users/person/Library/Caches"))',
      '(deny file-write-unlink (literal "/Users/person/Library"))',
    ]);
  });

  it("writes a path as one quoted literal whatever it holds", () => {
    const odd = '/Users/person/a "b"\\c/.ave';
    expect(macAppOwnedDirectoryWriteRules([odd], ["/Users/person"]).split("\n")[0])
      .toBe(`(deny file-write* file-write-create file-write-unlink (subpath ${JSON.stringify(odd)}))`);
  });

  it("appends the rules after the entry rules", () => {
    const rules = macAppOwnedDirectoryWriteRules([home], ["/Users/person"]);
    const profile = parseSandboxWrappedWords(hardenMacSandboxGitMetadata(wrap(), rules).argv[2]!, "test")[4]!.value;
    expect(profile.endsWith(`\n${rules}`)).toBe(true);
    expect(parseSandboxWrappedWords(hardenMacSandboxGitMetadata(wrap()).argv[2]!, "test")[4]!.value).not.toContain("require-not");
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

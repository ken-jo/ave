import { describe, expect, it } from "vitest";
import { hardenMacSandboxGitMetadata } from "../macos-sandbox-wrap.js";
import { parseSandboxWrappedWords, quoteSandboxWrappedWord } from "../sandbox-wrapped-command.js";

function wrap(profile = "(version 1)\n(allow default)", command = "printf 'safe ! $HOME'\n") {
  return {
    argv: ["/bin/bash", "-c", ["env", "LABEL=owner's value", "/usr/bin/sandbox-exec", "-p", profile, "/bin/bash", "-c", command].map(quoteSandboxWrappedWord).join(" ")],
    env: { LABEL: "inherited" },
    cleanup: () => undefined,
  };
}

describe("typed repository marker rules", () => {
  it("keeps the command, environment and callback while adding exact entry rules", () => {
    const original = wrap();
    const originalWords = parseSandboxWrappedWords(original.argv[2]!);
    const hardened = hardenMacSandboxGitMetadata(original);
    const hardenedWords = parseSandboxWrappedWords(hardened.argv[2]!);
    expect(hardened.env).toBe(original.env);
    expect(hardened.cleanup).toBe(original.cleanup);
    expect(hardenedWords.slice(0, 4)).toEqual(originalWords.slice(0, 4));
    expect(hardenedWords.slice(5).map(word => word.value)).toEqual(originalWords.slice(5).map(word => word.value));
    expect(hardenedWords[4]?.value).toContain('(deny file-write-create file-write-unlink (regex #"/\\.[gG][iI][tT]$"))');
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
});

describe("sandbox argument encoding", () => {
  it.each(["", "plain/path", "one two", "owner's file", "line\nnext\tcolumn", "! $HOME `id` ; * \\"])("round-trips %j as one literal word", value => {
    expect(parseSandboxWrappedWords(quoteSandboxWrappedWord(value)).map(word => word.value)).toEqual([value]);
  });
  it.each(["'unterminated", "$(command)", "one; two", '"unexpected"'])("rejects an encoding the runtime does not emit: %j", command => {
    expect(() => parseSandboxWrappedWords(command)).toThrow();
  });
});

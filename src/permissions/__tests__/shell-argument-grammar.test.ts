import { describe, expect, it } from "vitest";
import { _argumentGrammarsForTest, _matchArgumentGrammarForTest, _proveStaticArgvForTest, proveStaticArgv } from "../rules/shell-argument-grammar.js";

const argumentGrammars = _argumentGrammarsForTest();
const optionalArgumentCases = argumentGrammars.flatMap(({ command, grammar }) =>
  (grammar.optionalValues ?? []).map((option) => ({ name: [...command, option].join(" "), option, grammar })));
const configurationCases = argumentGrammars.filter(({ grammar }) => grammar.configuration !== undefined);

describe("positive shell argument grammars", () => {
  it("requires every declared configuration suppressor at the first argument", () => {
    expect(configurationCases.length).toBeGreaterThan(0);
    for (const { grammar } of configurationCases) {
      expect(_matchArgumentGrammarForTest(["https://x.invalid"], grammar)).toBe(false);
      for (const option of grammar.configuration!.disabledByFirstArgument) {
        expect(grammar.flags).toContain(option);
        expect(_matchArgumentGrammarForTest([option, "https://x.invalid"], grammar)).toBe(true);
        expect(_matchArgumentGrammarForTest(["https://x.invalid", option], grammar)).toBe(false);
      }
    }
  });
  it.each(["bash", "powershell"] as const)("requires disabled implicit configuration at the delegated argv boundary in %s", (dialect) => {
    const prefixes = dialect === "bash" ? [[], ["env"], ["command"], ["exec"]] : [["env"]];
    for (const prefix of prefixes) {
      for (const args of [[], ["-q"], ["--no-config"], ["--no-rc"]]) {
        expect(proveStaticArgv([...prefix, "wget", ...args, "https://x.invalid"], dialect).kind).toBe("unproven");
      }
      for (const args of [[], ["-s"], ["-s", "-q"], ["-sq"], ["--", "-q"], ["--disable="], ["--no-disable"]]) {
        expect(proveStaticArgv([...prefix, "curl", ...args, "https://x.invalid"], dialect).kind).toBe("unproven");
      }
      for (const first of ["-q", "--disable"]) {
        expect(proveStaticArgv([...prefix, "curl", first, "-s", "https://x.invalid"], dialect).kind).toBe("static-complete");
        for (const option of ["-K", "--config"]) {
          expect(proveStaticArgv([...prefix, "curl", first, option, "settings", "https://x.invalid"], dialect).kind).toBe("unproven");
        }
      }
    }
  });
  it("requires both grammars when an alias can be a native program in another edition", () => {
    for (const argv of [["wget", "https://x.invalid"], ["curl", "https://x.invalid"], ["CURL", "https://x.invalid"], ["WGET", "https://x.invalid"], ["curl", "-q", "https://x.invalid"], ["cat", "-Raw", "notes.txt"]]) {
      expect(proveStaticArgv(argv, "powershell").kind).toBe("unproven");
    }
    expect(proveStaticArgv(["cat", "notes.txt"], "powershell").kind).toBe("static-complete");
    expect(proveStaticArgv(["iwr", "https://x.invalid"], "powershell").kind).toBe("static-complete");
    expect(proveStaticArgv(["env", "curl", "-q", "https://x.invalid"], "powershell").kind).toBe("static-complete");
  });
  it("gives each registered option exactly one arity", () => {
    expect(optionalArgumentCases.length).toBeGreaterThan(0);
    for (const { grammar } of argumentGrammars) {
      const names = [...(grammar.flags ?? []), ...(grammar.values ?? []), ...(grammar.optionalValues ?? [])];
      expect(new Set(names).size).toBe(names.length);
    }
  });
  it.each(optionalArgumentCases)("never consumes a following word for optional $name", ({ option, grammar }) => {
    expect(grammar.values ?? []).not.toContain(option);
    const isolated = { optionalValues: [option], flags: ["--retained"], maximum: 0 };
    const attached = option.startsWith("--") ? `${option}=value` : `${option}value`;
    expect(_matchArgumentGrammarForTest([option], isolated)).toBe(true);
    expect(_matchArgumentGrammarForTest([attached], isolated)).toBe(true);
    expect(_matchArgumentGrammarForTest([option, "--unknown"], isolated)).toBe(false);
    expect(_matchArgumentGrammarForTest([option, "later"], isolated)).toBe(false);
    expect(_matchArgumentGrammarForTest([option, "--retained"], { ...isolated, required: [["--retained"]] })).toBe(true);
    expect(_matchArgumentGrammarForTest([attached, "--unknown"], isolated)).toBe(false);
  });
  it("uses attached-only optional values inside a short option group", () => {
    const grammar = { optionalValues: ["-j"], flags: ["-q"], maximum: 0 };
    for (const args of [["-j"], ["-j4"], ["-qj4"], ["-qj"], ["-j", "-q"]]) {
      expect(_matchArgumentGrammarForTest(args, grammar)).toBe(true);
    }
    for (const args of [["-j", "4"], ["-qj", "4"], ["-j", "--eval=code"], ["-j4", "--unknown"]]) {
      expect(_matchArgumentGrammarForTest(args, grammar)).toBe(false);
    }
    expect(_matchArgumentGrammarForTest(["-jq"], { ...grammar, required: [["-q"]] })).toBe(false);
    expect(_matchArgumentGrammarForTest(["-qj4"], { ...grammar, required: [["-q"]] })).toBe(true);
  });
  it("keeps required-value options separate from optional-value options", () => {
    const grammar = { values: ["--required", "-r"], optionalValues: ["--optional", "-o"], maximum: 0 };
    for (const args of [["--required", "value"], ["--required=value"], ["-rvalue"], ["-r", "value"]]) {
      expect(_matchArgumentGrammarForTest(args, grammar)).toBe(true);
    }
    for (const args of [["--required"], ["-r"], ["--optional", "value"], ["-o", "value"]]) {
      expect(_matchArgumentGrammarForTest(args, grammar)).toBe(false);
    }
    expect(_matchArgumentGrammarForTest(["--optional=value"], grammar)).toBe(true);
    expect(_matchArgumentGrammarForTest(["-ovalue"], grammar)).toBe(true);
  });
  it.each(["bash", "powershell"] as const)("refuses executable build and configured command families in %s", (dialect) => {
    for (const argv of [
      ["make", "-f", "/dev/null", "X:=$(shell printf make-inline-probe >&2)"],
      ["make", "-j", "--eval=$(shell printf make-inline-probe >&2)"],
      ["git", "show", "--pretty", "--ext-diff", "567197b83", "--", "src/permissions/rules/shell-argument-grammar.ts"],
      ["make"], ["git", "status"], ["git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv"],
    ]) expect(proveStaticArgv(argv, dialect).kind).toBe("unproven");
  });
  it.each(["bash", "powershell"] as const)("does not swallow a later option as an optional value in %s", (dialect) => {
    expect(proveStaticArgv(["ls", "--color", "--unknown"], dialect).kind).toBe("unproven");
  });
  it.each(["bash", "powershell"] as const)("does not prove unknown heads or prototype names in %s", (dialect) => {
    for (const head of ["unknown-program", "constructor", "toString", "__proto__", "./printf", "fake-pwsh"]) {
      expect(proveStaticArgv([head, "ready"], dialect).kind).toBe("unproven");
      expect(proveStaticArgv(["env", head, "ready"], dialect).kind).toBe("unproven");
    }
  });
  it.each(["bash", "powershell"] as const)("requires complete known option consumption in %s", (dialect) => {
    for (const words of [ ["git", "status", "--unknown"], ["node", "--unknown", "file.js"], ["curl", "--unknown", "https://x.invalid"], ["env", "PATH=./bin", "printf", "ready"], ["xargs", "-a", "inputs.txt", "pwsh"], ["find", ".", "-exec", "pwsh", "{}", ";"], ["parallel", "printf", "{}"] ]) {
      expect(proveStaticArgv(words, dialect).kind).toBe("unproven");
    }
  });
  it("separates quoted strings from unsupported PowerShell parameters", () => {
    expect(proveStaticArgv(["Write-Output", "-Force"], "powershell", ["Write-Output", "'-Force'"]).kind).toBe("static-complete");
    expect(proveStaticArgv(["Write-Output", "-Force"], "powershell", ["Write-Output", "-Force"]).kind).toBe("unproven");
    expect(proveStaticArgv(["Invoke-Expression", "-Command", "dir", "-Verbose"], "powershell").kind).toBe("unproven");
  });
  it.each(["bash", "powershell"] as const)("proves supported literal evaluation without certifying its payload in %s", (dialect) => {
    for (const words of [["fish", "--no-config", "--command", "printf ready"], ["bash", "--noprofile", "--norc", "-p", "-c", "npm test"], ["python3", "-I", "-S", "-c", "print(1)"]]) {
      expect(proveStaticArgv(words, dialect).kind).toBe("literal-evaluation");
    }
    expect(proveStaticArgv(["pwsh", "-EncodedCommand", "P"], dialect).kind).toBe("unproven");
  });
  it.each(["bash", "powershell"] as const)("refuses nested startup without an explicit isolation proof in %s", (dialect) => {
    for (const argv of [
      ["zsh"], ["zsh", "-f", "-c", "printf ready"], ["pwsh", "-File", "ordinary.ps1"],
      ["pwsh", "-NoProfile", "-File", "ordinary.ps1"], ["powershell", "-NoProfile", "-Command", "Get-Date"],
      ["bash", "-c", "printf ready"], ["bash", "--noprofile", "--norc", "-c", "printf ready"],
      ["sh", "-c", "printf ready"], ["dash", "-c", "printf ready"], ["ksh", "-c", "printf ready"],
      ["fish", "--command", "printf ready"], ["python3", "-c", "print(1)"], ["python3", "-I", "-c", "print(1)"],
      ["python", "-I", "-S", "-c", "print(1)"], ["node", "-e", "console.log(1)"], ["node", "file.js"],
      ["ruby", "-e", "puts 1"], ["perl", "-e", "print 1"], ["bun", "file.js"], ["deno", "run", "file.ts"],
      ["cmd", "/c", "echo ready"], ["npm", "run", "test"], ["pnpm", "test"], ["yarn", "test"], ["npx", "printf", "ready"],
    ]) {
      expect(proveStaticArgv(argv, dialect).kind, argv.join(" ")).toBe("unproven");
      expect(proveStaticArgv(["env", ...argv], dialect).kind, "env " + argv.join(" ")).toBe("unproven");
    }
  });
  it.each(["bash", "powershell"] as const)("retains only complete isolated nested launcher grammars in %s", (dialect) => {
    for (const argv of [
      ["bash", "--noprofile", "--norc", "-p", "-c", "npm test"],
      ["python3", "-I", "-S", "-c", "print(1)"], ["python3.12", "-S", "-I", "-c", "print(1)", "literal-argv"],
      ["fish", "--no-config", "--command", "printf ready"],
    ]) expect(proveStaticArgv(argv, dialect).kind, argv.join(" ")).toBe("literal-evaluation");
    for (const argv of [
      ["bash", "--noprofile", "--norc", "-p", "script.sh"], ["python3", "-I", "-S", "script.py"], ["fish", "-N", "script.fish"],
    ]) expect(proveStaticArgv(argv, dialect).kind, argv.join(" ")).toBe("static-complete");
    for (const argv of [
      ["bash", "--noprofile", "--norc", "-p", "--rcfile", "rc", "-c", "ready"],
      ["python3", "-I", "-S", "-i", "-c", "print(1)"], ["fish", "-N", "-C", "printf other", "-c", "printf ready"],
    ]) expect(proveStaticArgv(argv, dialect).kind, argv.join(" ")).toBe("unproven");
  });
  it("carries state changes through known wrappers", () => {
    expect(proveStaticArgv(["env", "cp", "source", "runner"], "bash")).toMatchObject({ kind: "static-complete", changesState: true });
    expect(proveStaticArgv(["cd", "-"], "bash").kind).toBe("unproven");
  });
  it("keeps shell command resolution outside external delegation", () => {
    for (const prefix of [["env"]]) {
      for (const child of [["Write-Output", "ready"], ["iwr", "-Uri", "https://x.invalid", "-InFile", "notes.txt"], ["Invoke-Expression", "dir"], ["eval", "ls"], ["cd", "directory"], ["builtin", "printf", "ready"], ["command", "printf", "ready"]]) {
        expect(proveStaticArgv([...prefix, ...child], "powershell").kind).toBe("unproven");
      }
      expect(proveStaticArgv([...prefix, "eval", "ls"], "bash").kind).toBe("unproven");
      expect(proveStaticArgv([...prefix, "printf", "ready"], "powershell").kind).toBe("static-complete");
      expect(proveStaticArgv([...prefix, "bash", "--noprofile", "--norc", "-p", "-c", "ls"], "powershell").kind).toBe("literal-evaluation");
    }
    expect(proveStaticArgv(["eval", "ls"], "powershell").kind).toBe("unproven");
    expect(proveStaticArgv(["exec", "eval", "ls"], "bash").kind).toBe("unproven");
    expect(proveStaticArgv(["builtin", "git", "status"], "bash").kind).toBe("unproven");
    expect(proveStaticArgv(["builtin", "printf", "ready"], "bash").kind).toBe("static-complete");
    expect(proveStaticArgv(["command", "printf", "ready"], "bash").kind).toBe("static-complete");
  });
  it.each(["bash", "powershell"] as const)("does not infer an inline shell argument tail in %s", (dialect) => {
    expect(proveStaticArgv(["fish", "--command", "printf ready", "--unknown"], dialect).kind).toBe("unproven");
    expect(proveStaticArgv(["fish", "-c", "printf ready", "-C", "printf other"], dialect).kind).toBe("unproven");
  });
  it("counts actual grammar reads linearly across wrapper prefixes", () => {
    for (const dialect of ["bash", "powershell"] as const) {
      for (const [wrapper, expected] of [["env", "static-complete"], ["npx", "unproven"]] as const) {
        const work = [128, 256, 398].map((size) => _proveStaticArgvForTest([...Array.from({ length: size }, () => wrapper), "printf", "%s", "ready"], dialect));
        expect(work.every((entry) => entry.proof.kind === expected)).toBe(true);
        expect(work[1]!.work.staticTokens / work[0]!.work.staticTokens).toBeLessThanOrEqual(2.5);
        expect(work[2]!.work.staticTokens / work[1]!.work.staticTokens).toBeLessThanOrEqual(2.5);
      }
    }
  });
});

it.each(["bash", "powershell"] as const)("refuses undocumented attached short evaluator options in %s", (dialect) => {
  for (const argv of [
    ["bash", "--noprofile", "--norc", "-p", "-c=printf ready"],
    ["python3", "-I", "-S", "-c=print(1)"],
    ["fish", "-N", "-c=printf ready"],
  ]) expect(_proveStaticArgvForTest(argv, dialect).proof).toEqual({ kind: "unproven" });
});

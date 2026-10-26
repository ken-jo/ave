import { describe, expect, it } from "vitest";
import { _proveStaticArgvForTest, proveStaticArgv } from "../rules/shell-argument-grammar.js";

describe("positive shell argument grammars", () => {
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
    for (const words of [["node", "--eval=console.log(1)"], ["node", "-e", "console.log(1)"], ["node", "-p", "1"], ["fish", "--command", "printf ready"], ["bash", "-c", "npm test"], ["python3", "-c", "print(1)"], ["perl", "-e", "print 1"], ["ruby", "-e", "puts 1"]]) {
      expect(proveStaticArgv(words, dialect).kind).toBe("literal-evaluation");
    }
    expect(proveStaticArgv(["pwsh", "-EncodedCommand", "P"], dialect).kind).toBe("unproven");
  });
  it("carries state changes through known wrappers", () => {
    expect(proveStaticArgv(["env", "cp", "source", "runner"], "bash")).toMatchObject({ kind: "static-complete", changesState: true });
    expect(proveStaticArgv(["cd", "-"], "bash").kind).toBe("unproven");
  });
  it("keeps shell command resolution outside external delegation", () => {
    for (const prefix of [["env"], ["npx"], ["npm", "exec", "--"]]) {
      for (const child of [["Write-Output", "ready"], ["iwr", "-Uri", "https://x.invalid", "-InFile", "notes.txt"], ["Invoke-Expression", "dir"], ["eval", "ls"], ["cd", "directory"], ["builtin", "printf", "ready"], ["command", "printf", "ready"]]) {
        expect(proveStaticArgv([...prefix, ...child], "powershell").kind).toBe("unproven");
      }
      expect(proveStaticArgv([...prefix, "eval", "ls"], "bash").kind).toBe("unproven");
      expect(proveStaticArgv([...prefix, "printf", "ready"], "powershell").kind).toBe("static-complete");
      const explicitPrefix = prefix[0] === "npx" ? [...prefix, "--"] : prefix;
      expect(proveStaticArgv([...explicitPrefix, "bash", "-c", "ls"], "powershell").kind).toBe("literal-evaluation");
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
  it("counts actual positive grammar reads linearly across runner prefixes", () => {
    for (const dialect of ["bash", "powershell"] as const) {
      const work = [128, 256, 398].map((size) => _proveStaticArgvForTest([...Array.from({ length: size }, () => "npx"), "printf", "%s", "ready"], dialect));
      expect(work.every((entry) => entry.proof.kind === "static-complete")).toBe(true);
      expect(work[1]!.work.staticTokens / work[0]!.work.staticTokens).toBeLessThanOrEqual(2.5);
      expect(work[2]!.work.staticTokens / work[1]!.work.staticTokens).toBeLessThanOrEqual(2.5);
    }
  });
});

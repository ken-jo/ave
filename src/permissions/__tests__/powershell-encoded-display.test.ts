import { describe, expect, it } from "vitest";
import { decodePowerShellEncodedCommands } from "../rules/powershell-encoded-command.js";

const SCRIPT = "Write-Output 'fixture'";
const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");
const DIALECTS = ["bash", "powershell"] as const;

function encode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

describe("literal encoded operand display", () => {
  it.each(DIALECTS)("decodes only the launcher's actual operand (%s)", (dialect) => {
    const decoys = Array.from({ length: 64 }, (_, index) => encode(`decoy ${index}`)).join(" ");
    expect(decodePowerShellEncodedCommands(`printf %s ${decoys}; pwsh -enc ${ENCODED}`, dialect)).toEqual([SCRIPT]);
  });

  it.each(DIALECTS)("does not inspect encoded data or recurse into scripts (%s)", (dialect) => {
    expect(decodePowerShellEncodedCommands(`printf %s ${ENCODED}`, dialect)).toEqual([]);
    expect(decodePowerShellEncodedCommands(`printf %s pwsh -enc ${ENCODED}`, dialect)).toEqual([]);
    const child = `pwsh -enc ${ENCODED}`;
    expect(decodePowerShellEncodedCommands(`pwsh -enc ${encode(child)}`, dialect)).toEqual([child]);
    expect(decodePowerShellEncodedCommands(`cmd /c 'pwsh -enc ${ENCODED}'`, dialect)).toEqual([]);
    expect(decodePowerShellEncodedCommands(`bash -c 'pwsh -enc ${ENCODED}'`, dialect)).toEqual([]);
  });

  it.each(DIALECTS)("preserves short and non-ASCII literal scripts without text thresholds (%s)", (dialect) => {
    for (const script of ["x", "Write-Output '문자'", "\u0000"]) {
      expect(decodePowerShellEncodedCommands(`pwsh -enc ${encode(script)}`, dialect)).toEqual([script]);
    }
  });

  it.each(DIALECTS)("decodes every direct invocation without a script-count limit (%s)", (dialect) => {
    const scripts = Array.from({ length: 65 }, (_, index) => `Write-Output ${index}`);
    const command = scripts.map((script) => `pwsh -enc ${encode(script)}`).join("; ");
    expect(decodePowerShellEncodedCommands(command, dialect)).toEqual(scripts);
  });

  it.each(DIALECTS)("reads a quoted whitespace-split operand (%s)", (dialect) => {
    const split = ENCODED.replace(/(.{4})/g, "$1 \n").trim();
    expect(decodePowerShellEncodedCommands(`pwsh -enc '${split}'`, dialect)).toEqual([SCRIPT]);
  });

  it.each(DIALECTS)("retains a literal operand beyond the reusable-rule input limit (%s)", (dialect) => {
    const script = "Write-Output 'fixture'; ".repeat(1_000);
    const command = `pwsh -enc ${encode(script)}`;
    expect(command.length).toBeGreaterThan(10_000);
    expect(decodePowerShellEncodedCommands(command, dialect)).toEqual([script]);
  });

  it.each(["-e", "-ec", "-en", "-enc", "-EncodedCommand", "–enc", "—enc", "―enc", "/enc", "--enc"])("recognizes the literal %s flag", (flag) => {
    expect(decodePowerShellEncodedCommands(`pwsh ${flag} ${ENCODED}`, "powershell")).toEqual([SCRIPT]);
  });

  it.each(["pwsh", "powershell", "pwsh-preview", "powershell_ise", "pwsh.exe", "powershell.exe", "pwsh-preview.exe", "powershell_ise.exe"])("uses the exact launcher identity %s", (launcher) => {
    expect(decodePowerShellEncodedCommands(`${launcher} -enc ${ENCODED}`, "bash")).toEqual([SCRIPT]);
  });

  it.each(["pwsh-custom", "pwsh5", "pwsh.cmd", "notpwsh"])("does not infer a launcher from %s", (launcher) => {
    expect(decodePowerShellEncodedCommands(`${launcher} -enc ${ENCODED}`, "bash")).toEqual([]);
  });

  it("keeps parameter values and script arguments out of the encoded flag position", () => {
    expect(decodePowerShellEncodedCommands(`pwsh -WorkingDirectory '-enc' ${ENCODED}`, "powershell")).toEqual([]);
    expect(decodePowerShellEncodedCommands(`pwsh -Command 'Select-String -e ${ENCODED}'`, "powershell")).toEqual([]);
    expect(decodePowerShellEncodedCommands(`pwsh -File fixture.ps1 -enc ${ENCODED}`, "powershell")).toEqual([]);
  });

  it.each(["pwsh -enc", "pwsh -enc AAAA", "pwsh -enc !!!!", "pwsh -enc $PAYLOAD", 'pwsh -enc "$PAYLOAD"'])("does not invent a decoded script for %s", (command) => {
    expect(decodePowerShellEncodedCommands(command, "powershell")).toEqual([]);
  });
});

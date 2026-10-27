import { describe, expect, it } from "vitest";
import { createPowerShellParserResponse, MAX_POWERSHELL_PARSER_RESPONSE_BYTES } from "../powershell-parser-response.js";

describe("internal shell parser response", () => {
  it("retains JSON larger than the display preview in independent chunks", () => {
    const source = JSON.stringify({ commands: Array.from({ length: 100 }, () => ({ name: "Write-Output", text: "Write-Output a", arguments: [{ kind: "literal", text: "Write-Output", value: "Write-Output" }, { kind: "literal", text: "a", value: "a" }] })), errors: [], redirections: [], unsupported: [] });
    expect(source.length).toBeGreaterThan(12_000);
    const response = createPowerShellParserResponse();
    const bytes = Buffer.from(source);
    for (let offset = 0; offset < bytes.length; offset += 1_024) response.collect(bytes.subarray(offset, offset + 1_024));
    expect(JSON.parse(response.read())).toEqual(JSON.parse(source));
  });

  it("fails closed at its own byte bound and never returns a truncated protocol", () => {
    const response = createPowerShellParserResponse();
    response.collect(Buffer.alloc(MAX_POWERSHELL_PARSER_RESPONSE_BYTES, 0x20));
    expect(response.read()).toHaveLength(MAX_POWERSHELL_PARSER_RESPONSE_BYTES);
    response.collect(Buffer.from("x"));
    expect(() => response.read()).toThrow("PowerShell parser response exceeds the internal byte limit");
    response.collect(Buffer.from("{}"));
    expect(() => response.read()).toThrow("PowerShell parser response exceeds the internal byte limit");
  });
});

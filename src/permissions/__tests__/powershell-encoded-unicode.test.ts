import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodedPowerShellExecutionReason } from "../rules/powershell-encoded-command.js";
import { proveLiteralPowerShell } from "../rules/powershell-exfiltration.js";
import { proveLiteralShell } from "../rules/shell-rule-matcher.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { assignedRejectedCodePoints, codePointChunks, CODE_POINT_CHUNK_COUNT, DIALECTS, POSITIONS,
  PAYLOAD, RUNTIME_WHITE_SPACE, optionWith, useEncodedUnicodeFixture } from "../../__tests__/support/encoded-unicode-fixtures.js";

const fixture = useEncodedUnicodeFixture();
const { checkCommand } = fixture;

describe.each(DIALECTS)("positive launcher argument character proof (%s)", (dialect) => {
  it("keeps an encoded carrier unproven while the selected mode owns approval", () => {
    const command = "pwsh -enc !!!";
    expect(buildShellRuleApproval(dialect, command, fixture.cwd, { allow: true, deny: true }).exactRule).toBeNull();
    const context = { ruleSubject: { kind: "shell" as const, dialect, command, cwd: fixture.cwd }, shellExecution: { runsSandboxed: false }, headless: true };
    fixture.manager.setRules([]);
    fixture.manager.setMode("allow");
    try {
      expect(fixture.manager.checkDetailed(dialect, "builtin", "shell", null, context)).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    } finally {
      fixture.manager.setMode("strict");
    }
    expect(fixture.manager.checkDetailed(dialect, "builtin", "shell", null, context)).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
  });

  it("rejects the literal next-line control around the option", () => {
    expect(checkCommand(dialect, "\u0085-enc\u0085")).toBeNull();
  });

  it("refuses an unpaired surrogate before a native text conversion", () => {
    for (const point of [0xd800, 0xdfff]) {
      for (const position of POSITIONS) expect(checkCommand(dialect, optionWith(point, position))).toBeNull();
    }
    expect(encodedPowerShellExecutionReason(["pwsh", "argument\uFFFD\u{1F600}"])).toBeNull();
  });

  it("cross-checks runtime whitespace and the explicit ASCII space exception", () => {
    for (const point of RUNTIME_WHITE_SPACE) {
      if (point === 0x20) continue;
      for (const position of POSITIONS) expect(checkCommand(dialect, optionWith(point, position)), `U+${point.toString(16)}`).toBeNull();
    }
    const literalCommand = "pwsh -Command 'Write-Output 한글 문장'";
    const proof = dialect === "bash" ? proveLiteralShell(literalCommand) : proveLiteralPowerShell(literalCommand);
    // Korean remains in the positive character class; the child startup lacks
    // its independent proof and cannot acquire an exact allow.
    expect(proof.proven).toBe(false);
    expect(buildShellRuleApproval(dialect, literalCommand, fixture.cwd, { allow: true, deny: true }).exactRule).toBeNull();
    fixture.manager.setRules([withCurrentShellRuleVersion({ pattern: `${dialect === "bash" ? "Bash" : "PowerShell"}(${literalCommand})`, action: "allow" as const })]);
    expect(fixture.manager.checkDetailed(dialect, "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect, command: literalCommand, cwd: fixture.cwd }, shellExecution: { runsSandboxed: false }, headless: true,
    }).decision).toBe("deny");
    expect(encodedPowerShellExecutionReason(["pwsh", "한글 문장"])).toBeNull();
    expect(encodedPowerShellExecutionReason(["pwsh", " -Command ", "한글"])).toBeNull();
    for (const position of POSITIONS) expect(checkCommand(dialect, optionWith(0x20, position))).toBeNull();
    expect(checkCommand(dialect, " -enc ")).toBeNull();
    expect(encodedPowerShellExecutionReason(["pwsh", "abc\u0378def"])).not.toBeNull();
    expect(encodedPowerShellExecutionReason(["pwsh", "abc\u0301def"])).not.toBeNull();
  });
});

it("proves the complete generated rejection set at each character boundary", () => {
  for (const point of assignedRejectedCodePoints) {
    for (const position of POSITIONS) {
      const char = String.fromCodePoint(point);
      const literal = position === "head" ? `${char}argument` : position === "middle" ? `arg${char}ument` : `argument${char}`;
      if (encodedPowerShellExecutionReason(["pwsh", literal]) === null || encodedPowerShellExecutionReason(["pwsh", optionWith(point, position), PAYLOAD]) === null) {
        throw new Error(`U+${point.toString(16).toUpperCase()} ${position}: launcher character proof succeeded`);
      }
    }
  }
}, 30_000);

it("generates the complete assigned category census without sampling", () => {
  console.info(JSON.stringify({ unicode: process.versions.unicode, assignedRejectedCodePoints: assignedRejectedCodePoints.length, commandCases: assignedRejectedCodePoints.length * POSITIONS.length * DIALECTS.length, asciiSpaceCases: POSITIONS.length * DIALECTS.length, totalAssignedCommandCases: (assignedRejectedCodePoints.length + 1) * POSITIONS.length * DIALECTS.length }));
  expect(codePointChunks.flat()).toEqual(assignedRejectedCodePoints);
  expect(codePointChunks).toHaveLength(CODE_POINT_CHUNK_COUNT);
  expect(codePointChunks.every((points) => points.length > 0)).toBe(true);
  expect(assignedRejectedCodePoints.length).toBeGreaterThan(139_000);
  expect(assignedRejectedCodePoints).toContain(0x85);
  expect(assignedRejectedCodePoints).toContain(0xd800);
  expect(assignedRejectedCodePoints).toContain(0x10fffd);
  expect(assignedRejectedCodePoints).not.toContain(0x20);
  expect(assignedRejectedCodePoints).not.toContain(0x378);
});

it("keeps every dialect, boundary and chunk partition collected", () => {
  const files = readdirSync(new URL("./powershell-encoded-unicode/", import.meta.url));
  const expected = DIALECTS.flatMap(dialect => POSITIONS.flatMap(position =>
    ["first", "second"].map(half => `${dialect}-${position}-${half}.test.ts`)));
  expect(files.filter(file => file.endsWith(".test.ts")).sort()).toEqual(expected.sort());
});

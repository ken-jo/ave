import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { encodedPowerShellExecutionReason } from "../rules/powershell-encoded-command.js";
import { proveLiteralPowerShell } from "../rules/powershell-exfiltration.js";
import { proveLiteralShell } from "../rules/shell-rule-matcher.js";
import { canonicalRuleSpecifier, RuleSpecifierError } from "../rules/rule-specifier.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";

const PAYLOAD = Buffer.from("Write-Output PROBE_OK", "utf16le").toString("base64");
const DIALECTS = ["bash", "powershell"] as const;
const POSITIONS = ["head", "middle", "tail"] as const;
const ASSIGNED_SEPARATOR_OR_OTHER_RE = /^(?:\p{Z}|\p{C})$/u;
const UNASSIGNED_RE = /^\p{Cn}$/u;
const assignedRejectedCodePoints = Array.from({ length: 0x110000 }, (_, point) => point)
  .filter((point) => point !== 0x20 && ASSIGNED_SEPARATOR_OR_OTHER_RE.test(String.fromCodePoint(point)) && !UNASSIGNED_RE.test(String.fromCodePoint(point)));
const CODE_POINT_CHUNK_COUNT = 12;
const codePointChunkSize = Math.ceil(assignedRejectedCodePoints.length / CODE_POINT_CHUNK_COUNT);
const codePointChunks = Array.from({ length: CODE_POINT_CHUNK_COUNT }, (_, index) =>
  assignedRejectedCodePoints.slice(index * codePointChunkSize, (index + 1) * codePointChunkSize));
const codePointCases = POSITIONS.flatMap((position) => codePointChunks.map((points, index) => ({
  position, points, chunk: index + 1, half: index < CODE_POINT_CHUNK_COUNT / 2 ? "first" : "second",
})));
// The runtime character-class contract includes separator categories plus these control characters.
const RUNTIME_WHITE_SPACE = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x20, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
let cwd: string;
let manager: PermissionManager;
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "encoded-unicode-"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function optionWith(point: number, position: typeof POSITIONS[number]): string {
  const char = String.fromCodePoint(point);
  return position === "head" ? `${char}-enc` : position === "middle" ? `-e${char}nc` : `-enc${char}`;
}

function checkCommand(dialect: typeof DIALECTS[number], option: string): string | null {
  if (encodedPowerShellExecutionReason(["pwsh", option, PAYLOAD]) === null) return "launcher character proof succeeded";
  const command = `pwsh '${option}' ${PAYLOAD}`;
  const proof = dialect === "bash" ? proveLiteralShell(command) : proveLiteralPowerShell(command);
  if (proof.proven) return "literal proof succeeded";
  if (buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule !== null) return "exact rule offered";
  // Supply the matching raw rule even when the card correctly declines to offer it.
  const rawPattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`;
  try {
    const pattern = canonicalRuleSpecifier(rawPattern);
    manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" as const })]);
  } catch (error) {
    if (!(error instanceof RuleSpecifierError)) throw error;
    manager.setRules([]);
  }
  const context = { ruleSubject: { kind: "shell" as const, dialect, command, cwd }, shellExecution: { runsSandboxed: false }, headless: true };
  if (manager.checkDetailed(dialect, "builtin", "shell", null, context).decision === "allow") return "headless allow";
  return null;
}

describe.each(DIALECTS)("positive launcher argument character proof (%s)", (dialect) => {
  it("rejects the literal next-line control around the option", () => {
    expect(checkCommand(dialect, "\u0085-enc\u0085")).toBeNull();
  });

  it("refuses an unpaired surrogate before a native text conversion", () => {
    for (const point of [0xd800, 0xdfff]) {
      for (const position of POSITIONS) expect(checkCommand(dialect, optionWith(point, position))).toBeNull();
    }
    expect(encodedPowerShellExecutionReason(["pwsh", "argument\uFFFD\u{1F600}"])).toBeNull();
  });

  it.each(codePointCases)("rejects assigned separator or other code points in chunk $chunk at the $position half $half", ({ position, points, chunk, half }) => {
    for (const point of points) {
      const failure = checkCommand(dialect, optionWith(point, position));
      if (failure !== null) throw new Error(`U+${point.toString(16).toUpperCase()} ${position}: ${failure}`);
    }
    console.info(JSON.stringify({ dialect, position, half, chunk, checkedCodePoints: points.length }));
  }, 1_800_000);

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
    expect(buildShellRuleApproval(dialect, literalCommand, cwd, { allow: true, deny: true }).exactRule).toBeNull();
    manager.setRules([withCurrentShellRuleVersion({ pattern: `${dialect === "bash" ? "Bash" : "PowerShell"}(${literalCommand})`, action: "allow" as const })]);
    expect(manager.checkDetailed(dialect, "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect, command: literalCommand, cwd }, shellExecution: { runsSandboxed: false }, headless: true,
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

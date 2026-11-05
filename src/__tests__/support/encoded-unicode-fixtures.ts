import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { encodedPowerShellExecutionReason } from "../../permissions/rules/powershell-encoded-command.js";
import { proveLiteralPowerShell } from "../../permissions/rules/powershell-exfiltration.js";
import { proveLiteralShell } from "../../permissions/rules/shell-rule-matcher.js";
import { canonicalRuleSpecifier, RuleSpecifierError } from "../../permissions/rules/rule-specifier.js";
import { buildShellRuleApproval } from "../../permissions/rules/shell-rule-approval.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";

export const PAYLOAD = Buffer.from("Write-Output PROBE_OK", "utf16le").toString("base64");
export const DIALECTS = ["bash", "powershell"] as const;
export const POSITIONS = ["head", "middle", "tail"] as const;
const ASSIGNED_SEPARATOR_OR_OTHER_RE = /^(?:\p{Z}|\p{C})$/u;
const UNASSIGNED_RE = /^\p{Cn}$/u;
export const assignedRejectedCodePoints = Array.from({ length: 0x110000 }, (_, point) => point)
  .filter((point) => point !== 0x20 && ASSIGNED_SEPARATOR_OR_OTHER_RE.test(String.fromCodePoint(point)) && !UNASSIGNED_RE.test(String.fromCodePoint(point)));
export const CODE_POINT_CHUNK_COUNT = 12;
const codePointChunkSize = Math.ceil(assignedRejectedCodePoints.length / CODE_POINT_CHUNK_COUNT);
export const codePointChunks = Array.from({ length: CODE_POINT_CHUNK_COUNT }, (_, index) =>
  assignedRejectedCodePoints.slice(index * codePointChunkSize, (index + 1) * codePointChunkSize));
const codePointCases = POSITIONS.flatMap((position) => codePointChunks.map((points, index) => ({
  position, points, chunk: index + 1, half: index < CODE_POINT_CHUNK_COUNT / 2 ? "first" : "second",
})));
// The runtime character-class contract includes separator categories plus these control characters.
export const RUNTIME_WHITE_SPACE = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x20, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, index) => 0x2000 + index), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
export function optionWith(point: number, position: typeof POSITIONS[number]): string {
  const char = String.fromCodePoint(point);
  return position === "head" ? `${char}-enc` : position === "middle" ? `-e${char}nc` : `-enc${char}`;
}

export function useEncodedUnicodeFixture() {
  let cwd: string;
  let manager: PermissionManager;
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "encoded-unicode-"));
    manager = new PermissionManager(join(cwd, "permissions.json"));
    manager.setMode("strict");
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

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
  return { checkCommand, get manager() { return manager; }, get cwd() { return cwd; } };
}

// Each partition retains the complete boundary checks for its original chunks.
// Physical files let the normal suite sharding and worker pool distribute the census.
export function registerEncodedUnicodePartition(
  dialect: typeof DIALECTS[number], position: typeof POSITIONS[number], half: "first" | "second",
): void {
  const { checkCommand } = useEncodedUnicodeFixture();
  const cases = codePointCases.filter(row => row.position === position && row.half === half);
  it.each(cases)("rejects assigned separator or other code points in chunk $chunk at the $position half $half", ({ position, points, chunk, half }) => {
    for (const point of points) {
      const failure = checkCommand(dialect, optionWith(point, position));
      if (failure !== null) throw new Error(`U+${point.toString(16).toUpperCase()} ${position}: ${failure}`);
    }
    console.info(JSON.stringify({ dialect, position, half, chunk, checkedCodePoints: points.length }));
  }, 1_800_000);
}

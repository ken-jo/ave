import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vitestTierEnabled } from "../../../scripts/lib/vitest-tiers.mjs";
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
type Dialect = typeof DIALECTS[number];
type Position = typeof POSITIONS[number];
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
export function optionWith(point: number, position: Position): string {
  const char = String.fromCodePoint(point);
  return position === "head" ? `${char}-enc` : position === "middle" ? `-e${char}nc` : `-enc${char}`;
}
export const hex = (point: number) => `U+${point.toString(16).toUpperCase()}`;

// The complete four-layer census runs only in the census tier.
const CENSUS_TIER = vitestTierEnabled("census");

const CATEGORIES = ["Cc", "Cf", "Zs", "Zl", "Zp", "Co", "Cs"] as const;
const CATEGORY_RE = CATEGORIES.map((category) => [category, new RegExp(`^\\p{${category}}$`, "u")] as const);
export function rejectedCategory(point: number): typeof CATEGORIES[number] {
  const char = String.fromCodePoint(point);
  const match = CATEGORY_RE.find(([, pattern]) => pattern.test(char));
  if (match === undefined) throw new Error(`${hex(point)} is outside the rejected categories`);
  return match[0];
}
const EVERY_POINT_CATEGORIES = new Set<string>(["Cc", "Cf", "Zs", "Zl", "Zp"]);
const SAMPLE_STRIDE = { Co: 1024, Cs: 128 } as const;
// High private-use surrogates start at U+DB80; high surrogates end at U+DBFF.
const SURROGATE_EDGES = [0xdb7f, 0xdb80, 0xdbff, 0xdc00];

/** Every Cc, Cf and Z point; for Co and Cs, each contiguous run's edges and every stride-th point. */
export const representativeCodePoints = (() => {
  const picked = new Set<number>(SURROGATE_EDGES);
  let run: number[] = [];
  const closeRun = () => {
    if (run.length === 0) return;
    const stride = SAMPLE_STRIDE[rejectedCategory(run[0]) as keyof typeof SAMPLE_STRIDE];
    run.forEach((point, index) => { if (index % stride === 0) picked.add(point); });
    picked.add(run[run.length - 1]);
    run = [];
  };
  for (const point of assignedRejectedCodePoints) {
    const category = rejectedCategory(point);
    if (EVERY_POINT_CATEGORIES.has(category)) { closeRun(); picked.add(point); continue; }
    if (run.length > 0 && (point !== run[run.length - 1] + 1 || rejectedCategory(run[0]) !== category)) closeRun();
    run.push(point);
  }
  closeRun();
  return [...picked].sort((left, right) => left - right);
})();

/** The launcher and literal-proof layers, which reject every code point; the key names the rejection reasons. */
function lexicalRejection(dialect: Dialect, option: string): { failure: string | null; key: string } {
  const launcher = encodedPowerShellExecutionReason(["pwsh", option, PAYLOAD]);
  if (launcher === null) return { failure: "launcher character proof succeeded", key: "launcher proven" };
  const command = `pwsh '${option}' ${PAYLOAD}`;
  const proof = dialect === "bash" ? proveLiteralShell(command) : proveLiteralPowerShell(command);
  if (proof.proven) return { failure: "literal proof succeeded", key: "literal proven" };
  return { failure: null, key: `${launcher} | ${proof.reason}` };
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

  /** All four layers; decision names the headless outcome after the matching raw rule is supplied. */
  function traceCommand(dialect: Dialect, option: string): { failure: string | null; lexical: string; decision: string } {
    const lexical = lexicalRejection(dialect, option);
    if (lexical.failure !== null) return { failure: lexical.failure, lexical: lexical.key, decision: "unchecked" };
    const command = `pwsh '${option}' ${PAYLOAD}`;
    if (buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule !== null) {
      return { failure: "exact rule offered", lexical: lexical.key, decision: "unchecked" };
    }
    // Supply the matching raw rule even when the card correctly declines to offer it.
    const rawPattern = `${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`;
    let rule = "raw rule";
    try {
      const pattern = canonicalRuleSpecifier(rawPattern);
      manager.setRules([withCurrentShellRuleVersion({ pattern, action: "allow" as const })]);
    } catch (error) {
      if (!(error instanceof RuleSpecifierError)) throw error;
      manager.setRules([]);
      rule = "no rule";
    }
    const context = { ruleSubject: { kind: "shell" as const, dialect, command, cwd }, shellExecution: { runsSandboxed: false }, headless: true };
    const result = manager.checkDetailed(dialect, "builtin", "shell", null, context);
    const decision = `${rule} | ${result.decision} | ${result.reasonCode}`;
    return { failure: result.decision === "allow" ? "headless allow" : null, lexical: lexical.key, decision };
  }
  const checkCommand = (dialect: Dialect, option: string) => traceCommand(dialect, option).failure;
  return { checkCommand, traceCommand, get manager() { return manager; }, get cwd() { return cwd; } };
}

// Each partition proves its chunks at the lexical layers. The census tier adds all four layers per code point.
// Physical files let the normal suite sharding and worker pool distribute the census.
export function registerEncodedUnicodePartition(dialect: Dialect, position: Position, half: "first" | "second"): void {
  const { traceCommand } = useEncodedUnicodeFixture();
  const cases = codePointCases.filter(row => row.position === position && row.half === half);
  const lexicalClasses = new Map<string, number>();
  it.each(cases)("rejects every code point of chunk $chunk at the lexical layers ($position, $half half)", ({ points }) => {
    for (const point of points) {
      const { failure, key } = lexicalRejection(dialect, optionWith(point, position));
      if (failure !== null) throw new Error(`${hex(point)} ${position}: ${failure}`);
      if (!lexicalClasses.has(key)) lexicalClasses.set(key, point);
    }
  }, 300_000);

  it("has a full-pipeline representative for every lexical rejection class of its chunks", () => {
    const represented = new Set(representativeCodePoints.map((point) => lexicalRejection(dialect, optionWith(point, position)).key));
    for (const [key, point] of lexicalClasses) expect(represented.has(key), `${hex(point)}: ${key}`).toBe(true);
  });

  describe.runIf(CENSUS_TIER)("complete four-layer census", () => {
    const decisions = new Map<string, number>();
    it.each(cases)("rejects assigned separator or other code points in chunk $chunk at the $position half $half", ({ position, points, chunk, half }) => {
      for (const point of points) {
        const { failure, decision } = traceCommand(dialect, optionWith(point, position));
        if (failure !== null) throw new Error(`${hex(point)} ${position}: ${failure}`);
        if (!decisions.has(decision)) decisions.set(decision, point);
      }
      console.info(JSON.stringify({ dialect, position, half, chunk, checkedCodePoints: points.length }));
    }, 1_800_000);

    it("reaches only decisions that the representatives also reach", () => {
      const represented = new Set(representativeCodePoints.map((point) => traceCommand(dialect, optionWith(point, position)).decision));
      console.info(JSON.stringify({ dialect, position, half, censusDecisions: [...decisions.keys()].sort(), representativeDecisions: [...represented].sort() }));
      for (const [decision, point] of decisions) expect(represented.has(decision), `${hex(point)}: ${decision}`).toBe(true);
    });
  });
}

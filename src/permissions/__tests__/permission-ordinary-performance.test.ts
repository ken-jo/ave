import "../../__tests__/support/trusted-powershell.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import type { ShellRuleDialect } from "../../shared/permissions-events.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
let cwd: string;
let stateRoot: string;
let manager: PermissionManager;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "permission-ordinary-")));
  stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "permission-ordinary-state-")));
  vi.stubEnv("AVE_HOME", stateRoot);
  __resetSessionStoreForTest();
  manager = new PermissionManager(join(stateRoot, "permissions.json"));
  manager.setMode("allow");
});

afterEach(() => {
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

const PROSE_SENTENCE = "Document the configuration options and clarify the expected behavior for developers. ";
const COMMIT_SENTENCE = "Fix the bug in the new API and add tests for each edge case. Keep the old keys as they are. Add a note on how to use the new flags. ";

function prose(length: number): string {
  return PROSE_SENTENCE.repeat(Math.ceil(length / PROSE_SENTENCE.length)).slice(0, length);
}

function commitCommand(length: number): string {
  const prefix = "git commit -m '";
  return `${prefix}${COMMIT_SENTENCE.repeat(Math.ceil(length / COMMIT_SENTENCE.length)).slice(0, length - prefix.length - 1)}'`;
}

function literalCommand(length: number): string {
  const prefix = "printf '%s' '";
  return `${prefix}${prose(length - prefix.length - 1)}'`;
}

function npmCommand(length: number): string {
  let command = "npm run build -- --mode=production --sourcemap --minify";
  for (let index = 0; command.length < length; index += 1) command += ` --define:FEATURE_${index}=enabled`;
  return command.slice(0, length);
}

function heredocCommand(length: number, quoted: boolean): string {
  const prefix = `cat > ordinary.txt <<${quoted ? "'EOF'" : "EOF"}\n`;
  const suffix = "\nEOF\n";
  return `${prefix}${prose(length - prefix.length - suffix.length)}${suffix}`;
}

function pipelineCommand(length: number): { command: string; rules: string[] } {
  const prefix = "Write-Output '";
  const suffix = "' | Select-Object -First 1 | Out-String";
  const first = `${prefix}${prose(length - prefix.length - suffix.length)}'`;
  return { command: `${first} | Select-Object -First 1 | Out-String`, rules: [first, "Select-Object -First 1", "Out-String"] };
}

interface TimingCase {
  name: string;
  dialect: ShellRuleDialect;
  runsSandboxed: boolean;
  length: number;
  command: string;
  rules: string[];
  expected: "allow" | "ask";
  layer: 2 | 3 | 6;
  reasonCode: "protected-path" | "rule-allow" | "allow-mode";
}

const COMMIT_COMMAND = commitCommand(1_500);
const LITERAL_COMMAND = literalCommand(1_500);
const NPM_COMMAND = npmCommand(1_500);
const SHORT_PIPELINE = pipelineCommand(1_800);
const LONG_PIPELINE = pipelineCommand(6_500);
// Startup proof still controls rule reuse; it does not create a security floor.
const PIPELINE_LAYER = process.platform === "win32" ? 6 : 3;
const PIPELINE_REASON = process.platform === "win32" ? "allow-mode" : "rule-allow";
const TIMING_CASES: readonly TimingCase[] = [
  ...[false, true].flatMap((runsSandboxed): TimingCase[] => [
    { name: "commit-short-1500", dialect: "bash" as const, runsSandboxed, length: 1_500, command: COMMIT_COMMAND, rules: [COMMIT_COMMAND], expected: "ask" as const, layer: 2, reasonCode: "protected-path" },
    { name: "quoted-literal-1500", dialect: "bash" as const, runsSandboxed, length: 1_500, command: LITERAL_COMMAND, rules: [LITERAL_COMMAND], expected: "allow" as const, layer: 3, reasonCode: "rule-allow" },
    { name: "npm-1500", dialect: "bash" as const, runsSandboxed, length: 1_500, command: NPM_COMMAND, rules: [NPM_COMMAND], expected: "allow" as const, layer: 6, reasonCode: "allow-mode" },
    { name: "pipeline-1800", dialect: "powershell" as const, runsSandboxed, length: 1_800, ...SHORT_PIPELINE, expected: "allow", layer: PIPELINE_LAYER, reasonCode: PIPELINE_REASON },
  ]),
  { name: "heredoc-quoted-6500", dialect: "bash", runsSandboxed: true, length: 6_500, command: heredocCommand(6_500, true), rules: [], expected: "allow", layer: 6, reasonCode: "allow-mode" },
  { name: "heredoc-unquoted-6500", dialect: "bash", runsSandboxed: true, length: 6_500, command: heredocCommand(6_500, false), rules: [], expected: "allow", layer: 6, reasonCode: "allow-mode" },
  { name: "pipeline-6500", dialect: "powershell", runsSandboxed: true, length: 6_500, ...LONG_PIPELINE, expected: "allow", layer: 6, reasonCode: "allow-mode" },
];

describe("ordinary complete manager timing", () => {
  it.each(TIMING_CASES)("$name sandboxed=$runsSandboxed keeps its declared permission result", ({ name, dialect, runsSandboxed, length, command, rules, expected, layer, reasonCode }) => {
    expect(command.length).toBe(length);
    const kind = dialect === "bash" ? "Bash" : "PowerShell";
    // Only short stage rules are needed for a lane-B pipeline; no input parse or cache warmup occurs before the timer.
    manager.setRules(rules.filter((rule) => rule.length <= 2_000).map((rule) => withCurrentShellRuleVersion({ pattern: `${kind}(${rule})`, action: "allow" as const })));
    const samples: number[] = [];
    const results = [];
    for (let observation = 0; observation < 3; observation += 1) {
      const start = performance.now();
      const result = checkShellPermission(manager, cwd, SESSION_ID, command, dialect, runsSandboxed);
      samples.push(performance.now() - start);
      results.push(result);
    }
    const median = [...samples].sort((left, right) => left - right)[1]!;
    process.stdout.write(`permission ordinary timing ${JSON.stringify({ name, dialect, lane: runsSandboxed ? "A" : "B", chars: length, samples, median, results: results.map(({ decision, layer, forceModal }) => ({ decision, layer, forceModal: forceModal === true })) })}\n`);
    for (const result of results) {
      expect(result).toMatchObject({ decision: expected, layer, reasonCode });
      expect(result.forceModal === true).toBe(expected === "ask");
    }
  });
});

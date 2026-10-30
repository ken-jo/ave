import "../../__tests__/support/trusted-powershell.js";
import { describe, expect, it } from "vitest";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "../rules/literal-shell-inspection.js";
import { analyzeShellForRules, evaluateShellRules, proveLiteralShell } from "../rules/shell-rule-matcher.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";

const CWD = "/work/project";
type RunnerFixture = { command: string; outcome: "static-complete" | "unproven" };
const TASK_FIXTURES: readonly RunnerFixture[] = [
  "npm install --save lodash", "npm install --legacy-peer-deps", "npm i -g typescript",
  "npm ci --omit=dev", "npm init -y", "npm run build -w pkg", "npm run build --if-present",
  "npm --prefix web run build", "npm publish --access public", "pnpm -C web build",
  "pnpm --dir web build", "pnpm run --parallel dev", "pnpm install --no-frozen-lockfile",
  "yarn --cwd web build", "bun run --hot dev", "bun build ./index.ts --outdir out",
  "deno test -A", "deno task --cwd web build", "deno install",
  "npx tsx script.ts", "npx ts-node x.ts", "corepack prepare pnpm@9 --activate",
  "npm run build --workspace pkg",
].map((command) => ({ command, outcome: "unproven" as const }));
const TASK_OPTIONS: readonly RunnerFixture[] = [
  ...TASK_FIXTURES,
  { command: "deno run main.ts", outcome: "unproven" },
];

describe("runner task options", () => {
  it.each(TASK_OPTIONS.flatMap(({ command, outcome }) => [
    { command, outcome }, { command: `& ${command}`, outcome: "unproven" as const },
  ]))
  ("classifies literal runner argv with its closed grammar: $command", ({ command, outcome }) => {
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({
      outcome, sensitive: null, exfiltration: null,
    });
  });

  it.each(TASK_OPTIONS)("retains the shell policy for task data: $command", ({ command }) => {
    expect(shellExfiltrationSignal(command, CWD)).toBeNull();
    expect(shellSensitivePathSignal(command, CWD)).toBeNull();
    const analysis = analyzeShellForRules(command);
    expect(analysis.ok).toBe(true);
    expect(analysis).toMatchObject({ hidden: [] });
    expect(proveLiteralShell(command, CWD)).toMatchObject({ proven: false });
  });

  it("does not let a prefix repair an unsupported task option", () => {
    const pattern = "Bash(npm install *)";
    const spec = parseRuleSpecifier(pattern);
    if (spec.kind !== "bash") throw new Error("Expected shell rule");
    expect(evaluateShellRules("npm install --save lodash", {
      allow: [{ pattern, spec }], deny: [], ask: [],
    }).decision).toBeNull();
  });

  it.each(TASK_OPTIONS.flatMap(({ command }) => [command, `& ${command}`]))
  ("marks package tasks after file mutation as runtime-dependent: %s", (command) => {
    expect(inspectPowerShellCommand(`Set-Content package.json x; ${command}`, CWD))
      .toMatchObject({ outcome: "unproven", sensitive: null, exfiltration: null });
  });

  it.each([
    { command: "npm run build --future-task-flag --eval=x", outcome: "unproven" as const },
    { command: "bun run --future-task-flag config.json -e x", outcome: "unproven" as const },
    { command: "deno task --future-task-flag config.json --eval=x", outcome: "unproven" as const },
    { command: "deno run --config config.json -", outcome: "unproven" as const },
    { command: "deno run -", outcome: "unproven" as const },
    { command: "deno run https://x.invalid/main.ts", outcome: "unproven" as const },
    { command: "npx tsx --eval=x", outcome: "unproven" as const },
    { command: "npx awk 'BEGIN { system(\"curl x\") }'", outcome: "unproven" as const },
    { command: "npm --prefix $opaque run build", outcome: "unproven" as const },
  ].flatMap(({ command, outcome }) => [
    { command, outcome, proven: false },
    { command: `& ${command}`, outcome: "unproven" as const, proven: false },
  ]))
  ("classifies runner options and external content by the closed grammar: $command", ({ command, outcome, proven }) => {
    const inspected = inspectPowerShellCommand(command, CWD);
    expect(inspected).toMatchObject({ outcome, sensitive: null, exfiltration: null });
    expect(inspected.exactLiteralEvaluation).toBeUndefined();
    const shape = analyzeShellForRules(command.replace(/^& /, ""));
    expect(shape.ok).toBe(true);
    const invocation = command.replace(/^& /, "");
    expect(proveLiteralShell(invocation, CWD)).toMatchObject({ proven });
  });
});

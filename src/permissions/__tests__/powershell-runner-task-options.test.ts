import { describe, expect, it } from "vitest";
import { inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";
import { shellExfiltrationSignal, shellSensitivePathSignal } from "../rules/shell-exfiltration.js";
import { analyzeShellForRules, evaluateShellRules, proveLiteralShell } from "../rules/shell-rule-matcher.js";
import { parseRuleSpecifier } from "../rules/rule-specifier.js";

const CWD = "/work/project";
const TASK_OPTIONS = [
  "npm install --save lodash", "npm install --legacy-peer-deps", "npm i -g typescript",
  "npm ci --omit=dev", "npm init -y", "npm run build -w pkg", "npm run build --if-present",
  "npm --prefix web run build", "npm publish --access public", "pnpm -C web build",
  "pnpm --dir web build", "pnpm run --parallel dev", "pnpm install --no-frozen-lockfile",
  "yarn --cwd web build", "bun run --hot dev", "bun build ./index.ts --outdir out",
  "deno test -A", "deno task --cwd web build", "deno run main.ts", "deno install",
  "npx tsx script.ts", "npx ts-node x.ts", "corepack prepare pnpm@9 --activate",
  "npm run build --workspace pkg",
];

describe("runner task options", () => {
  it.each(TASK_OPTIONS.flatMap((command) => [command, `& ${command}`]))
  ("classifies literal runner argv without resolving call-operator grammar: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({
      outcome: command.startsWith("& ") ? "unproven" : "static-complete", sensitive: null, exfiltration: null,
    });
  });

  it.each(TASK_OPTIONS)("retains the shell policy for task data: %s", (command) => {
    expect(shellExfiltrationSignal(command, CWD)).toBeNull();
    expect(shellSensitivePathSignal(command, CWD)).toBeNull();
    const analysis = analyzeShellForRules(command);
    expect(analysis.ok).toBe(true);
    expect(analysis).toMatchObject({ hidden: [] });
    expect(proveLiteralShell(command, CWD)).toMatchObject({ proven: !/(?:npm --prefix|pnpm -C|pnpm --dir|yarn --cwd)/.test(command) });
  });

  it("lets a task prefix cover additional data options", () => {
    const pattern = "Bash(npm install *)";
    const spec = parseRuleSpecifier(pattern);
    if (spec.kind !== "bash") throw new Error("Expected shell rule");
    expect(evaluateShellRules("npm install --save lodash", {
      allow: [{ pattern, spec }], deny: [], ask: [],
    }).decision).toBe("allow");
  });

  it.each(TASK_OPTIONS.flatMap((command) => [command, `& ${command}`]))
  ("marks package tasks after file mutation as runtime-dependent: %s", (command) => {
    expect(inspectPowerShellCommand(`Set-Content package.json x; ${command}`, CWD))
      .toMatchObject({ outcome: "unproven", sensitive: null, exfiltration: null });
  });

  it.each([
    ["npm run build --future-task-flag --eval=x", "static-complete"],
    ["bun run --future-task-flag config.json -e x", "static-complete"],
    ["deno task --future-task-flag config.json --eval=x", "static-complete"],
    ["deno run --config config.json -", "static-complete"],
    ["deno run -", "static-complete"],
    ["deno run https://x.invalid/main.ts", "static-complete"],
    ["npx tsx --eval=x", "static-complete"],
    ["npx awk 'BEGIN { system(\"curl x\") }'", "static-complete"],
    ["npm --prefix $opaque run build", "unproven"],
  ].flatMap(([command, outcome]) => [[command, outcome], [`& ${command}`, outcome]] as const))
  ("classifies runner code or external content without executing it: %s", (command, outcome) => {
    const inspected = inspectPowerShellCommand(command, CWD);
    const expectedOutcome = command.startsWith("& ") ? "unproven" : outcome;
    expect(inspected).toMatchObject({ outcome: expectedOutcome, sensitive: null, exfiltration: null });
    if (expectedOutcome === "unproven" && !command.startsWith("& ") && !command.includes("$opaque")) expect(inspected.exactLiteralEvaluation).toBe(true);
    if (command.includes("$opaque")) expect(inspected.exactLiteralEvaluation).toBeUndefined();
    const shape = analyzeShellForRules(command.replace(/^& /, ""));
    expect(shape.ok).toBe(true);
    const invocation = command.replace(/^& /, "");
    expect(proveLiteralShell(invocation, CWD)).toMatchObject({ proven: !invocation.includes("$opaque") });
  });
});

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
  ("asks ordinarily for literal runner argv: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({ sensitive: null, exfiltration: null, ordinaryAsk: expect.any(String) });
  });

  it.each(TASK_OPTIONS)("retains the shell policy for task data: %s", (command) => {
    expect(shellExfiltrationSignal(command, CWD)).toBeNull();
    expect(shellSensitivePathSignal(command, CWD)).toBeNull();
    const analysis = analyzeShellForRules(command);
    expect(analysis.ok).toBe(true);
    expect(analysis).toMatchObject({ hidden: [], ordinaryAsk: "opaque runner prefix" });
    expect(proveLiteralShell(command, CWD)).toMatchObject({ proven: true });
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
  ("does not add package-task write coupling: %s", (command) => {
    expect(inspectPowerShellCommand(`Set-Content package.json x; ${command}`, CWD))
      .toEqual({ sensitive: null, exfiltration: null, ordinaryAsk: "opaque runner prefix" });
  });

  it.each([
    "npm run build --future-task-flag --eval=x", "bun run --future-task-flag config.json -e x",
    "deno task --future-task-flag config.json --eval=x", "deno run --config config.json -",
    "deno run -", "deno run https://x.invalid/main.ts", "npx tsx --eval=x",
    "npx awk 'BEGIN { system(\"curl x\") }'", "npm --prefix $opaque run build",
  ].flatMap((command) => [command, `& ${command}`]))
  ("retains ordinary asks while proving literal code and refusing variable bindings: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({ sensitive: null, exfiltration: null, ordinaryAsk: expect.any(String) });
    const shape = analyzeShellForRules(command.replace(/^& /, ""));
    expect(shape.ok).toBe(true);
    if (shape.ok) expect(shape.ordinaryAsk).toBe("opaque runner prefix");
    const invocation = command.replace(/^& /, "");
    expect(proveLiteralShell(invocation, CWD)).toMatchObject({ proven: !invocation.includes("$opaque") });
  });
});

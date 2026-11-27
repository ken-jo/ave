import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { configureHostResources } from "../../../main/host-resources.js";
import { setWindowsDriveQueryForTest } from "../../../shared/windows-drive-locality.js";
import { powerShellLiteral as literal } from "../../../__tests__/support/powershell-ast.js";
import { findPowerShellAstPathViolation } from "../../shell-tools.js";
import { shellPathPolicyViolation } from "../path-extraction.js";

vi.unmock("../../../shared/windows-drive-locality.js");

it.runIf(process.platform === "win32").each(["Bash command fields", "PowerShell AST operands"] as const)("queries each drive once across %s in one containment judgment", surface => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const root = mkdtempSync(join(tmpdir(), "command-field-locality-"));
  const query = vi.fn((_drive: string) => String.raw`\Device\HarddiskVolume1`);
  vi.stubEnv("AVE_HOME", join(root, "ave-data"));
  setWindowsDriveQueryForTest(query);
  try {
    const expectedDrives = [...new Set([root, process.cwd()].map(path => parse(path).root.slice(0, 2).toUpperCase()))];
    const violation = surface === "Bash command fields"
      ? shellPathPolicyViolation({ command: "cat ./first.txt", script: "cat ./second.txt" }, root, [], true)
      : findPowerShellAstPathViolation({
        errors: [], unsupported: [], redirections: [],
        commands: ["./first.txt", "./second.txt"].map(path => ({
          name: "Get-Content", text: `Get-Content ${path}`, arguments: [literal("Get-Content"), literal(path)],
        })),
      }, root, root, [], true);
    expect(violation).toBeNull();
    expect(query.mock.calls.map(([drive]) => drive).sort()).toEqual(expectedDrives.sort());
  } finally {
    setWindowsDriveQueryForTest();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

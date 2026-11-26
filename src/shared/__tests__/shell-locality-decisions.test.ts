// windows-permission
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectShellCommand } from "../../permissions/rules/literal-shell-inspection.js";
import { inspectPowerShellCommand, parsePowerShellCommand } from "../../permissions/rules/powershell-exfiltration.js";
import { parseShellCommand } from "../../permissions/rules/shell-prefix-policy.js";
import { setWindowsDriveQueryForTest } from "../windows-drive-locality.js";

const realpaths = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    realpathSync: Object.assign((...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args), {
      native: (path: string) => realpaths.get(path.toLowerCase()) ?? fs.realpathSync.native(path),
    }),
  };
});

vi.unmock("../windows-drive-locality.js");

describe.runIf(process.platform === "win32")("shell locality decisions", () => {
  let root: string;
  let drive: string;
  let remappedDrive: string | undefined;
  const queries: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shell-locality-"));
    drive = root.slice(0, 2).toUpperCase();
    const home = join(root, "ave-data");
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
    remappedDrive = undefined;
    realpaths.clear();
    queries.length = 0;
    setWindowsDriveQueryForTest(letter => {
      queries.push(letter);
      return letter === remappedDrive ? "\\??\\UNC\\host.example\\share" : "\\Device\\HarddiskVolume1";
    });
  });

  afterEach(() => {
    setWindowsDriveQueryForTest();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["bash", "powershell"] as const)("rechecks a reused %s parse after a drive remap", async dialect => {
    const aliasDrive = drive === "K:" ? "R:" : "K:";
    const aliasHome = aliasDrive + "\\ave-data";
    vi.stubEnv("AVE_HOME", aliasHome);
    realpaths.set((aliasDrive + "\\").toLowerCase(), root);
    realpaths.set(aliasHome.toLowerCase(), join(root, "ave-data"));
    const path = "./ave-data/secrets/notes.txt";
    const command = dialect === "bash" ? "cat " + path : "Get-Content " + path;
    const bash = parseShellCommand(command);
    const powershell = parsePowerShellCommand(command);
    const inspect = () => dialect === "bash" ? inspectShellCommand(bash, root) : inspectPowerShellCommand(powershell, root);

    expect(inspect().sensitive).toBe("ave-home:secrets");
    await Promise.resolve();
    remappedDrive = aliasDrive;
    queries.length = 0;

    expect(inspect().sensitive).toBeNull();
    expect(queries).toContain(aliasDrive);
  });
});

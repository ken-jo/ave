import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { rankAdmittedMxcLists } from "../../__tests__/support/mxc-policy-rows.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { buildMxcShellRequest, mxcRequestArgs, powerShellMxcCommandLine, resolveHostWxcExecPath, type MxcFilesystemGrants } from "../mxc-windows.js";
import { listWatchedQuarantine, resetWatchedRows, WATCHED_ROW_VIOLATION, watchMxcProtectedRows } from "../windows-watched-rows.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetWatchedRows();
});

const WAIT_MS = 60_000;

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}

function waitScript(name: string): string {
  return `$deadline = (Get-Date).AddSeconds(${WAIT_MS / 1000}); while (-not (Test-Path ${name})) { if ((Get-Date) -gt $deadline) { exit 3 }; Start-Sleep -Milliseconds 100 }`;
}

function launch(launcher: string, cwd: string, grants: MxcFilesystemGrants, script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) throw new Error("SystemRoot is not set");
  const request = buildMxcShellRequest({ commandLine: powerShellMxcCommandLine(systemRoot, script), cwd, grants,
    env: { SYSTEMROOT: systemRoot, LOCALAPPDATA: cwd }, proxyUrl: "http://127.0.0.1:9", timeoutMs: TOOL_TIMEOUT_POLICY.shellDefaultMs });
  return new Promise((resolveResult, reject) => {
    execFile(launcher, mxcRequestArgs(request, launcher), { cwd: win32.dirname(launcher), windowsHide: true,
      timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolveResult({ code: error?.code as number | undefined ?? 0, stdout, stderr });
    });
  });
}

describe.skipIf(process.platform !== "win32")("native watched row renamed while another container lives", () => {
  it("keeps a second container's read-only rule on a protected child after the first container's sweep moves it", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    await requireMxcCapability(context.skip);
    const launcher = await resolveHostWxcExecPath();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "example-mxc-rename-")));
    const home = join(directory, "alice");
    const project = join(directory, "project");
    mkdirSync(home);
    mkdirSync(project);
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([home]);
    vi.stubEnv("AVE_HOME", home);
    const agents = join(project, ".agents");
    const commands = join(project, ".ave", "commands");
    const hooks = join(project, ".ave", "hooks");
    const required = [agents, commands, hooks];
    const lists = { allowWrite: [project], allowRead: [], denyRead: [], denyWrite: required, requiredWriteDenies: required,
      carrierChildWriteDenies: [commands, hooks], protectedFloor: [] };
    try {
      const grantsA = rankAdmittedMxcLists(lists);
      expect(grantsA.watched).toEqual([commands, hooks]);
      expect(grantsA.denied).toContain(agents);
      const sweepA = watchMxcProtectedRows(grantsA.watched ?? [], { commandId: "container-a" });
      const containerA = launch(launcher, project, grantsA, [
        '$ErrorActionPreference = "Stop"',
        "New-Item -ItemType Directory .ave | Out-Null",
        "New-Item -ItemType Directory .ave/commands | Out-Null",
        "Set-Content a-created.txt done",
        waitScript("a-go.txt"),
        "exit 0",
      ].join("; "));
      await waitFor(join(project, "a-created.txt"));
      expect(existsSync(commands)).toBe(true);

      const grantsB = rankAdmittedMxcLists(lists);
      expect(grantsB.readonly).toContain(commands);
      expect(grantsB.denied).toEqual(expect.arrayContaining([agents, hooks]));
      expect(grantsB.watched).toBeUndefined();
      const probe = (name: string, action: string) =>
        `try { ${action} | Out-Null; Add-Content b-log.txt "${name}=allowed" } catch { Add-Content b-log.txt "${name}=denied" }`;
      const containerB = launch(launcher, project, grantsB, [
        '$ErrorActionPreference = "Stop"',
        probe("before-inside", "Set-Content .ave/commands/b-before.txt x"),
        probe("before-ordinary", "Set-Content b-ordinary-before.txt x"),
        "Set-Content b-ready.txt done",
        waitScript("b-go.txt"),
        probe("after-create", "New-Item -ItemType Directory .ave/commands"),
        probe("after-inside", "Set-Content .ave/commands/b-after.txt x"),
        probe("after-ordinary", "Set-Content b-ordinary-after.txt x"),
        probe("after-carrier-sibling", "Set-Content .ave/b-sibling.txt x"),
        "exit 0",
      ].join("; "));
      await waitFor(join(project, "b-ready.txt"));

      writeFileSync(join(project, "a-go.txt"), "");
      const resultA = await containerA;
      expect(resultA.code, JSON.stringify(resultA)).toBe(0);
      const notice = await sweepA();
      const swept = !existsSync(commands);
      const quarantined = listWatchedQuarantine().map(entry => entry.original);

      writeFileSync(join(project, "b-go.txt"), "");
      const resultB = await containerB;
      expect(resultB.code, JSON.stringify(resultB)).toBe(0);
      const log = Object.fromEntries(readFileSync(join(project, "b-log.txt"), "utf8").trim().split(/\r?\n/).map(line => line.split("=")));
      const recreated = existsSync(commands);
      console.info(`MXC watched rename evidence ${JSON.stringify({ sweptByA: swept, notice: notice?.includes(WATCHED_ROW_VIOLATION) ?? false,
        quarantined: quarantined.map(path => win32.relative(project, path)), probesInB: log, recreatedAfterB: recreated })}`);

      expect(log["before-inside"]).toBe("denied");
      expect(log["before-ordinary"]).toBe("allowed");
      expect(log["after-ordinary"]).toBe("allowed");
      expect(log["after-carrier-sibling"]).toBe("allowed");
      expect(swept).toBe(true);
      expect(quarantined).toEqual([commands]);
      expect(notice).toContain(WATCHED_ROW_VIOLATION);
      // B's read-only rule holds the name, not the moved object: B cannot recreate the child or write into it.
      expect(log["after-create"]).toBe("denied");
      expect(log["after-inside"]).toBe("denied");
      expect(recreated).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, TOOL_TIMEOUT_POLICY.shellDefaultMs * 3 + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
});

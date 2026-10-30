import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { quotePowerShell } from "../../__tests__/support/powershell-literal.js";
import { configureHostResources } from "../../main/host-resources.js";
import { win32SystemBinary, windowsSystemRoot } from "../../shared/windows-system-path.js";
import { ensureAveHomePrivate } from "../../shared/ave-home.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { prepareMxcShellLaunch } from "../../tools/mxc-shell-launch.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { powerShellMxcCommandLine } from "../mxc-windows.js";
import { buildMandatorySandboxWritePolicy } from "../sandbox-write-policy.js";
import * as policyHome from "../../shared/policy-home.js";

// Exercise native filesystem policy directly so argument analysis cannot cause the refusal.
describe.runIf(process.platform === "win32")("container control-file write boundary", () => {
  it("blocks opaque control writes and permits ordinary repository commits", {
    timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs,
  }, async (testContext) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    await requireMxcCapability(testContext.skip);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-control-mxc-")));
    const project = join(root, "project");
    const configuration = join(root, "ave", "config");
    mkdirSync(project);
    vi.stubEnv("AVE_HOME", join(root, "ave"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([root]);
    try {
      expect(ensureAveHomePrivate(join(root, "ave")).enforcement).toBe("win32-dacl");
      const git = execFileSync(win32SystemBinary("where.exe"), ["git.exe"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]!;
      const gitRoot = dirname(dirname(git));
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(project, "git-global"), GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_ATTR_NOSYSTEM: "1", XDG_CONFIG_HOME: join(project, "git-xdg") };
      execFileSync(git, ["init", "--quiet", project], { env: gitEnv });
      execFileSync(git, ["-C", project, "config", "user.name", "Sandbox Fixture"], { env: gitEnv });
      execFileSync(git, ["-C", project, "config", "user.email", "fixture.invalid"], { env: gitEnv });
      mkdirSync(configuration, { recursive: true, mode: 0o700 });
      await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
      const targets = [join(project, ".git", "config"), join(project, ".git", "hooks", "pre-commit"),
        join(project, ".bash_profile"), join(configuration, "future-control.json")];
      for (const target of targets) if (!existsSync(target)) writeFileSync(target, "original");
      async function run(command: string, target: string): Promise<{ status: number | null; output: string }> {
        const invocation = openEgressInvocation({ kind: "shell", toolName: "powershell", toolUseId: undefined,
          context: { sessionId: undefined, workspaceRoot: project, approvalSurface: "unavailable" } });
        const policy = buildMandatorySandboxWritePolicy([project, configuration]);
        let launch: Awaited<ReturnType<typeof prepareMxcShellLaunch>> | undefined;
        try {
          launch = await prepareMxcShellLaunch({
          egressToken: invocation.token, commandLine: powerShellMxcCommandLine(windowsSystemRoot(), command), cwd: project,
          filesystem: { allowRead: [windowsSystemRoot(), gitRoot, project, configuration], allowWrite: policy.allowWrite,
            denyRead: [], denyWrite: policy.denyWrite.map(entry => typeof entry === "string" ? entry : entry.path) },
          env: Object.fromEntries(Object.entries({ ...gitEnv, CONTROL_TARGET: target }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          timeoutMs: TOOL_TIMEOUT_POLICY.shellDefaultMs, exists: existsSync,
          });
          const prepared = launch;
          return await new Promise<{ status: number | null; output: string }>((resolveRun, reject) => {
            const child = spawn(prepared.argv[0]!, prepared.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            prepared.bindChild(child);
            let output = "";
            child.stdout?.on("data", chunk => { output += String(chunk); });
            child.stderr?.on("data", chunk => { output += String(chunk); });
            child.once("error", reject);
            child.once("close", status => resolveRun({ status, output }));
          });
        } finally {
          await launch?.release();
          invocation.release();
        }
      }
      for (const target of targets) {
        const original = readFileSync(target, "utf8");
        const result = await run('$ErrorActionPreference="Stop"; [IO.File]::AppendAllText($env:CONTROL_TARGET,"changed")', target);
        expect(result.status, result.output).not.toBeNull();
        expect(result.status, result.output).not.toBe(0);
        expect(readFileSync(target, "utf8")).toBe(original);
      }
      const ordinary = join(project, "opaque-result.txt");
      const ordinaryResult = await run('$ErrorActionPreference="Stop"; [IO.File]::AppendAllText($env:CONTROL_TARGET,"changed")', ordinary);
      expect(ordinaryResult.status, ordinaryResult.output).toBe(0);
      expect(readFileSync(ordinary, "utf8")).toBe("changed");
      rmSync(join(project, ".git", "hooks", "pre-commit"));
      writeFileSync(join(project, "tracked.txt"), "checkpoint");
      const result = await run(`& ${quotePowerShell(git)} -c ${quotePowerShell("safe.directory=" + project)} add tracked.txt; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & ${quotePowerShell(git)} -c ${quotePowerShell("safe.directory=" + project)} -c commit.gpgSign=false commit --quiet -m checkpoint; exit $LASTEXITCODE`, "");
      expect(result.status, result.output).toBe(0);
      expect(execFileSync(git, ["-C", project, "log", "-1", "--format=%s"], { encoding: "utf8", env: gitEnv }).trim()).toBe("checkpoint");
      expect(existsSync(join(project, ".git", "index"))).toBe(true);
    } finally {
      await resetAsrtSandbox();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

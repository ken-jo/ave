import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { configureHostResources } from "../../main/host-resources.js";
import { getDefaultSensitiveWriteDenyPaths, getProtectedReadDenyFloor, initializeAsrtSandbox, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";
import { openEgressInvocation } from "../../permissions/egress-invocations.js";
import * as policyHome from "../../shared/policy-home.js";
import { resolveTrustedPowerShellExecutable } from "../../shared/powershell-executable.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { prepareMxcShellLaunch } from "../mxc-shell-launch.js";

describe.runIf(process.platform === "win32")("native pipe policy lifetime", () => {
  it("keeps a pipe-launched command alive beyond the delivery deadline", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    await requireMxcCapability(context.skip);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "example-mxc-lifetime-")));
    const home = join(directory, "example" + "x".repeat(125));
    mkdirSync(home);
    const readonly = Array.from({ length: 100 }, (_, index) => join(home, `example-${index}`));
    for (const path of readonly) mkdirSync(path);
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([home]);
    let launch: Awaited<ReturnType<typeof prepareMxcShellLaunch>> | undefined;
    let egress: ReturnType<typeof openEgressInvocation> | undefined;
    try {
      await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
      egress = openEgressInvocation({ kind: "shell", toolName: "powershell", toolUseId: undefined,
        context: { sessionId: undefined, workspaceRoot: directory, approvalSurface: "unavailable" } });
      const executable = resolveTrustedPowerShellExecutable()!.executable;
      launch = await prepareMxcShellLaunch({
        egressToken: egress.token, cwd: directory,
        commandLine: `"${executable}" -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 20; Write-Output done"`,
        filesystem: { allowWrite: [directory], allowRead: [home, ...readonly], denyRead: getProtectedReadDenyFloor(), denyWrite: getDefaultSensitiveWriteDenyPaths() },
        env: { SYSTEMROOT: process.env.SystemRoot!, LOCALAPPDATA: directory, HOME: home, USERPROFILE: home },
        timeoutMs: TOOL_TIMEOUT_POLICY.shellDefaultMs, exists: existsSync,
      });
      expect(launch.argv[1]).toBe("--config");
      expect(launch.argv[2]).toMatch(/^\\\\\.\\pipe\\ave-mxc-[a-f0-9]{32}$/);
      const started = performance.now();
      const result = await new Promise<{ stdout: string; stderr: string }>((resolveRun, reject) => {
        const child = execFile(launch!.argv[0]!, [...launch!.argv.slice(1)], {
          cwd: win32.dirname(launch!.argv[0]!), windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
        }, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolveRun({ stdout, stderr });
        });
        launch!.bindChild(child);
      });
      expect(performance.now() - started).toBeGreaterThan(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
      expect(result.stdout).toMatch(/\bdone\b/);
    } finally {
      await launch?.release();
      egress?.release();
      await resetAsrtSandbox();
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  }, TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
});

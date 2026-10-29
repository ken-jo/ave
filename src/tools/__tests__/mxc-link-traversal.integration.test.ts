import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { quotePowerShell } from "../../__tests__/support/powershell-literal.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate } from "../../permissions/sandbox-capability.js";
import { resolveTrustedPowerShellExecutable } from "../../shared/powershell-executable.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import { BashTool, PowerShellTool } from "../shell-tools.js";

// A link inside a granted cwd must not expose a credential-floor target to recursive or direct reads.
describe.runIf(process.platform === "win32")("MXC link traversal into a denied path", () => {
  it.for(["junction", "dir"] as const)("blocks reads through a %s link", { timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs }, async (linkType, testContext) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-mxc-link-")));
    const secret = `AVE-T6-SECRET-${randomUUID()}`;
    const plain = `AVE-T6-PLAIN-${randomUUID()}`;
    const secrets = [secret, plain];
    const control = `AVE-T6-CONTROL-${randomUUID()}`;
    const ssh = join(directory, "policy-home", ".ssh");
    const clean = join(directory, "clean");
    const linked = join(clean, "linked");
    mkdirSync(ssh, { recursive: true });
    mkdirSync(clean);
    writeFileSync(join(ssh, "id_rsa"), `${secret}\n`);
    // A plain name isolates the container's link handling from the host's credential-name match.
    writeFileSync(join(ssh, "notes.txt"), `${plain}\n`);
    writeFileSync(join(clean, "control.txt"), `${control}\n`);
    try {
      try {
        symlinkSync(ssh, linked, linkType);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (linkType === "dir" && code === "EPERM") testContext.skip(`Directory symlink needs elevation or Developer Mode: ${code}`);
        throw error;
      }
      const started = await requireMxcCapability(testContext.skip);
      // Anchor the credential floor to a fixture home: the stamp guard refuses real-account deny targets.
      vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([join(directory, "policy-home")]);
      await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
      const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: false,
        mxc: { state: "available" }, windowsBuild: started.windowsBuild, srtWinReady: false });
      setWindowsSandboxSubstrate(substrate, mxcShellCapability());
      setActiveSandboxCapability(windowsProxyOnlyCapability(substrate));
      setShellSandboxRequestedAtBoot(true);
      const context = { cwd: directory, extraAllowedDirectories: [], metadata: {}, blockReadsOutsideWorkingDirectories: true,
        hostShellExecutionPlan: getHostShellExecutionPlan() };
      expect(context.hostShellExecutionPlan.mode).toBe("asrt");
      const timeoutSeconds = TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000;
      const listing = `Get-ChildItem -LiteralPath ${quotePowerShell(clean)}`;
      const pipeRead = `${listing} | Get-ChildItem -File | Get-Content`;
      // Unsandboxed baseline: piping each item back into Get-ChildItem follows the link (PS 5.1 -Recurse/-Depth do not).
      const powershell = resolveTrustedPowerShellExecutable()!.executable;
      const baseline = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", pipeRead], { encoding: "utf8" });
      console.info("MXC link evidence " + JSON.stringify({ link: linkType, case: "baseline-unsandboxed", exitCode: baseline.status,
        leaked: secrets.every((value) => baseline.stdout.includes(value)), controlVisible: baseline.stdout.includes(control) }));
      expect(secrets.every((value) => baseline.stdout.includes(value)), baseline.stdout + baseline.stderr).toBe(true);
      // "host": refused before launch; "container": runs in MXC, which must withhold the target.
      const cases = [
        { name: "recurse-get-content", layer: "host", command: `${listing} -Recurse -File | Get-Content`, refusal: /recursive shell filesystem traversal/ },
        { name: "depth-prefix-get-content", layer: "host", command: `${listing} -Dep 3 -File | Get-Content`, refusal: /recursive shell filesystem traversal/ },
        { name: "recurse-select-string",layer: "host", command: `${listing} -Recurse -File | Select-String -Pattern 'AVE-T6-'`, refusal: /recursive shell filesystem traversal/ },
        { name: "direct-plain-name", layer: "host", command: `Get-Content -LiteralPath ${quotePowerShell(join(linked, "notes.txt"))}`, refusal: /Sensitive path: .*\.ssh/ },
        { name: "direct-id-rsa", layer: "host", command: `Get-Content -LiteralPath ${quotePowerShell(join(linked, "id_rsa"))}`, refusal: /Sensitive path: .*\.ssh/ },
        { name: "pipe-get-content", layer: "container", command: pipeRead },
        { name: "pipe-select-string", layer: "container", command: `${listing} | Get-ChildItem -File | Select-String -Pattern 'AVE-T6-'` },
      ];
      for (const { name, layer, command, refusal } of cases) {
        const result = await new PowerShellTool().execute({ command, timeoutSeconds }, context);
        const leaked = secrets.some((value) => result.output.includes(value));
        const denial = result.output.split(/\r?\n/).filter((line) => /denied|linked/i.test(line)).join(" | ").slice(0, 400);
        console.info("MXC link evidence " + JSON.stringify({ link: linkType, case: name, layer, exitCode: result.metadata?.returncode ?? null,
          isError: result.isError, sandboxed: result.metadata?.sandboxed ?? null, leaked, controlVisible: result.output.includes(control),
          error: result.isError ? result.output.slice(0, 400) : denial }));
        expect(leaked, result.output).toBe(false);
        if (refusal) {
          expect(result.isError, result.output).toBe(true);
          expect(result.output).toMatch(refusal);
        } else {
          expect(result.metadata?.sandboxed, result.output).toBe(true);
          expect(result.output, "control file must be readable").toContain(control);
          // The container refuses the link itself (localized access-denied error naming it).
          expect(result.isError, result.output).toBe(true);
          expect(result.output).toContain(linked);
        }
      }
      const bash = await new BashTool().execute({ command: `cat ${quotePowerShell(join(linked, "id_rsa"))}`, timeoutSeconds }, context);
      const bashLeaked = secrets.some((value) => bash.output.includes(value));
      console.info("MXC link evidence " + JSON.stringify({ link: linkType, case: "bash-direct", layer: "host", exitCode: bash.metadata?.returncode ?? null,
        isError: bash.isError, sandboxed: bash.metadata?.sandboxed ?? null, leaked: bashLeaked, error: bash.output.slice(0, 400) }));
      expect(bashLeaked).toBe(false);
      expect(bash.isError).toBe(true);
      expect(bash.output).toMatch(/Sensitive path: .*id_rsa/);
    } finally {
      await resetAsrtSandbox();
      vi.restoreAllMocks();
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetWindowsSandboxSubstrateForTest();
      // Remove the link itself first so cleanup never walks into its target.
      try { unlinkSync(linked); } catch { try { rmSync(linked); } catch { /* absent */ } }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

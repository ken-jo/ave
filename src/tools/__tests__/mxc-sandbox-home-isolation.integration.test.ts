import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { quotePowerShell } from "../../__tests__/support/powershell-literal.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { configureHostResources } from "../../main/host-resources.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";
import { baseAllowedDirectories } from "../../permissions/base-allowed-directories.js";
import { establishMxcRuntimeRoot, mxcRuntimeRootFloorPath, mxcStagingParent } from "../../permissions/mxc-runtime-root.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate } from "../../permissions/sandbox-capability.js";
import { _resolveHostOwnerMarkerForTest, createSandboxProcessHome, SANDBOX_HOME_OWNER_SUFFIX } from "../../permissions/sandbox-process-home.js";
import { readWindowsProcessRunStates } from "../../permissions/windows-process-start-time.js";
import * as policyHome from "../../shared/policy-home.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { PowerShellTool } from "../shell-tools.js";

const ATTACKS = ["home-parent-list", "sibling-list", "sibling-read", "sibling-create", "sibling-tmp-read", "sibling-tmp-create",
  "temp-root-list", "temp-root-read", "temp-root-create", "owner-read", "owner-forge", "owner-plant", "owner-delete",
  "staging-list", "staging-create"] as const;
const CONTROLS = ["own-home-write", "own-temp-write", "cwd-write"] as const;

// One probe per line, `<name>=ok` or `<name>=denied`. The sibling is found the way a confined shell would find it: beside its own HOME. The probes are lines piped to cmd.exe, because the shell's argument analysis refuses a composed path before launch and the container is what is under test.
function probeScript(input: { siblingName: string; tempRoot: string; nonce: string }): string {
  const cmd = (line: string): string => line;
  const attempt = (name: string, body: string): string => cmd(`${body} >nul 2>&1 && echo ${name}=ok || echo ${name}=denied`);
  const write = (path: string): string => `copy /y NUL ${path}`;
  const sibling = `%USERPROFILE%\\..\\${input.siblingName}`;
  const marker = `${sibling}${SANDBOX_HOME_OWNER_SUFFIX}`;
  const lines = [
    cmd("echo own-home-path=%USERPROFILE%"),
    cmd("echo own-temp-path=%TEMP%"),
    attempt("home-parent-list", "dir /b %USERPROFILE%\\.."),
    attempt("sibling-list", `dir /b ${sibling}`),
    attempt("sibling-read", `type ${sibling}\\secret.txt`),
    attempt("sibling-create", write(`${sibling}\\planted.txt`)),
    attempt("sibling-tmp-read", `type ${sibling}\\tmp\\secret.txt`),
    attempt("sibling-tmp-create", write(`${sibling}\\tmp\\planted.txt`)),
    attempt("temp-root-list", `dir /b ${input.tempRoot}`),
    attempt("temp-root-read", `type ${input.tempRoot}\\g1-host-${input.nonce}.txt`),
    attempt("temp-root-create", write(`${input.tempRoot}\\g1-planted-${input.nonce}.txt`)),
    attempt("owner-read", `type ${marker}`),
    attempt("owner-forge", write(marker)),
    attempt("owner-plant", write(`%USERPROFILE%\\..\\ave-sandbox-home-g1${input.nonce}${SANDBOX_HOME_OWNER_SUFFIX}`)),
    // del sets no error level; it prints a line only when it fails.
    cmd(`del /f /q ${marker} 2>&1 | findstr /r "." >nul && echo owner-delete=denied || echo owner-delete=ok`),
    attempt("staging-list", "dir /b %USERPROFILE%\\..\\..\\staging"),
    attempt("staging-create", write(`%USERPROFILE%\\..\\..\\staging\\g1-planted-${input.nonce}.txt`)),
    attempt("own-home-write", `${write("%USERPROFILE%\\own.txt")} && type %USERPROFILE%\\own.txt`),
    attempt("own-temp-write", `${write("%TEMP%\\own.txt")} && type %TEMP%\\own.txt`),
    attempt("cwd-write", `${write("cwd.txt")} && type cwd.txt`),
  ];
  return `@(${lines.map(quotePowerShell).join(", ")}) | cmd.exe`;
}

// A confined shell must not reach another confined process's HOME, its temp directory, its owner marker, or the host temp root.
describe.runIf(process.platform === "win32")("container shell and sibling sandbox HOMEs", () => {
  it.for([
    { name: "the per-turn base directories", grantsBase: true },
    { name: "no additional directory", grantsBase: false },
    // The working directory's grant covers the runtime root's parent: the root's own access is what keeps a sibling closed.
    { name: "a working directory above the runtime root", grantsBase: false, aboveRoot: true },
    // Directories inside the runtime root named as additional directories: none of them is granted.
    { name: "the runtime root, the HOME parent, a sibling HOME and staging as additional directories", grantsBase: false, grantsFloor: true },
  ])("keeps a sibling HOME and the host temp root closed with $name", { timeout: 2 * TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs }, async ({ grantsBase, aboveRoot, grantsFloor }, testContext) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const tempRoot = realpathSync.native(tmpdir());
    const directory = aboveRoot === true
      ? realpathSync.native(resolve(mxcRuntimeRootFloorPath(), "..", "..", ".."))
      : realpathSync.native(mkdtempSync(join(tempRoot, "ave-g1-ws-")));
    const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
    const secret = `AVE-G1-SECRET-${randomUUID()}`;
    const hostFile = join(tempRoot, `g1-host-${nonce}.txt`);
    const planted: string[] = [join(tempRoot, `g1-planted-${nonce}.txt`)];
    let sibling: ReturnType<typeof createSandboxProcessHome> | undefined;
    try {
      const started = await requireMxcCapability(testContext.skip);
      vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([join(directory, "policy-home")]);
      establishMxcRuntimeRoot();
      await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } }, async () => false);
      const { substrate } = planWindowsSandbox({ shellRequested: true, shellLocalNetworkAccess: true, workerRequested: false,
        mxc: { state: "available" }, windowsBuild: started.windowsBuild, srtWinReady: false });
      setWindowsSandboxSubstrate(substrate, mxcShellCapability());
      setActiveSandboxCapability(windowsProxyOnlyCapability(substrate));
      setShellSandboxRequestedAtBoot(true);
      // The marker is written with the HOME once the host's start time is known.
      expect(await _resolveHostOwnerMarkerForTest(readWindowsProcessRunStates)).not.toBeNull();
      sibling = createSandboxProcessHome();
      const marker = `${sibling.path}${SANDBOX_HOME_OWNER_SUFFIX}`;
      const markerText = readFileSync(marker, "utf8");
      const siblingTemp = sibling.env.TEMP ?? "";
      writeFileSync(join(sibling.path, "secret.txt"), secret);
      writeFileSync(join(siblingTemp, "secret.txt"), secret);
      writeFileSync(hostFile, secret);
      const staging = mxcStagingParent("win32");
      const floor = grantsFloor === true ? [dirname(staging), dirname(sibling.path), sibling.path, staging] : [];
      planted.push(join(staging, `g1-planted-${nonce}.txt`), join(sibling.path, "planted.txt"), join(siblingTemp, "planted.txt"),
        join(dirname(sibling.path), `ave-sandbox-home-g1${nonce}${SANDBOX_HOME_OWNER_SUFFIX}`));
      // What `getTurnAdditionalDirectories` hands every tool when the user added no directory.
      const context = { cwd: directory, extraAllowedDirectories: [...(grantsBase ? baseAllowedDirectories() : []), ...floor], metadata: {},
        blockReadsOutsideWorkingDirectories: false, hostShellExecutionPlan: getHostShellExecutionPlan() };
      expect(context.hostShellExecutionPlan.mode).toBe("asrt");
      const result = await new PowerShellTool().execute({
        command: probeScript({ siblingName: basename(sibling.path), tempRoot, nonce }),
        timeoutSeconds: TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000,
      }, context);
      expect(result.metadata?.sandboxed, result.output).toBe(true);
      const lines = new Map(result.output.split(/\r?\n/).flatMap((line): [string, string][] => {
        // cmd.exe also echoes each line it read, behind its prompt.
        const at = line.indexOf("=");
        return at > 0 && /^[a-z-]+$/.test(line.slice(0, at)) ? [[line.slice(0, at), line.slice(at + 1).trim()]] : [];
      }));
      const hostConfirmed = {
        planted: planted.filter((path) => existsSync(path)).map((path) => basename(path)),
        markerIntact: existsSync(marker) && readFileSync(marker, "utf8") === markerText,
      };
      console.info(`G1 evidence ${JSON.stringify({ grantsBase, aboveRoot: aboveRoot === true, grantsFloor: grantsFloor === true, probes: Object.fromEntries(lines), hostConfirmed })}`);
      expect(result.output).not.toContain(secret);
      // The shell's HOME is a sibling of the other process's, and its temp directory lies inside its own HOME.
      const ownHome = lines.get("own-home-path") ?? "";
      expect(dirname(ownHome).toLowerCase()).toBe(dirname(sibling.path).toLowerCase());
      expect((lines.get("own-temp-path") ?? "").toLowerCase().startsWith(`${ownHome.toLowerCase()}\\`)).toBe(true);
      for (const control of CONTROLS) expect(lines.get(control), `${control}\n${result.output}`).toBe("ok");
      expect(existsSync(join(directory, "cwd.txt"))).toBe(true);
      for (const attack of ATTACKS) expect.soft(lines.get(attack), attack).toBe("denied");
      expect.soft(hostConfirmed.planted).toEqual([]);
      expect.soft(hostConfirmed.markerIntact).toBe(true);
    } finally {
      await resetAsrtSandbox();
      vi.restoreAllMocks();
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetWindowsSandboxSubstrateForTest();
      sibling?.cleanup();
      if (sibling !== undefined) rmSync(`${sibling.path}${SANDBOX_HOME_OWNER_SUFFIX}`, { force: true });
      for (const path of [...planted, hostFile]) rmSync(path, { force: true });
      if (aboveRoot === true) rmSync(join(directory, "cwd.txt"), { force: true });
      else rmSync(directory, { recursive: true, force: true });
    }
  });
});

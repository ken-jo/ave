import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ helper: undefined as ChildProcess | undefined, members: "", spawns: [] as string[][], refuseHold: false, unqueryable: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
      boundary.spawns.push([String(args[0]), ...argv]);
      if (String(args[0]).endsWith("ave-job.exe") && argv[0] === "--hold") {
        // A helper gone just before the launch refuses the launcher its hold.
        if (boundary.refuseHold) actual.execFileSync("taskkill", ["/PID", String(boundary.helper?.pid), "/F"], { stdio: "ignore", windowsHide: true });
        // This launcher cannot read its own job, so it can never confirm the run stopped.
        if (boundary.unqueryable) args[0] = String(args[0]).replace(/ave-job\.exe$/u, "ave-job-query-failure.exe");
      }
      if (!String(args[0]).endsWith("ave-path-kind.exe") || !(args[1] as string[]).includes("--hold")) return actual.spawn(...args);
      const fixture = String(args[0]).replace(/ave-path-kind\.exe$/u, "ave-path-kind-hold-fixture.exe");
      const helper = actual.spawn(fixture, args[1] as string[], { ...(args[2] as object), stdio: ["pipe", "pipe", "pipe", "pipe"] });
      helper.stderr?.on("data", (chunk: Buffer) => { boundary.members += chunk.toString(); });
      boundary.helper = helper;
      return helper;
    }),
  };
});

import { buildHostShellExecutionPermitBinding, mintHostShellExecutionPermit, recordHostShellPolicyAuthorization } from "../../permissions/host-shell-execution-permit.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate } from "../../permissions/sandbox-capability.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import { PowerShellTool } from "../shell-tools.js";
import { t } from "../../i18n/index.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";

const FIXTURE = resolve("resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
const UNQUERYABLE_LAUNCHER = resolve("resources", "windows-job", process.arch, "ave-job-query-failure.exe");

async function approvedPowerShell(directory: string, command: string, timeoutSeconds = 60) {
  const plan = getHostShellExecutionPlan();
  const input = { command, timeoutSeconds };
  const binding = buildHostShellExecutionPermitBinding({
    plan, toolName: "powershell", toolUseId: "hold-wrapper", rawInput: input, executionCwd: directory, extraAllowedDirectories: [],
  });
  if (binding === undefined) throw new Error("no permit binding for the container plan");
  recordHostShellPolicyAuthorization(binding, undefined);
  const permit = mintHostShellExecutionPermit({ plan, binding, answer: undefined });
  expect(permit).toBeDefined();
  return { input, context: { cwd: directory, extraAllowedDirectories: [], metadata: { toolUseId: "hold-wrapper" }, blockReadsOutsideWorkingDirectories: true,
    hostShellExecutionPlan: plan, hostShellExecutionPermit: permit } };
}

const members = async (): Promise<number[]> => {
  boundary.members = "";
  boundary.helper?.stdin?.write("L");
  await vi.waitFor(() => expect(boundary.members).toContain("\n"));
  return JSON.parse(boundary.members.trim().split("\n").at(-1) ?? "[]") as number[];
};
const processNames = (pids: readonly number[]) => pids.map((pid) => {
  const row = execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"), ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`], { encoding: "utf8", windowsHide: true });
  return { pid, name: /^"([^"]+)"/u.exec(row.trim())?.[1]?.toLowerCase() ?? "" };
});
const evidence = (label: string, value: unknown) => {
  const file = process.env.AVE_TEST_HOLD_EVIDENCE;
  if (file !== undefined) appendFileSync(file, `${label} ${JSON.stringify(value)}
`);
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

describe.runIf(process.platform === "win32")("held working directory under the container route", () => {
  let directory: string | undefined;
  afterEach(async () => {
    await resetAsrtSandbox();
    vi.restoreAllMocks();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
    boundary.helper = undefined;
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  const containerRoute = async (skip: () => never): Promise<string> => {
    if (!existsSync(FIXTURE)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-hold-mxc-")));
    directory = root;
    const started = await requireMxcCapability(skip);
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([join(root, "policy-home")]);
    await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } }, async () => false);
    const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: false,
      mxc: { state: "available" }, windowsBuild: started.windowsBuild, srtWinReady: false });
    setWindowsSandboxSubstrate(substrate, mxcShellCapability());
    setActiveSandboxCapability(windowsProxyOnlyCapability(substrate));
    setShellSandboxRequestedAtBoot(true);
    return root;
  };

  it("has stopped a background process the container payload left running by the time the result settles", { timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs }, async (testContext) => {
    const root = await containerRoute(testContext.skip);
    writeFileSync(join(root, "leave.cmd"), [
      "@start \"\" /b powershell.exe -NoProfile -Command \"Set-Content -LiteralPath '%~dp0spin.pid' -Value $PID; while ($true) { Start-Sleep -Seconds 1 }\"",
      "@for /l %%i in (1,1,200) do @if not exist \"%~dp0spin.pid\" @for /l %%j in (1,1,20000) do @rem",
      "@echo left", ""].join("\r\n"));
    const { input, context } = await approvedPowerShell(root, ".\\leave.cmd");
    const result = await new PowerShellTool().execute(input, context);
    evidence("container background result", { isError: result.isError, output: result.output.slice(0, 600), metadata: result.metadata });
    const left = Number.parseInt(readFileSync(join(root, "spin.pid"), "utf8"), 10);
    expect(Number.isInteger(left)).toBe(true);
    expect(alive(left)).toBe(false);
    expect(result.isError, result.output).toBe(false);
    expect(result.output.startsWith("left")).toBe(true);
    // The container's own teardown can stop the left process before the hold looks, so the stopped notice is not asserted.
    expect(result.metadata).not.toHaveProperty("cwdPinLost");
  });

  it("keeps the container payload and its descendant in the hold job and stops both when the helper dies", { timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs }, async (testContext) => {
    directory = await containerRoute(testContext.skip);
    // The payload starts one descendant, a cmd.exe busy loop that outlives the test unless the job stops it.
    // Its output passes the capture limit first, so only a reason carried outside the output survives truncation.
    writeFileSync(join(directory, "spin.cmd"), "@for /l %%i in (1,1,25000) do @echo 0123456789\r\n@echo.>\"%~dp0echoed\"\r\n@for /l %%i in (1,1,2000000000) do @rem\r\n");
    const listed = await spinning(directory);
    boundary.helper?.kill();
    const result = await listed.pending;
    evidence("container result", { isError: result.isError, output: result.output.slice(0, 600), metadata: result.metadata });
    expect(listed.members.filter(({ pid }) => alive(pid))).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.output.indexOf("...[truncated]...")).toBeGreaterThan(-1);
    // The launcher went with the job, so nothing confirmed the run: unconfirmed, never lost and never the command's code.
    expect(result.output.indexOf("...[truncated]...")).toBeLessThan(result.output.indexOf(t("shellExecution.cwdPinUnconfirmed")));
    expect(result.output.endsWith(t("shellExecution.cwdPinUnconfirmed"))).toBe(true);
    expect(result.metadata).toMatchObject({ cwdPinUnconfirmed: true });
    expect(result.metadata).not.toHaveProperty("cwdPinLost");
  });

  it.for(["abort", "timeout"] as const)("waits on %s for a launcher that cannot prove its job empty and fails the run", { timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs }, async (end, testContext) => {
    if (!existsSync(UNQUERYABLE_LAUNCHER)) throw new Error("Build the launcher fixture: bun run build:windows-job -- -QueryFailureFixture");
    directory = await containerRoute(testContext.skip);
    writeFileSync(join(directory, "spin.cmd"), "@echo.>\"%~dp0echoed\"\r\n@for /l %%i in (1,1,2000000000) do @rem\r\n");
    boundary.unqueryable = true;
    const abort = new AbortController();
    try {
      const listed = await spinning(directory, end === "abort" ? { abortSignal: abort.signal } : { timeoutSeconds: 8 });
      if (end === "abort") abort.abort();
      const result = await listed.pending;
      evidence(`container ${end} result`, { isError: result.isError, output: result.output.slice(0, 600), metadata: result.metadata });
      expect(listed.members.filter(({ pid }) => alive(pid))).toEqual([]);
      expect(result.isError).toBe(true);
      expect(result.output.endsWith(t("shellExecution.cwdPinUnconfirmed"))).toBe(true);
      expect(result.notice).toBe(t("shellExecution.cwdPinUnconfirmed"));
      expect(result.metadata).toMatchObject({ cwdPinUnconfirmed: true });
    } finally { boundary.unqueryable = false; }
  });

  it("fails a refused pinned start and never retries the command unpinned", { timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs }, async (testContext) => {
    directory = await containerRoute(testContext.skip);
    const { input, context } = await approvedPowerShell(directory, "Write-Output ('pinned' + 'run')");
    boundary.spawns = [];
    boundary.refuseHold = true;
    try {
      const result = await new PowerShellTool().execute(input, context);
      evidence("container refused result", { isError: result.isError, output: result.output.slice(0, 600), metadata: result.metadata });
      evidence("container refused spawns", boundary.spawns.map((argv) => argv.slice(0, 6)));
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain("pinnedrun");
      expect(result.metadata).toMatchObject({ cwdPinLost: true });
      // The container's own startup probe runs before the hold; nothing starts after the refused launch.
      const launch = boundary.spawns.findIndex((argv) => argv[0]?.endsWith("ave-job.exe") === true && argv[1] === "--hold");
      expect(launch).toBeGreaterThan(-1);
      expect(boundary.spawns.slice(launch + 1)).toEqual([]);
    } finally { boundary.refuseHold = false; }
  });

  // Starts spin.cmd under the container route and returns once it has written its marker and its cmd.exe is in the hold job.
  const spinning = async (root: string, options: { abortSignal?: AbortSignal; timeoutSeconds?: number } = {}) => {
    const approved = await approvedPowerShell(root, ".\\spin.cmd", options.timeoutSeconds);
    const pending = new PowerShellTool().execute(approved.input, { ...approved.context, ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }) });
    let listed: { pid: number; name: string }[] = [];
    const early = pending.then((r) => { throw new Error(`finished early: ${JSON.stringify(r).slice(0, 1500)}`); });
    await Promise.race([early, vi.waitFor(async () => {
      expect(existsSync(join(root, "echoed"))).toBe(true);
      listed = processNames(await members());
      expect(listed.map(({ name }) => name)).toContain("cmd.exe");
    }, { timeout: 30000, interval: 500 })]);
    evidence("container hold job members", listed);
    return { pending, members: listed };
  };
});

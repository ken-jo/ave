import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { resolveShell, shellQuote } from "../lib/shell-resolver.js";
import { createLogger } from "../lib/logger.js";
import {
  cleanupAsrtSandboxAfterCommand, getDefaultSensitiveReadDenyPaths,
  getOwnedSandboxActionWriteDenyPaths, getProtectedReadDenyFloor, protectedReadDenyCovering,
  isShellSandboxActive, sandboxTempEnvLaunch, wrapToolCommand, type SandboxWrapResult,
} from "../permissions/asrt-sandbox.js";
import { openEgressInvocation } from "../permissions/egress-invocations.js";
import { getHostShellExecutionPlan, getSandboxGeneration } from "../permissions/sandbox-capability.js";
import { createSandboxProcessHome } from "../permissions/sandbox-process-home.js";
import { isSandboxActionDirectory, releaseSandboxActionDirectory } from "../permissions/sandbox-action-directory.js";
import { buildMandatorySandboxWritePolicy } from "../permissions/sandbox-write-policy.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { XLSX_EDIT_LIMITS } from "../shared/xlsx-panel-edit.js";
import { prepareMxcShellLaunch, type MxcShellLaunch } from "../tools/mxc-shell-launch.js";
import { buildSafeChildEnv, buildSandboxedChildEnv } from "../tools/safe-env.js";
import {
  assertManagedChildProcessAdmissionOpen, forceKillManagedChildProcess, trackManagedChildProcess,
} from "./managed-child-processes.js";
import { hostScriptInvocationReadPaths, hostScriptRuntimePaths } from "./host-script-runtime.js";

// A descriptor may encode every permitted UTF-16 code unit as a six-byte JSON escape.
const MAX_OUTPUT_BYTES = XLSX_EDIT_LIMITS.maxValueChars * 6 + 1024;
const log = createLogger("bundled-script-execution");

export class BundledScriptExecutionError extends Error {
  constructor(
    readonly code: "unavailable" | "integrity" | "execution",
    message: string,
    readonly cleanupUnproven = false,
  ) {
    super(message);
    this.name = "BundledScriptExecutionError";
  }
}

/** The availability check grants no authority; execution rechecks the live route and bundle. */
export function assertWorkbookScriptAvailable(): void {
  const plan = getHostShellExecutionPlan();
  if (!isShellSandboxActive() || plan.mode !== "asrt" || !plan.sandboxed || plan.capability.confidence !== "verified"
    || !plan.capability.confines?.filesystem || !plan.capability.confines.process || !plan.capability.confines.network
    || (process.platform === "win32" ? plan.substrate !== "mxc" : plan.substrate !== "asrt")) {
    throw new BundledScriptExecutionError("unavailable", "Document confinement is unavailable");
  }
  const runtime = hostScriptRuntimePaths();
  if (!runtime || hostScriptInvocationReadPaths([runtime.javascriptRuntime,
    join(runtime.bundledScriptsDirectory, "edit-xlsx.cjs")], { ELECTRON_RUN_AS_NODE: "1" }).length === 0) {
    throw new BundledScriptExecutionError("integrity", "Bundled workbook script integrity failed");
  }
}

// Native process argv quoting; no shell is involved in the container command line.
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

// Root exit alone does not prove descendant termination. Never free the HOME/listener while a group survives.
async function drainChild(child: ChildProcess): Promise<void> {
  await forceKillManagedChildProcess(child, "document action finished");
  if (process.platform === "win32" || child.pid === undefined) return;
  const deadline = Date.now() + TOOL_TIMEOUT_POLICY.processTreeKillMs;
  while (processGroupExists(child.pid)) {
    if (Date.now() >= deadline) throw new BundledScriptExecutionError("execution", "Document process cleanup is unproven", true);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

/** Runs only the verified bundled workbook command against a host-owned staging directory. */
export async function runWorkbookScript(
  directory: string,
  operation: "edit" | "inspect",
  signal?: AbortSignal,
): Promise<{ stdout: string }> {
  try { return await executeWorkbookScript(directory, operation, signal); }
  catch (error) {
    if (error instanceof BundledScriptExecutionError) throw error;
    throw new BundledScriptExecutionError("execution", error instanceof Error ? error.message : "Bundled workbook command failed");
  }
}

async function executeWorkbookScript(directory: string, operation: "edit" | "inspect", signal?: AbortSignal): Promise<{ stdout: string }> {
  signal?.throwIfAborted();
  if (operation !== "edit" && operation !== "inspect") throw new Error("Invalid workbook operation");
  assertWorkbookScriptAvailable();
  const plan = getHostShellExecutionPlan();
  const generation = getSandboxGeneration();
  if (!isSandboxActionDirectory(directory) || !isAbsolute(directory) || lstatSync(directory).isSymbolicLink()
    || !lstatSync(directory).isDirectory() || realpathSync.native(directory) !== directory
    || protectedReadDenyCovering(directory) !== undefined) throw new Error("Invalid document staging directory");
  for (const name of ["workbook.xlsx", "request.json"]) {
    const info = lstatSync(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Invalid document staging input");
  }
  const runtime = hostScriptRuntimePaths();
  if (!runtime) throw new BundledScriptExecutionError("integrity", "Bundled workbook runtime is unavailable");
  const argv = [runtime.javascriptRuntime, join(runtime.bundledScriptsDirectory, "edit-xlsx.cjs"),
    ...(operation === "inspect" ? ["--inspect"] : []), join(directory, "workbook.xlsx"), join(directory, "request.json")];
  const scriptReads = hostScriptInvocationReadPaths(argv, { ELECTRON_RUN_AS_NODE: "1" });
  if (scriptReads.length === 0) throw new BundledScriptExecutionError("integrity", "Bundled workbook script integrity failed");
  const home = createSandboxProcessHome();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let invocation: ReturnType<typeof openEgressInvocation> | undefined;
  let wrapped: SandboxWrapResult | undefined;
  let mxc: MxcShellLaunch | undefined;
  let child: ChildProcess | undefined;
  let childClosed = false;
  let cleanupProven = true;
  const cleanupResources = async (): Promise<void> => {
    try { await mxc?.release(); }
    finally {
      try { invocation?.release(); }
      finally {
        try {
          if (wrapped) {
            await cleanupAsrtSandboxAfterCommand();
            const outcome = await wrapped.cleanupCompleted;
            if (outcome?.failure) throw new Error("Document sandbox cleanup failed");
          }
        } finally { home.cleanup(); }
      }
    }
  };
  try {
    const temp = join(home.path, "tmp");
    mkdirSync(temp, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    deadline = setTimeout(() => controller.abort(new Error("Document action timed out")), TOOL_TIMEOUT_POLICY.shellDefaultMs);
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    invocation = openEgressInvocation({ kind: "user-document", action: "workbook" }, { abortSignal: combinedSignal });
    const writeRoots = [directory, home.path];
    const sensitiveWrites = getOwnedSandboxActionWriteDenyPaths(directory);
    const mandatory = buildMandatorySandboxWritePolicy(writeRoots, undefined, sensitiveWrites);
    const filesystem = {
      allowWrite: mandatory.allowWrite,
      allowRead: [directory, home.path, ...scriptReads].filter(path => protectedReadDenyCovering(path) === undefined),
      denyRead: [...new Set([...getDefaultSensitiveReadDenyPaths(), ...getProtectedReadDenyFloor()])],
      denyWrite: [...new Set([...sensitiveWrites, ...mandatory.denyWrite.map(entry => typeof entry === "string" ? entry : entry.path)])],
      floorPierces: [],
      pinWriteRoots: true,
    };
    const env = buildSafeChildEnv({ ...home.env, ELECTRON_RUN_AS_NODE: "1", TMPDIR: temp, TMP: temp, TEMP: temp });
    let command: string | undefined;
    let args: string[];
    let childEnv: Record<string, string>;
    if (plan.substrate === "mxc") {
      mxc = await prepareMxcShellLaunch({ egressToken: invocation.token, commandLine: argv.map(quoteWindowsArgument).join(" "),
        cwd: directory, filesystem, env, timeoutMs: TOOL_TIMEOUT_POLICY.shellDefaultMs, exists: existsSync });
      [command, ...args] = [...mxc.argv] as [string, ...string[]];
      childEnv = buildSafeChildEnv();
    } else {
      const launch = sandboxTempEnvLaunch(temp, argv[0]!, argv.slice(1));
      wrapped = await wrapToolCommand([launch.command, ...launch.args].map(shellQuote).join(" "), {
        filesystem, abortSignal: combinedSignal, commandId: invocation.token, denyUnixSockets: true,
        actionDirectory: directory,
        binShell: resolveShell("bash").cmd,
      });
      [command, ...args] = wrapped.argv;
      childEnv = buildSandboxedChildEnv(wrapped.env, env);
    }
    if (!command) throw new Error("Document confinement returned no executable");
    combinedSignal.throwIfAborted();
    // A runtime generation changing while the native wrapper was prepared invalidates this launch.
    if (getSandboxGeneration() !== generation || getHostShellExecutionPlan().identity !== plan.identity) {
      throw new BundledScriptExecutionError("unavailable", "Document runtime changed before launch");
    }
    if (hostScriptInvocationReadPaths(argv, env).length === 0) {
      throw new BundledScriptExecutionError("integrity", "Bundled workbook script integrity failed");
    }
    assertManagedChildProcessAdmissionOpen("user-document:workbook");
    const startedChild = spawn(command, args, { cwd: mxc ? win32.dirname(command) : directory,
      env: childEnv, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
      detached: process.platform !== "win32" });
    child = startedChild;
    cleanupProven = false;
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    let refuseUnsettledClose: ((error: Error) => void) | undefined;
    const unsettledClose = new Promise<never>((_resolve, reject) => { refuseUnsettledClose = reject; });
    const stop = (error: Error): void => {
      failure ??= error;
      if (!childClosed && closeDeadline === undefined) {
        closeDeadline = setTimeout(() => refuseUnsettledClose?.(new BundledScriptExecutionError(
          "execution", "Document process closure is unproven", true,
        )), process.platform === "win32" ? TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs : TOOL_TIMEOUT_POLICY.processTreeKillMs);
      }
      controller.abort(error);
      void forceKillManagedChildProcess(startedChild, "document action cancelled");
    };
    const handleAbort = (): void => stop(controller.signal.reason instanceof Error
      ? controller.signal.reason : new Error("Document action cancelled"));
    combinedSignal.addEventListener("abort", handleAbort, { once: true });
    if (combinedSignal.aborted) handleAbort();
    const collect = (chunk: Buffer, standardOutput: boolean): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) stop(new Error("Document output limit exceeded"));
      else if (standardOutput) stdout.push(Buffer.from(chunk));
    };
    startedChild.stdout!.on("data", (chunk: Buffer) => collect(chunk, true));
    startedChild.stderr!.on("data", (chunk: Buffer) => collect(chunk, false));
    try {
      const closed = new Promise<number | null>(resolve => {
        startedChild.once("error", error => stop(error));
        startedChild.once("close", code => { childClosed = true; resolve(code); });
      });
      try {
        trackManagedChildProcess(startedChild, { killProcessGroup: process.platform !== "win32", label: "user-document:workbook" });
        if (process.platform !== "win32" && startedChild.pid !== undefined) invocation.noteProcessGroup(startedChild.pid);
      } catch (error) {
        stop(error instanceof Error ? error : new Error("Document process registration failed"));
      }
      const code = await Promise.race([closed, unsettledClose]);
      await drainChild(startedChild);
      cleanupProven = true;
      if (failure) throw failure;
      if (code !== 0) throw new Error("Bundled workbook command failed");
      return { stdout: Buffer.concat(stdout).toString("utf8") };
    } finally {
      clearTimeout(closeDeadline);
      combinedSignal.removeEventListener("abort", handleAbort);
    }
  } finally {
    clearTimeout(deadline);
    if (cleanupProven) {
      try { await cleanupResources(); }
      catch { throw new BundledScriptExecutionError("execution", "Document resource cleanup is unproven", true); }
    } else if (child !== undefined) {
      // Keep ownership after refusing the action; closure and group absence must both be observed before release.
      const retainedChild = child;
      const cleanupWhenDrained = (): void => {
        if (!childClosed || (process.platform !== "win32" && retainedChild.pid !== undefined && processGroupExists(retainedChild.pid))) {
          const retry = setTimeout(cleanupWhenDrained, TOOL_TIMEOUT_POLICY.processGroupPollMs);
          retry.unref();
          return;
        }
        void cleanupResources().then(() => releaseSandboxActionDirectory(directory))
          .catch(() => log.warn("Document deferred resource cleanup failed"));
      };
      cleanupWhenDrained();
    }
  }
}

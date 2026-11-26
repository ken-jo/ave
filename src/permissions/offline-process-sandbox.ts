import { access, constants, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { text } from "node:stream/consumers";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { shellQuote } from "../lib/shell-resolver.js";
import { noteConfinedProcessesMayRun } from "../lib/confined-process-phase.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import {
  abandonManagedLaunch, createManagedResources, observeManagedProcessGroup, observeManagedWindowsJobExit, recordManagedCleanup,
  recordManagedPaths, releaseManagedResources, spawnManaged, type ConfirmedExit, type ManagedResources,
} from "../main/managed-child-processes.js";
import { resolveWindowsJobLauncher } from "../main/windows-job-launcher.js";
import { TableDocumentError } from "../tools/table-document-error.js";
import { assertCodexExecutableLocation } from "../main/codex-executable-location.js";
import {
  buildPerCommandSandboxCustomConfig, getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyEntries, isOfflineProcessConfinementActive,
} from "./asrt-sandbox.js";
import { createAveHomeBoundarySnapshot } from "./ave-home-boundary-snapshot.js";
import { detectSandboxCapability } from "./sandbox-capability.js";
import { hardenLinuxSandboxWrap } from "./linux-sandbox-wrap.js";
import { hardenMacSandboxGitMetadata } from "./macos-sandbox-wrap.js";
import { offlineProcessConfinementImplemented } from "./offline-confinement-platforms.js";
// Sandbox runtime package types stay here on purpose: this module builds or feeds a package config. They go when the package dependency goes.
import type { FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";

interface OfflineProcessInput {
  command: string;
  args: readonly string[];
  /** Caller-authenticated immutable runtime closure; never renderer supplied. */
  runtimeDirectories: readonly string[];
  inputDirectory: string;
  outputDirectory: string;
  ipcDirectory: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** The wrapped process's handle; the wrap records its own teardown on it. */
  resources: ManagedResources;
  /** Each confirmed scanner exit, for the caller that releases an ancestor handle. */
  noteExit?: (receipt: ConfirmedExit) => void;
}

export interface OfflineProcessWrap {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

export class OfflineScanExitUnconfirmedError extends TableDocumentError {
  constructor() {
    super("engine-confinement-unavailable", "Offline scanner termination was not confirmed.");
  }
}

async function runOfflineScan(command: string, args: string[], signal: AbortSignal, timeoutMs: number,
  scanDirectory: string, resources: ManagedResources, noteExit: (receipt: ConfirmedExit) => void) {
  const jobReceipt = process.platform === "win32" ? join(scanDirectory, "job-empty") : undefined;
  if (jobReceipt !== undefined) await writeFile(jobReceipt, "", { flag: "wx" });
  const start = (onSpawn: (child: ChildProcess) => void) => jobReceipt === undefined
    ? spawnManaged(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] }, { label: "offline-scanner" }, onSpawn)
    : spawnManaged(resolveWindowsJobLauncher(), ["--receipt", jobReceipt, command, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    }, { label: "offline-scanner" }, onSpawn);
  let running: {
    exit: ReturnType<typeof observeManagedProcessGroup>;
    job?: ReturnType<typeof observeManagedWindowsJobExit>;
  } | undefined;

  // The ceiling links cancellation before calling start, and the interruption path owns the child until its exit is confirmed.
  const scan = await runWithCeiling(async (stop) => {
    stop.throwIfAborted();
    const child = start(acquired => {
      const exit = observeManagedProcessGroup(acquired, jobReceipt === undefined ? resources : undefined);
      const job = jobReceipt === undefined ? undefined : observeManagedWindowsJobExit(acquired, jobReceipt, resources);
      running = { exit, job };
    });
    const exit = running?.exit;
    if (!exit) throw new Error("Offline scanner exit is unowned.");
    child.stdin?.on("error", () => {});
    const failed = new Promise<never>((_resolve, reject) => child.once("error", reject));
    if (!child.stdout || !child.stderr) throw new Error("Offline scanner output is unavailable.");
    const output = Promise.all([text(child.stdout), text(child.stderr), exit.wait(stop)]);
    const [stdout, stderr, { code }] = await Promise.race([output, failed]);
    return { stdout, stderr, code };
  }, timeoutMs, signal, "offline scan");

  if (running) {
    const { exit, job } = running;
    const confirmed = job === undefined
      ? await exit.confirmExit(scan.ok ? undefined : "offline scan interrupted")
      : await (scan.ok ? job.completion : job.stop());
    if (!confirmed) throw new OfflineScanExitUnconfirmedError();
    noteExit(confirmed);
  }
  if (scan.ok) return scan.value;
  signal.throwIfAborted();
  throw scan.error;
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path === sep || /[\0*?\[\]]/u.test(path)) {
    throw new Error("Invalid offline process directory.");
  }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("Offline process directory identity is invalid.");
  }
  return path;
}

function literalLists(entries: readonly FilesystemPathEntry[] | undefined): { patterns: string[]; literals: string[] } {
  const patterns: string[] = [];
  const literals: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry === "string") patterns.push(entry);
    else if (entry.literal === true) literals.push(entry.path);
    else throw new Error("Offline process policy contains an unsupported path entry.");
  }
  return { patterns, literals };
}

/** Kernel-denied IP networking has no proxy exception; private local IPC remains usable. */
export async function wrapOfflineProcess(input: OfflineProcessInput): Promise<OfflineProcessWrap> {
  input.signal.throwIfAborted();
  const capability = detectSandboxCapability();
  if (!offlineProcessConfinementImplemented() || !isOfflineProcessConfinementActive() || capability.confidence !== "verified"
    || capability.confines?.filesystem !== true || capability.confines.process !== true || capability.confines.network !== true) {
    throw new TableDocumentError("engine-confinement-unavailable", "Offline document engine confinement is unavailable.");
  }
  const output = await canonicalDirectory(input.outputDirectory);
  const source = await canonicalDirectory(input.inputDirectory);
  const ipc = await canonicalDirectory(input.ipcDirectory);
  const runtimes = await Promise.all(input.runtimeDirectories.map(canonicalDirectory));
  if (!within(output, ipc) || within(source, output) || within(output, source)
    || runtimes.length === 0 || runtimes.some(path => within(path, output) || within(output, path) || within(path, source))) {
    throw new Error("Offline process filesystem roots overlap.");
  }
  if (!runtimes.some(root => within(root, input.command))) throw new Error("Offline executable is outside its authenticated runtime.");
  await assertCodexExecutableLocation(input.command);
  const systemReads = process.platform === "darwin"
    ? ["/bin/sh", "/usr/bin/env", "/private/var/select/sh", "/usr/lib", "/System/Library", "/Library/Fonts", "/dev/null", "/dev/random", "/dev/urandom"]
    : ["/bin/sh", "/usr/bin/env", "/usr/lib", "/usr/lib64", "/lib", "/lib64", "/usr/share/fonts", "/usr/share/fontconfig", "/etc/fonts", "/etc/ld.so.cache", "/etc/localtime", "/etc/passwd", "/dev/null", "/dev/random", "/dev/urandom"];
  const policy = createAveHomeBoundarySnapshot().run(() => buildPerCommandSandboxCustomConfig({
    allowWrite: [output], allowRead: [source, output, ...systemReads],
    denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyEntries(),
    pinWriteRoots: true,
  }));
  if (!policy?.filesystem || !(policy.filesystem.allowWrite ?? []).some(entry => entry === output)) {
    throw new TableDocumentError("engine-confinement-unavailable", "Offline output directory was not admitted.");
  }
  const reads = literalLists(policy.filesystem.allowRead);
  const denies = literalLists(policy.filesystem.denyRead);
  const writes = literalLists(policy.filesystem.allowWrite);
  const writeDenies = literalLists(policy.filesystem.denyWrite);
  // Only the authenticated runtime closure may reopen its installed private namespace.
  const readConfig = {
    denyOnly: ["/", ...denies.patterns], literalDenyOnly: denies.literals,
    allowWithinDeny: reads.patterns, literalAllowWithinDeny: [...reads.literals, ...runtimes],
  };
  const writeConfig = {
    allowOnly: writes.patterns, literalAllowOnly: [...writes.literals, "/dev/null"],
    denyWithinAllow: writeDenies.patterns, literalDenyWithinAllow: writeDenies.literals,
  };
  const env = buildSafeChildEnv(Object.fromEntries(Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)));
  // Keep executable pathnames containing '=' past the env assignment operands.
  const launch = input.command.includes("=")
    ? ["/bin/sh", "-c", 'exec "$@"', "offline-process", input.command, ...input.args]
    : [input.command, ...input.args];
  const command = ["/usr/bin/env", `TMPDIR=${output}`, `TMP=${output}`, `TEMP=${output}`, ...launch].map(shellQuote).join(" ");
  input.signal.throwIfAborted();
  noteConfinedProcessesMayRun();
  if (process.platform === "darwin") {
    const { wrapCommandWithSandboxMacOS } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js");
    const wrapped = wrapCommandWithSandboxMacOS({
      command, needsNetworkRestriction: true, readConfig, writeConfig,
      allowUnixSockets: [ipc], allowAllUnixSockets: false, allowLocalBinding: false,
      allowAppleEvents: false, allowPty: false, enableWeakerNetworkIsolation: false, binShell: "/bin/sh",
      unsetEnvVars: ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"],
    });
    input.signal.throwIfAborted();
    return hardenMacSandboxGitMetadata({ argv: ["/bin/sh", "-c", wrapped], env });
  }
  const bwrap = "/usr/bin/bwrap";
  await assertCodexExecutableLocation(bwrap);
  const ripgrep = "/usr/bin/rg";
  const shell = "/bin/sh";
  try {
    await assertCodexExecutableLocation(ripgrep);
    await access(ripgrep, constants.X_OK);
    await assertCodexExecutableLocation(shell);
  } catch {
    throw new TableDocumentError("engine-confinement-unavailable", `Offline scan helper ${ripgrep} or its launcher is unavailable.`);
  }
  const { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js");
  const scanDirectory = await mkdtemp(join(dirname(source), ".offline-scan-")).catch(() => {
    throw new TableDocumentError("engine-confinement-unavailable", "Offline scan setup failed.");
  });
  let scanCompleted = false;
  let unconfirmedExit: OfflineScanExitUnconfirmedError | undefined;
  // The scans are children of the wrapped process's handle, so it cannot be released while one lacks a verdict.
  const scanResources = createManagedResources(input.resources);
  recordManagedPaths(scanResources, { path: scanDirectory, recursive: true });
  let lastScanExit: ConfirmedExit | undefined;
  try {
    let wrapped: string;
    try {
      wrapped = await wrapCommandWithSandboxLinux({
        command, needsNetworkRestriction: true, readConfig, writeConfig,
        allowAllUnixSockets: true, allowNestedUserNamespaces: false, enableWeakerNestedSandbox: false,
        binShell: shell, bwrapPath: bwrap,
        ripgrepConfig: {
          command: ripgrep,
          run: async (executable, args, signal, timeoutMs) => {
            try {
              if (unconfirmedExit) throw unconfirmedExit;
              const result = await runOfflineScan(executable, args, signal, timeoutMs, scanDirectory, scanResources,
                receipt => { lastScanExit = receipt; input.noteExit?.(receipt); });
              scanCompleted = result.code === 0 || result.code === 1;
              return result;
            } catch (error) {
              if (error instanceof OfflineScanExitUnconfirmedError) unconfirmedExit = error;
              throw error;
            }
          },
        },
        abortSignal: input.signal, unsetEnvVars: ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"],
      });
      recordManagedCleanup(input.resources, cleanupBwrapMountPoints);
      input.signal.throwIfAborted();
      if (!scanCompleted) {
        throw new TableDocumentError("engine-confinement-unavailable", "Offline scan did not complete.");
      }
    } finally {
      if (!unconfirmedExit) await (lastScanExit ? releaseManagedResources(scanResources, lastScanExit) : abandonManagedLaunch(scanResources));
    }
    // Local IPC needs AF_UNIX; nested namespaces must therefore be refused by the native wrapper itself.
    if (!wrapped.includes("--disable-userns")) {
      throw new TableDocumentError("engine-confinement-unavailable", "Offline local IPC requires namespace creation to be disabled.");
    }
    input.signal.throwIfAborted();
    return hardenLinuxSandboxWrap({ argv: ["/bin/sh", "-c", wrapped], env }, {
      allowRead: [...reads.patterns, ...reads.literals, ...runtimes], denyWrite: [...writeDenies.patterns, ...writeDenies.literals],
    });
  } catch (error) {
    // A setup failure releases what the wrap recorded, unless a scanner still lacks a verdict.
    if (!unconfirmedExit) await (lastScanExit ? releaseManagedResources(input.resources, lastScanExit) : abandonManagedLaunch(input.resources));
    throw unconfirmedExit ?? error;
  }
}

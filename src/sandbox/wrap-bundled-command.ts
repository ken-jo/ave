import { shellQuote } from "../lib/shell-resolver.js";
import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  cleanupAsrtSandboxAfterCommand,
  ensureSandboxTempPrincipalDir,
  sandboxTempEnvLaunch,
  wrapWorkerCommand,
  type SandboxTempPrincipal,
} from "../permissions/asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createLogger } from "../lib/logger.js";
import { spawnConfinedChild } from "../permissions/confined-child.js";
import { createSandboxProcessHome } from "../permissions/sandbox-process-home.js";
import {
  holdWindowsFilesystemGrant,
  terminateChildBestEffort,
  type HeldWindowsGrant,
} from "../permissions/windows-acl-grant-holder.js";
import { isPathWithin } from "../plugins/plugin-storage-containment.js";
import { aveHome } from "../shared/ave-home.js";
import { openEgressInvocation, type EgressInvocation, type WorkerEgressOwner } from "../permissions/egress-invocations.js";

const log = createLogger("wrap-bundled-command");

export interface BundledWrapInput {
  command: string;
  args: readonly string[];
  sandboxHome: { path: string; env: Record<string, string> };
  allowWrite: readonly string[];
  /** The directories of the process's own plugin it reads, re-allowed inside the plugins-root deny: a hook's generation root,
   * a bundled server's payload root. Empty for a server that belongs to no plugin, which then reads nothing under the root. */
  ownPluginReads: readonly string[];
  /** Host-owned principal whose private temporary directory the process receives. */
  tempPrincipal: SandboxTempPrincipal;
  /** Who the process's proxy denies are audited under (`egress-invocations.ts`). */
  egressOwner: WorkerEgressOwner;
}

/** Apply the same sensitive-path floors and egress policy to bundled processes. The wrapped launch, and the egress token it carries. The
 * caller spawns the process itself, so it owns the token too: `egress.release()` once the process has exited, or when the spawn fails. */
export async function wrapBundledCommand(input: BundledWrapInput): Promise<{ argv: string[]; env: NodeJS.ProcessEnv; egress: EgressInvocation }> {
  if (process.platform === "win32") {
    // The macOS and Linux wrap: allow paths in the command. Windows has no per-exec allow; its
    // bundled processes go through `spawnWindowsBundledProcess`, and reaching here is a caller's mistake.
    throw new Error("wrapBundledCommand is the macOS and Linux wrap; a Windows bundled process is spawned by spawnWindowsBundledProcess");
  }
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  // The principal's own temp directory, set as its TMPDIR inside the wrap (ASRT's own assignment would otherwise name the shared root) and granted alone; the read floor denies the
  // shared temp and HOME roots, so no other principal's temp files or HOME can be read either, and the process HOME re-allowed here is its own; as `confined-child.ts` does for its children.
  const temp = ensureSandboxTempPrincipalDir(input.tempPrincipal);
  const launch = sandboxTempEnvLaunch(temp.dir, input.command, input.args);
  const cmdline = [launch.command, ...launch.args].map(shellQuote).join(" ");
  const egress = openEgressInvocation(input.egressOwner);
  let result: { argv: string[]; env: NodeJS.ProcessEnv };
  try {
    result = await wrapWorkerCommand(cmdline, {
      commandId: egress.token,
      filesystem: {
        allowWrite: [temp.dir, input.sandboxHome.path, ...input.allowWrite],
        // An ancestor grant can re-emit a protected deny after the exact hook file carve-out. User hooks need only their own temporary directory.
        allowRead: [temp.dir, input.sandboxHome.path, ...input.ownPluginReads, ...input.allowWrite,
          ...(tmpDir && input.tempPrincipal.kind !== "hook" ? [tmpDir] : [])],
        ...(input.tempPrincipal.kind === "hook" ? { floorPierces: input.ownPluginReads } : {}),
        denyRead: getDefaultSensitiveReadDenyPaths(),
        denyWrite: getDefaultSensitiveWriteDenyPaths(),
        // Bundled hooks and MCP stdio servers are plugin-owned (or third-party) code, and every root they
        // write into is one the host created: a plugin's data root, a server's sandbox root, the process HOME.
        pinWriteRoots: true,
        // And none of them reads another plugin's directories: a hook writes its plugin's data root, which
        // that plugin's child reads, so a hook that could read a neighbour's data could hand it to the child.
        denyPluginsRoot: true,
      },
    });
  } catch (error) {
    egress.release();
    throw error;
  }
  if (!result.argv[0]) {
    egress.release();
    await cleanupAsrtSandboxAfterCommand();
    throw new Error("ASRT returned an empty argv for a bundled process");
  }
  return { ...result, egress };
}

/** Preserve only ASRT's changed proxy keys over the caller's stripped environment. */
export function bundledWrappedEnv(
  baseEnv: NodeJS.ProcessEnv,
  wrappedEnv: NodeJS.ProcessEnv,
  sandboxHomeEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const composed = buildSandboxedChildEnv(wrappedEnv);
  const baseline = buildSandboxedChildEnv(process.env);
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(composed)) {
    if (value !== undefined && baseline[key] !== value) overlay[key] = value;
  }
  return { ...baseEnv, ...overlay, ...sandboxHomeEnv };
}

/** A bundled process started under srt-win, and what it holds while it runs. */
export interface WindowsBundledSpawn {
  readonly child: ChildProcess;
  /** The program's input and output, through the stdio relay (`confined-child.ts`). */
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Revoke the filesystem grant and remove the throwaway HOME. Idempotent; the HOME removal stays retryable, as `createSandboxProcessHome`
   * documents. Call it on the child's exit and again on its close. ASRT's per-command cleanup is the caller's, as it is for {@link wrapBundledCommand}. */
  readonly releaseHold: () => void;
}

/** Windows holds lifetime ACL grants for allowed reads/writes, private home, and bundled runtime binaries; relay stdio with the intended environment and cwd.
 * It shares one sandbox identity without per-plugin root pinning; lost grants stop the process, and any launch failure releases all acquired resources. */
export async function spawnWindowsBundledProcess(input: {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly egressOwner: WorkerEgressOwner;
  /** Recheck caller-owned admission after preparation, at the actual spawn boundary. */
  readonly assertStillValid?: () => void;
  /** Refresh caller-owned authority after asynchronous launch preparation. */
  readonly refreshStillValid?: () => Promise<void>;
}): Promise<WindowsBundledSpawn> {
  if (process.platform !== "win32") {
    throw new Error(`[wrap-bundled-command] ${input.label}: spawnWindowsBundledProcess is the Windows path`);
  }
  const sandboxHome = createSandboxProcessHome();
  let grant: HeldWindowsGrant | undefined;
  const releaseHold = (): void => {
    grant?.release();
    sandboxHome.cleanup();
  };
  let wrapped = false;
  let child: ChildProcess | undefined;
  try {
    grant = await holdWindowsFilesystemGrant({
      label: `${input.label}:asrt-win-acl`,
      allowRead: [...new Set([sandboxHome.path, ...input.allowWrite, ...input.allowRead, ...hostRuntimeReads(input.command)])],
      allowWrite: [...new Set([sandboxHome.path, ...input.allowWrite])],
    });
    const held = grant;
    const spawned = await spawnConfinedChild({
      command: input.command,
      args: input.args,
      label: `${input.label}:asrt-win`,
      egressOwner: input.egressOwner,
      grantMode: "deny-only",
      baseEnv: input.baseEnv,
      extraEnv: { ...sandboxHome.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsStdio: "relay",
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      refreshStillValid: input.refreshStillValid,
      assertStillValid: () => {
        held.assertAlive();
        input.assertStillValid?.();
      },
      onWrapped: () => {
        wrapped = true;
      },
    });
    child = spawned.child;
    if (spawned.confinement !== "windows-srt") {
      throw new Error(`[wrap-bundled-command] ${input.label}: the sandbox was expected but the process came back ${spawned.confinement}`);
    }
    const running = child;
    held.onLost((reason) => {
      log.warn(`[${input.label}] filesystem grant lost, ending the process: ${reason.message}`);
      terminateChildBestEffort(running);
    });
    // A start that produced no process emits `error` and may emit nothing else.
    running.once("error", () => {
      if (running.pid === undefined) releaseHold();
    });
    return { child: running, stdin: spawned.stdin!, stdout: spawned.stdout!, releaseHold };
  } catch (error) {
    if (child !== undefined) terminateChildBestEffort(child);
    if (wrapped) void cleanupAsrtSandboxAfterCommand();
    releaseHold();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** `<AVE_HOME>/runtime`, when the command is a program inside it. */
function hostRuntimeReads(command: string): string[] {
  const runtime = join(aveHome(), "runtime");
  return isPathWithin(runtime, command) ? [runtime] : [];
}

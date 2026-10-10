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

const log = createLogger("wrap-bundled-command");

export interface BundledWrapInput {
  command: string;
  args: readonly string[];
  sandboxHome: { path: string; env: Record<string, string> };
  allowWrite: readonly string[];
  /**
   * The directories of the process's own plugin it reads, re-allowed inside
   * the plugins-root deny: a hook's generation root, a bundled server's
   * payload root. Empty for a server that belongs to no plugin, which then
   * reads nothing under the root.
   */
  ownPluginReads: readonly string[];
  /** Whose temp directory the process gets: its plugin for a hook, its server for an MCP stdio server. */
  tempPrincipal: SandboxTempPrincipal;
}

/** Apply the same sensitive-path floors and egress policy to bundled processes. */
export async function wrapBundledCommand(input: BundledWrapInput): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  if (process.platform === "win32") {
    // The macOS and Linux wrap: allow paths in the command. Windows has no
    // per-exec allow; its bundled processes go through
    // `spawnWindowsBundledProcess`, and reaching here is a caller's mistake.
    throw new Error("wrapBundledCommand is the macOS and Linux wrap; a Windows bundled process is spawned by spawnWindowsBundledProcess");
  }
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  // The principal's own temp directory, set as its TMPDIR inside the wrap
  // (ASRT's own assignment would otherwise name the shared root) and granted
  // alone; the read floor denies the shared temp and HOME roots, so no other
  // principal's temp files or HOME can be read either, and the process HOME
  // re-allowed here is its own — as `confined-child.ts` does for its children.
  const temp = ensureSandboxTempPrincipalDir(input.tempPrincipal);
  const launch = sandboxTempEnvLaunch(temp.dir, input.command, input.args);
  const cmdline = [launch.command, ...launch.args].map(shellQuote).join(" ");
  const result = await wrapWorkerCommand(cmdline, {
    filesystem: {
      allowWrite: [temp.dir, input.sandboxHome.path, ...input.allowWrite],
      allowRead: [temp.dir, input.sandboxHome.path, ...input.ownPluginReads, ...input.allowWrite, ...(tmpDir ? [tmpDir] : [])],
      denyRead: getDefaultSensitiveReadDenyPaths(),
      denyWrite: getDefaultSensitiveWriteDenyPaths(),
      // Bundled hooks and MCP stdio servers are plugin-owned (or third-party)
      // code, and every root they write into is one the host created: a
      // plugin's data root, a server's sandbox root, the process HOME.
      pinWriteRoots: true,
      // And none of them reads another plugin's directories: a hook writes its
      // plugin's data root, which that plugin's child reads, so a hook that
      // could read a neighbour's data could hand it to the child.
      denyPluginsRoot: true,
    },
  });
  if (!result.argv[0]) {
    await cleanupAsrtSandboxAfterCommand();
    throw new Error("ASRT returned an empty argv for a bundled process");
  }
  return result;
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
  /**
   * Revoke the filesystem grant and remove the throwaway HOME. Idempotent; the
   * HOME removal stays retryable, as `createSandboxProcessHome` documents. Call
   * it on the child's exit and again on its close. ASRT's per-command cleanup is
   * the caller's, as it is for {@link wrapBundledCommand}.
   */
  readonly releaseHold: () => void;
}

/**
 * Start a bundled hook or MCP stdio server under srt-win.
 *
 * The macOS and Linux wrap puts allow paths in the command; srt-win has no
 * such per-exec allow, so reachability is an ACL grant held against a holder
 * process for the process's lifetime (`windows-acl-grant-holder.ts`, as a
 * plugin child's and a worker's are): READ on `allowRead`, the throwaway HOME
 * and every write root; WRITE on `allowWrite` and the HOME. When the command is
 * a program the host keeps under `<AVE_HOME>/runtime` (the uv Ave
 * materializes there for an `uvx` server), that directory is granted READ as
 * well — on macOS and Linux nothing denies it, and without it the account could
 * not even open the program. The wrap carries the deny floor only, and the
 * program runs through the stdio relay, which gives it a real stdin, its
 * intended environment and its working directory.
 *
 * What the Windows path does NOT carry over: `denyPluginsRoot` and
 * `pinWriteRoots` are allow-list notions with no srt-win counterpart, so a
 * bundled process here, like every Windows sandboxed process, shares the one
 * `srt-sandbox` identity with every plugin (decision 64): confined against the
 * host, not against other plugins.
 *
 * A grant lost while the process runs ends the process. Any failure before the
 * process is handed back releases everything this call took and rethrows.
 */
export async function spawnWindowsBundledProcess(input: {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
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
      grantMode: "deny-only",
      baseEnv: input.baseEnv,
      extraEnv: { ...sandboxHome.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsStdio: "relay",
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      assertStillValid: () => held.assertAlive(),
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

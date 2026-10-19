/**
 * Prepare one Bash/PowerShell tool command for an MXC container on Windows:
 * the invocation's own proxy listener, the ranked filesystem lists, the
 * container request and the `wxc-exec.exe` argv. The shell tool spawns the
 * argv and owns the process lifetime; this module owns nothing that outlives
 * {@link MxcShellLaunch.release}.
 *
 * Order of teardown (`release`): the listener closes only after
 * `wxc-exec.exe` has exited. The container ends with it (MXC's job object;
 * measured, also when `wxc-exec.exe` is killed), and with the container its
 * WFP permit for the port, so no surviving process can reach a port number
 * the OS later hands to another invocation's listener.
 */
import { win32 as winPath } from "node:path";

import {
  asrtInvocationProxyUpstream,
  getProtectedReadDenyFloor,
} from "../permissions/asrt-sandbox.js";
import {
  openInvocationProxyListener,
  type InvocationProxyListener,
} from "../permissions/egress-invocation-listener.js";
import {
  buildMxcShellRequest,
  mxcRequestArgs,
  rankMxcFilesystem,
  resolveHostWxcExecPath,
  type ShellFilesystemPolicy,
} from "../permissions/mxc-windows.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("mxc-shell-launch");

export interface MxcShellLaunch {
  /** `wxc-exec.exe` followed by its arguments; spawn with `shell: false`. */
  readonly argv: readonly string[];
  /** The invocation's proxy port, for diagnostics. */
  readonly proxyPort: number;
  /** Close the listener. Call once `wxc-exec.exe` has exited. Idempotent. */
  release(): Promise<void>;
}

export interface PrepareMxcShellLaunchInput {
  /** The invocation's egress token (`egress-invocations.ts`): the identity its listener stamps. */
  readonly egressToken: string;
  readonly commandLine: string;
  readonly cwd: string;
  /** The per-command policy the ASRT wrap would get, without the floor (added here). */
  readonly filesystem: Omit<ShellFilesystemPolicy, "protectedFloor">;
  /** The child's secret-stripped environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly exists: (path: string) => boolean;
}

/** Margin MXC's own timeout keeps behind the host's lifetime watch. */
const MXC_TIMEOUT_MARGIN_MS = 30_000;

export async function prepareMxcShellLaunch(input: PrepareMxcShellLaunchInput): Promise<MxcShellLaunch> {
  const upstream = await asrtInvocationProxyUpstream(input.egressToken);
  if (upstream === undefined) {
    throw new Error("the sandbox proxy is not running, so a contained command would have no network path");
  }
  const wxcExec = await resolveHostWxcExecPath();
  if (!input.exists(wxcExec)) {
    throw new Error(`Microsoft Execution Containers launcher is missing: ${wxcExec}`);
  }
  const grants = rankMxcFilesystem({ ...input.filesystem, protectedFloor: getProtectedReadDenyFloor() }, input.exists);
  let listener: InvocationProxyListener | undefined;
  try {
    listener = await openInvocationProxyListener({
      upstream: () => upstream,
      onRefused: (destination, reason) => log.info("refused a %s through an invocation proxy: %s", reason, destination),
    });
    const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"] ?? "C:\\Windows";
    const env: Record<string, string> = { ...input.env };
    if (!Object.keys(env).some((key) => key.toUpperCase() === "SYSTEMROOT")) env["SYSTEMROOT"] = systemRoot;
    const request = buildMxcShellRequest({
      commandLine: input.commandLine,
      cwd: winPath.normalize(input.cwd),
      grants,
      env,
      proxyUrl: listener.url,
      timeoutMs: input.timeoutMs + MXC_TIMEOUT_MARGIN_MS,
    });
    const opened = listener;
    return {
      argv: [wxcExec, ...mxcRequestArgs(request)],
      proxyPort: opened.port,
      release: () => opened.close(),
    };
  } catch (error) {
    await listener?.close();
    throw error;
  }
}

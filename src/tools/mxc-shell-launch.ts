// Prepare invocation-scoped container launch resources; release the proxy only after the launcher and its job have exited.
// This prevents surviving processes from reaching a port reused by another invocation.
import { win32 as winPath } from "node:path";
import { windowsSystemRoot } from "../shared/windows-system-path.js";

import { getProtectedReadDenyFloor } from "../permissions/asrt-sandbox.js";
import {
  openInvocationProxyListener,
  type InvocationProxyListener,
} from "../permissions/egress-invocation-listener.js";
import { openHostEgressListener } from "../permissions/egress-host-listener.js";
import {
  buildMxcShellRequest,
  mxcRequestArgs,
  rankMxcFilesystem,
  resolveHostWxcExecPath,
  type ShellFilesystemPolicy,
} from "../permissions/mxc-windows.js";

export interface MxcShellLaunch {
  /** `wxc-exec.exe` followed by its arguments; spawn with `shell: false`. */
  readonly argv: readonly string[];
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
  const wxcExec = await resolveHostWxcExecPath();
  if (!input.exists(wxcExec)) {
    throw new Error(`Microsoft Execution Containers launcher is missing: ${wxcExec}`);
  }
  const grants = rankMxcFilesystem({ ...input.filesystem, protectedFloor: getProtectedReadDenyFloor() }, input.exists);
  let listener: InvocationProxyListener | undefined;
  const relay = await openHostEgressListener(input.egressToken);
  try {
    listener = await openInvocationProxyListener({
      upstream: () => ({ host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }),
      onRefused: relay.recordRefusal,
    });
    relay.registerPort(listener.port);
    const systemRoot = windowsSystemRoot();
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
      release: async () => {
        try {
          await opened.close();
        } finally {
          await relay.close();
        }
      },
    };
  } catch (error) {
    try {
      await listener?.close();
    } finally {
      await relay.close();
    }
    throw error;
  }
}

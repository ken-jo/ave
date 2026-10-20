/**
 * Which identity strength a confined process's egress has on this host, per
 * kind of process (`EgressIdentityStrength`, `maxEgressGrantScope` in
 * `shared/sandbox-capability-info.ts`, shared with the Windows MXC path).
 *
 *   - macOS, Linux: `"kernel-channel"` for every kind. Each wrap gets its own
 *     ASRT proxy listener (`SandboxManager.openInvocationListener`, bun patch
 *     part 3) that its sandbox alone can reach: Seatbelt pins the port, bwrap
 *     binds the socket path. The ask callback then hears
 *     `identity: "listener"` and refuses anything else.
 *   - win32: shared unless a shell request arrived through its host-owned
 *     invocation relay. Terminals and username requests remain shared.
 */
import type { EgressIdentityStrength } from "../shared/sandbox-capability-info.js";

/** Whether ASRT opens a per-invocation listener on this platform. */
export function asrtInvocationListenersSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

let macUnixSocketsOpen = false;

/**
 * Record the session's `network.allowAllUnixSockets` (set at sandbox init).
 * On macOS it lets a sandboxed process open any Unix socket, the proxy's own
 * backend sockets included, so the listener no longer identifies an
 * invocation by itself. (Linux wraps hide the proxy's socket directory
 * whatever that flag says, so it does not matter there.)
 */
export function noteAsrtUnixSocketPolicy(allowAllUnixSockets: boolean): void {
  macUnixSocketsOpen = allowAllUnixSockets && process.platform === "darwin";
}

/** Identity strength for a runtime-produced ask context; never pass client-provided identity. */
export function egressIdentityStrength(
  kind: "shell" | "extension",
  context?: { readonly identity?: "listener" | "username" },
): EgressIdentityStrength {
  if (process.platform === "win32" && kind === "shell" && context?.identity === "listener") return "kernel-channel";
  return asrtInvocationListenersSupported() && !macUnixSocketsOpen ? "kernel-channel" : "shared";
}

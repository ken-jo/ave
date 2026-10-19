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
 *   - Windows: `"shared"` here (srt-win: one account, one proxy, the identity
 *     is the proxy username), which caps grants at "This conversation". The
 *     MXC path (proxy-egress PR 9) gives shells their own endpoint and sets
 *     `shellEgressIdentity` per boot; whichever of the two PRs merges second
 *     sources the win32 shell answer from that substrate, and must make an
 *     MXC shell's connections reach the callback as `identity: "listener"`
 *     (or relax the listener check for that substrate) — a `"kernel-channel"`
 *     shell whose connections arrive as `"username"` is refused.
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

/** The identity strength of one kind of confined process on this host. */
export function egressIdentityStrength(kind: "shell" | "extension"): EgressIdentityStrength {
  void kind;
  return asrtInvocationListenersSupported() && !macUnixSocketsOpen ? "kernel-channel" : "shared";
}

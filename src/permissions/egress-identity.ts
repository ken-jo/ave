// On macOS/Linux, each sandbox reaches only its own kernel-bound listener and asks must vouch for listener identity. Windows identity stays shared except for host-owned shell relays; terminals and client usernames remain shared.
import type { EgressIdentityStrength } from "../shared/sandbox-capability-info.js";

// Whether ASRT opens a per-invocation listener on this platform.
export function asrtInvocationListenersSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

let macUnixSocketsOpen = false;

// Record the session's `network.allowAllUnixSockets` (set at sandbox init). On macOS it lets a sandboxed process open any Unix socket, the proxy's own backend sockets included, so the listener no longer identifies an invocation by itself. (Linux wraps hide the proxy's socket directory whatever that flag says, so it does not matter there.)
export function noteAsrtUnixSocketPolicy(allowAllUnixSockets: boolean): void {
  macUnixSocketsOpen = allowAllUnixSockets && process.platform === "darwin";
}

// Identity strength for a runtime-produced ask context; never pass client-provided identity.
export function egressIdentityStrength(
  kind: "shell" | "extension",
  context?: { readonly identity?: "listener" | "username" },
): EgressIdentityStrength {
  if (process.platform === "win32" && kind === "shell" && context?.identity === "listener") return "kernel-channel";
  return asrtInvocationListenersSupported() && !macUnixSocketsOpen ? "kernel-channel" : "shared";
}

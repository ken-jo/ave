/**
 * The single capability flag the egress ask reads to decide which grant
 * scopes an attribution can carry. The Windows MXC writer flips win32 to
 * `"kernel-channel"` here once each invocation gets its own proxy endpoint.
 */

/**
 * How strongly a proxy connection's attribution identifies the invocation
 * that opened it, on this host:
 *   - `"kernel-channel"` (macOS, Linux): each invocation has its own proxy
 *     listener that its sandbox profile alone can reach (Seatbelt pins the
 *     port; bwrap binds the socket path), so the identity cannot be borrowed
 *     by another invocation. Every grant scope is offered.
 *   - `"shared"` (Windows, srt-win): every sandboxed process shares one
 *     account and one port range, so the identity is the proxy username,
 *     which another invocation can present. Grants are capped at "This
 *     conversation" until the MXC path, which gives each invocation its own
 *     proxy endpoint, sets `"kernel-channel"` here.
 */
export type EgressIdentityStrength = "kernel-channel" | "shared";

export function egressIdentityStrength(): EgressIdentityStrength {
  return process.platform === "darwin" || process.platform === "linux" ? "kernel-channel" : "shared";
}

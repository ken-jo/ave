import { refreshRemoteControllerBoundToSession, isRemoteControllerBoundToSession } from "../shared/chat-origin.js";
import { currentEffectGateContext } from "../permissions/effect-enforcement.js";
import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { withHostShellExecutionHandoff, type HostShellSpawnAuthorization } from "../permissions/host-shell-execution-permit.js";

/** Private fd 3 belongs to the prelude and is closed before user code runs. */
export function attachHostShellControlChannel(
  child: ChildProcess,
  authorization: HostShellSpawnAuthorization,
): { readonly rejected: boolean; dispose(): void } {
  const gate = currentEffectGateContext();
  const authority = gate?.permissionContext?.remoteControllerAuthority;
  const sessionId = gate?.sessionId;
  const channel = child.stdio[3] as Duplex | null | undefined;
  let state: "waiting" | "validating" | "granted" | "rejected" = "waiting";
  const reject = (): void => {
    if (state === "granted" || state === "rejected") return;
    state = "rejected";
    if (channel !== null && channel !== undefined && !channel.destroyed && channel.writable) channel.end("D");
  };
  if (channel === null || channel === undefined) {
    state = "rejected";
  } else {
    channel.on("data", (data: Buffer) => {
      if (state !== "waiting" || data.toString("ascii") !== "R") {
        reject();
        return;
      }
      state = "validating";
      void withHostShellExecutionHandoff(authorization, () => {
        if (!isRemoteControllerBoundToSession(authority, sessionId)) return false;
        if (state !== "validating" || channel.destroyed || !channel.writable || child.exitCode !== null) return false;
        channel.end("G");
        state = "granted";
        return true;
      }, async () => { if (!await refreshRemoteControllerBoundToSession(authority, sessionId)) throw new Error("remote-controller-revoked"); }).then((granted) => { if (granted !== true) reject(); }, reject);
    });
    channel.on("end", reject);
    channel.on("error", () => { state = "rejected"; });
  }
  return {
    get rejected() { return state !== "granted"; },
    dispose() {
      reject();
      channel?.destroy();
    },
  };
}

import { refreshRemoteControllerBoundToSession, isRemoteControllerBoundToSession } from "../shared/chat-origin.js";
import { currentEffectGateContext } from "../permissions/effect-enforcement.js";
import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { withHostShellExecutionHandoff, type HostShellSpawnAuthorization } from "../permissions/host-shell-execution-permit.js";

/** Private fd 3 belongs to the prelude and is closed before user code runs. */
export function attachHostShellControlChannel(
  child: ChildProcess,
  authorization: HostShellSpawnAuthorization,
  signal?: AbortSignal,
): { readonly rejected: boolean; readonly ready: Promise<boolean>; dispose(): void } {
  const gate = currentEffectGateContext();
  const authority = gate?.permissionContext?.remoteControllerAuthority;
  const sessionId = gate?.sessionId;
  const channel = child.stdio[3] as Duplex | null | undefined;
  let state: "waiting" | "validating" | "granted" | "rejected" = "waiting";
  let finish!: (granted: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { finish = resolve; });
  const reject = (): void => {
    if (state === "granted" || state === "rejected") return;
    state = "rejected";
    signal?.removeEventListener("abort", reject);
    finish(false);
    if (channel !== null && channel !== undefined && !channel.destroyed && channel.writable) channel.end("D");
  };
  if (channel === null || channel === undefined) {
    reject();
  } else {
    signal?.addEventListener("abort", reject, { once: true });
    if (signal?.aborted) reject();
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
        signal?.removeEventListener("abort", reject);
        finish(true);
        return true;
      }, async () => { if (!await refreshRemoteControllerBoundToSession(authority, sessionId)) throw new Error("remote-controller-revoked"); }).then((granted) => { if (granted !== true) reject(); }, reject);
    });
    channel.on("end", reject);
    channel.on("error", reject);
    child.once("close", reject);
  }
  return {
    get rejected() { return state !== "granted"; },
    ready,
    dispose() {
      reject();
      channel?.destroy();
    },
  };
}

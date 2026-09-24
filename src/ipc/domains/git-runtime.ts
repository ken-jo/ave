/**
 * Host-renderer-only IPC for the git marketplace's git runtime (design §9, §13).
 * Covers: ave:git:runtime:* and the git-runtime:progress event.
 *
 * `install` downloads a binary the marketplace then runs, so it carries a live
 * keyboard intent like every other "run this for me" decision. The download
 * goes through the marketplace network gate under the current system policy,
 * on the PAC-aware single-hop transport.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { GitRuntimeService, gitRuntimeRoot } from "../../marketplace/git/runtime-service.js";
import { NetworkGate } from "../../marketplace/net/network-gate.js";
import { loadMarketplacePolicy } from "../../marketplace/sources/policy.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import type { GitRuntimeProgress, GitRuntimeResult } from "../../shared/git-runtime.js";
import { aveHome } from "../../shared/ave-home.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

type GitRuntimePort = Pick<GitRuntimeService, "status" | "install">;

function createGitRuntimeService(deps: IpcDeps): GitRuntimeService {
  const broadcast = (progress: GitRuntimeProgress) => {
    for (const window of deps.getAppWindows?.() ?? [deps.getMainWindow()]) {
      if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.gitRuntime.progress, progress);
    }
  };
  return new GitRuntimeService({
    runtimeRoot: gitRuntimeRoot(aveHome()),
    mode: () => deps.settingsService.get("marketplace").git?.mode ?? "auto",
    download: async (url, signal) => {
      // Read per install: a policy file changed by device management applies to the next download.
      const gate = new NetworkGate({ policy: await loadMarketplacePolicy(), allowLoopback: false });
      return gate.fetch(url, { fetchImpl: deps.singleHopNetworkFetch, official: true, ...(signal ? { signal } : {}) });
    },
    onProgress: broadcast,
  });
}

export function registerGitRuntimeHandlers(deps: IpcDeps, service: GitRuntimePort = createGitRuntimeService(deps)): void {
  ipcMain.handle(CHANNELS.gitRuntime.status, async (event): Promise<GitRuntimeResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.gitRuntime.status, event);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true, status: await service.status() };
  });

  ipcMain.handle(CHANNELS.gitRuntime.install, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.gitRuntime.install, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    return { ok: true, status: await service.install() } satisfies GitRuntimeResult;
  });
}

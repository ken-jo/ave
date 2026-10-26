// Runtime installation requires keyboard intent and the marketplace network gate before executing downloaded code.
import { ipcMain, session } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { getMarketplaceLifetime } from "../../main/app-state.js";
import { whileRunning } from "../../marketplace/app/background.js";
import { scrubMarketplaceStrings } from "../../marketplace/errors.js";
import { GitRuntimeService, gitRuntimeRoot } from "../../marketplace/git/runtime-service.js";
import { NetworkGate } from "../../marketplace/net/network-gate.js";
import { createPinnedFetch } from "../../marketplace/net/pinned-fetch.js";
import { FilePolicySource } from "../../marketplace/sources/policy.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import type { GitRuntimeProgress, GitRuntimeResult } from "../../shared/git-runtime.js";
import { aveHome } from "../../shared/ave-home.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { broadcastToAppWindows } from "../window-fanout.js";

type GitRuntimePort = Pick<GitRuntimeService, "status" | "install">;

// Progress broadcasts stop at marketplace shutdown even if installation continues.
export function gitRuntimeProgressSender(deps: IpcDeps, shutdown: AbortSignal): (progress: GitRuntimeProgress) => void {
  return whileRunning(shutdown)((progress: GitRuntimeProgress) => {
    // Scrub install failures because they may quote proxy or download addresses.
    broadcastToAppWindows(deps, CHANNELS.gitRuntime.progress, scrubMarketplaceStrings(progress));
  });
}

function createGitRuntimeService(deps: IpcDeps): GitRuntimeService {
  return new GitRuntimeService({
    runtimeRoot: gitRuntimeRoot(aveHome()),
    mode: () => deps.settingsService.get("marketplace").git?.mode ?? "auto",
    download: async (url, signal) => {
      // Re-read device policy for every install.
      const transport = createPinnedFetch({ resolveProxy: (target) => session.defaultSession.resolveProxy(target) });
      const gate = new NetworkGate({ policy: await FilePolicySource.open(), allowLoopback: false, transport });
      return gate.fetch(url, { catalog: null, official: true, ...(signal ? { signal } : {}) });
    },
    onProgress: gitRuntimeProgressSender(deps, getMarketplaceLifetime().signal),
  });
}

export function registerGitRuntimeHandlers(deps: IpcDeps, service: GitRuntimePort = createGitRuntimeService(deps)): void {
  ipcMain.handle(CHANNELS.gitRuntime.status, async (event): Promise<GitRuntimeResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.gitRuntime.status, event);
      return UNAUTHORIZED_FRAME;
    }
    // Scrub executable paths and failure text before returning status.
    return { ok: true, status: scrubMarketplaceStrings(await service.status()) };
  });

  ipcMain.handle(CHANNELS.gitRuntime.install, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.gitRuntime.install, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    return { ok: true, status: scrubMarketplaceStrings(await service.install()) } satisfies GitRuntimeResult;
  });
}

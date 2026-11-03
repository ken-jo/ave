// Read-only: which git the marketplace would run. The installer provides it, so nothing is installed here.
import { app, ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { scrubMarketplaceStrings } from "../../marketplace/errors.js";
import { installerGitRoot } from "../../marketplace/git/installer-git.js";
import { detectGitRuntime, gitRuntimeStatus, nodeGitDetectionDeps } from "../../marketplace/git/detect.js";
import type { GitRuntimeResult, GitRuntimeStatus } from "../../shared/git-runtime.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

type ReadGitRuntimeStatus = () => Promise<GitRuntimeStatus>;

async function readGitRuntimeStatus(): Promise<GitRuntimeStatus> {
  const root = installerGitRoot(app.isPackaged);
  return gitRuntimeStatus(await detectGitRuntime(nodeGitDetectionDeps(root)), root !== null);
}

export function registerGitRuntimeHandlers(deps: IpcDeps, readStatus: ReadGitRuntimeStatus = readGitRuntimeStatus): void {
  ipcMain.handle(CHANNELS.gitRuntime.status, async (event): Promise<GitRuntimeResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.gitRuntime.status, event);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true, status: scrubMarketplaceStrings(await readStatus()) };
  });
}

/** Read-only git runtime status for the host renderer. */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import { parseGitRuntimeResult, type GitRuntimeApi, type GitRuntimeResult } from "../shared/git-runtime.js";

const UNAVAILABLE: GitRuntimeResult = Object.freeze({ ok: false, error: "git-runtime-unavailable" });

export function buildGitRuntimeApiSurface(): GitRuntimeApi {
  return Object.freeze({
    async status(): Promise<GitRuntimeResult> {
      try {
        return parseGitRuntimeResult(await ipcRenderer.invoke(CHANNELS.gitRuntime.status)) ?? UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  });
}

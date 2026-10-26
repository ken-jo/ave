/** Keep runtime installation host-only and mint its keyboard intent in preload. */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseGitRuntimeProgress,
  parseGitRuntimeResult,
  type GitRuntimeApi,
  type GitRuntimeProgress,
  type GitRuntimeResult,
} from "../shared/git-runtime.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

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

    async install(): Promise<GitRuntimeResult> {
      try {
        return parseGitRuntimeResult(
          await ipcRenderer.invoke(CHANNELS.gitRuntime.install, { intent: ipcUserKeyboardIntent() }),
        ) ?? UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    onProgress(listener: (progress: GitRuntimeProgress) => void): () => void {
      const handler = (_event: unknown, payload: unknown) => {
        const progress = parseGitRuntimeProgress(payload);
        if (progress) listener(progress);
      };
      ipcRenderer.on(CHANNELS.gitRuntime.progress, handler);
      return () => ipcRenderer.removeListener(CHANNELS.gitRuntime.progress, handler);
    },
  });
}

import { CHANNELS } from "../contract/app-contract.js";
import type { IpcDeps } from "./types.js";
import { broadcastToAppWindows } from "./window-fanout.js";

export function broadcastPromptsUpdated(deps: IpcDeps): void {
  broadcastToAppWindows(deps, CHANNELS.prompts.updated);
}

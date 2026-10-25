/** Expose only to host renderers and mint live keyboard intent locally; callers cannot supply or replay it. */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseAwayAuthorityMutationResult,
  parseAwayAuthorityStatusResult,
  type AwayAuthorityBudgetPreset,
  type AwayAuthorityDurationPreset,
  type AwayAuthorityMode,
  type AwayAuthorityMutationResult,
  type AwayAuthorityOwnerApi,
  type AwayAuthorityStatusResult,
} from "../shared/away-authority-arm.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

function unavailableMutation(): AwayAuthorityMutationResult {
  return Object.freeze({ ok: false, error: "away-authority-unavailable" });
}

function unavailableStatus(): AwayAuthorityStatusResult {
  return Object.freeze({ ok: false, error: "away-authority-unavailable" });
}

async function invokeMutation(
  channel: string,
  payload: unknown,
): Promise<AwayAuthorityMutationResult> {
  try {
    return parseAwayAuthorityMutationResult(await ipcRenderer.invoke(channel, payload))
      ?? unavailableMutation();
  } catch {
    return unavailableMutation();
  }
}

export function buildAwayAuthorityApiSurface(): AwayAuthorityOwnerApi {
  return Object.freeze({
    async status(): Promise<AwayAuthorityStatusResult> {
      try {
        return parseAwayAuthorityStatusResult(
          await ipcRenderer.invoke(CHANNELS.awayAuthority.status),
        ) ?? unavailableStatus();
      } catch {
        return unavailableStatus();
      }
    },

    arm(input: {
      chatGroupId: string;
      mode: AwayAuthorityMode;
      directories: readonly string[];
      duration: AwayAuthorityDurationPreset;
      budget: AwayAuthorityBudgetPreset;
    }): Promise<AwayAuthorityMutationResult> {
      return invokeMutation(CHANNELS.awayAuthority.arm, {
        chatGroupId: input.chatGroupId,
        mode: input.mode,
        // Rebuild context-bridged arrays so subclasses and extra keys cannot bypass main's exact shape guard.
        directories: [...input.directories],
        duration: input.duration,
        budget: input.budget,
        intent: ipcUserKeyboardIntent(),
      });
    },

    disarm(): Promise<AwayAuthorityMutationResult> {
      return invokeMutation(CHANNELS.awayAuthority.disarm, {
        intent: ipcUserKeyboardIntent(),
      });
    },
  });
}

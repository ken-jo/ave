/** Mint host-only mutation intent locally. Tokens have no readback; pairing codes appear once and are short-lived and attempt-limited. */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseTelegramConnectionMutationResult,
  parseTelegramConnectionSnapshotResult,
  parseTelegramCreatePairingCodeResult,
  type TelegramApprovalDurationPreset,
  type TelegramConnectionMutationResult,
  type TelegramConnectionOwnerApi,
  type TelegramConnectionSnapshotResult,
  type TelegramCreatePairingCodeResult,
} from "../shared/telegram-connection.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

function unavailableMutation(): TelegramConnectionMutationResult {
  return Object.freeze({ ok: false, error: "telegram-connection-unavailable" });
}

function unavailableSnapshot(): TelegramConnectionSnapshotResult {
  return Object.freeze({ ok: false, error: "telegram-connection-unavailable" });
}

function unavailablePairingCode(): TelegramCreatePairingCodeResult {
  return Object.freeze({ ok: false, error: "telegram-connection-unavailable" });
}

async function invokeMutation(
  channel: string,
  payload: unknown,
): Promise<TelegramConnectionMutationResult> {
  try {
    return parseTelegramConnectionMutationResult(await ipcRenderer.invoke(channel, payload))
      ?? unavailableMutation();
  } catch {
    return unavailableMutation();
  }
}

function intentOnly(channel: string): Promise<TelegramConnectionMutationResult> {
  return invokeMutation(channel, { intent: ipcUserKeyboardIntent() });
}

export function buildTelegramConnectionApiSurface(): TelegramConnectionOwnerApi {
  return Object.freeze({
    async snapshot(): Promise<TelegramConnectionSnapshotResult> {
      try {
        return parseTelegramConnectionSnapshotResult(
          await ipcRenderer.invoke(CHANNELS.telegramConnection.snapshot),
        ) ?? unavailableSnapshot();
      } catch {
        return unavailableSnapshot();
      }
    },

    connect(botToken: string): Promise<TelegramConnectionMutationResult> {
      return invokeMutation(CHANNELS.telegramConnection.connect, {
        botToken,
        intent: ipcUserKeyboardIntent(),
      });
    },

    setOwnerUserId(ownerUserId: string): Promise<TelegramConnectionMutationResult> {
      return invokeMutation(CHANNELS.telegramConnection.setOwnerUserId, { ownerUserId, intent: ipcUserKeyboardIntent() });
    },

    disconnect(): Promise<TelegramConnectionMutationResult> {
      return intentOnly(CHANNELS.telegramConnection.disconnect);
    },

    pause(): Promise<TelegramConnectionMutationResult> {
      return intentOnly(CHANNELS.telegramConnection.pause);
    },

    resume(): Promise<TelegramConnectionMutationResult> {
      return intentOnly(CHANNELS.telegramConnection.resume);
    },

    async createPairingCode(): Promise<TelegramCreatePairingCodeResult> {
      try {
        return parseTelegramCreatePairingCodeResult(
          await ipcRenderer.invoke(CHANNELS.telegramConnection.createPairingCode, {
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailablePairingCode();
      } catch {
        return unavailablePairingCode();
      }
    },

    revokePairing(id: string): Promise<TelegramConnectionMutationResult> {
      return invokeMutation(CHANNELS.telegramConnection.revokePairing, {
        id,
        intent: ipcUserKeyboardIntent(),
      });
    },

    approveCurrentConversation(
      duration?: TelegramApprovalDurationPreset,
    ): Promise<TelegramConnectionMutationResult> {
      const payload = duration === undefined
        ? { intent: ipcUserKeyboardIntent() }
        : { duration, intent: ipcUserKeyboardIntent() };
      return invokeMutation(CHANNELS.telegramConnection.approveCurrentConversation, payload);
    },

    revokeApproval(id: string): Promise<TelegramConnectionMutationResult> {
      return invokeMutation(CHANNELS.telegramConnection.revokeApproval, {
        id,
        intent: ipcUserKeyboardIntent(),
      });
    },

    onChanged(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on(CHANNELS.telegramConnection.changed, listener);
      return () => ipcRenderer.removeListener(CHANNELS.telegramConnection.changed, listener);
    },
  });
}

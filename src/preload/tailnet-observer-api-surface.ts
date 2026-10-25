/** Keep observer configuration host-only and mint apply intent locally. */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseTailnetGuidedSetupResult,
  parseTailnetObserverMutationResult,
  parseTailnetObserverSnapshotResult,
  parseTailnetServeResult,
  type TailnetGuidedSetupResult,
  type TailnetObserverConfigApi,
  type TailnetObserverConfigView,
  type TailnetObserverMutationResult,
  type TailnetObserverSnapshotResult,
  type TailnetServeResult,
} from "../shared/tailnet-observer-config.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

function unavailableSnapshot(): TailnetObserverSnapshotResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable" });
}

function unavailableMutation(): TailnetObserverMutationResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable" });
}

function unavailableServe(): TailnetServeResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable", output: null });
}

function unavailableGuidedSetup(): TailnetGuidedSetupResult {
  return Object.freeze({ ok: false, error: "tailnet-observer-unavailable", output: null });
}

export function buildTailnetObserverApiSurface(): TailnetObserverConfigApi {
  return Object.freeze({
    async snapshot(): Promise<TailnetObserverSnapshotResult> {
      try {
        return parseTailnetObserverSnapshotResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.snapshot),
        ) ?? unavailableSnapshot();
      } catch {
        return unavailableSnapshot();
      }
    },

    async apply(config: TailnetObserverConfigView): Promise<TailnetObserverMutationResult> {
      try {
        return parseTailnetObserverMutationResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.apply, {
            config,
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailableMutation();
      } catch {
        return unavailableMutation();
      }
    },

    async configureServe(): Promise<TailnetServeResult> {
      try {
        return parseTailnetServeResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.configureServe, {
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailableServe();
      } catch {
        return unavailableServe();
      }
    },

    async guidedSetup(): Promise<TailnetGuidedSetupResult> {
      try {
        return parseTailnetGuidedSetupResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.guidedSetup, {
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailableGuidedSetup();
      } catch {
        return unavailableGuidedSetup();
      }
    },

    async setOwnDeviceAdmission(enabled: boolean): Promise<TailnetObserverMutationResult> {
      try {
        return parseTailnetObserverMutationResult(
          await ipcRenderer.invoke(CHANNELS.tailnetObserver.setOwnDeviceAdmission, {
            enabled,
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailableMutation();
      } catch {
        return unavailableMutation();
      }
    },
  });
}

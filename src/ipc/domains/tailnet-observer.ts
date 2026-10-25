// Observer configuration and apply require local host authority; the host validates and persists all proposals.
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import {
  parseTailnetObserverConfigView,
  parseTailnetObserverSnapshot,
} from "../../shared/tailnet-observer-config.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { isRecord } from "../../shared/is-record.js";

const DISABLED = Object.freeze({
  ok: false as const,
  error: "tailnet-observer-unavailable" as const,
});
const INPUT_INVALID = Object.freeze({
  ok: false as const,
  error: "tailnet-observer-input-invalid" as const,
});
const UNAVAILABLE = Object.freeze({
  ok: false as const,
  error: "tailnet-observer-unavailable" as const,
});

// Preserve stable resolver codes so the renderer can explain listener unavailability.
function rejection(err: unknown): { ok: false; error: string } {
  const code = err instanceof Error ? err.message : "";
  return Object.freeze({
    ok: false as const,
    error: /^[a-z0-9-]+$/.test(code) ? code : "tailnet-observer-write-failed",
  });
}

export function registerTailnetObserverHandlers(deps: IpcDeps): void {
  const service = deps.tailnetObserverConfigService;

  ipcMain.handle(CHANNELS.tailnetObserver.snapshot, async (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetObserver.snapshot, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    try {
      const snapshot = parseTailnetObserverSnapshot(await service.snapshot());
      return snapshot === null ? UNAVAILABLE : { ok: true as const, snapshot };
    } catch (err) {
      return rejection(err);
    }
  });

  ipcMain.handle(CHANNELS.tailnetObserver.apply, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetObserver.apply, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    const config = isRecord(payload) ? parseTailnetObserverConfigView(payload.config) : null;
    if (config === null) return INPUT_INVALID;
    try {
      await service.apply(config);
      return { ok: true as const };
    } catch (err) {
      return rejection(err);
    }
  });

  // Derive executable and port from host probes; renderer targets must never publish arbitrary listeners.
  ipcMain.handle(CHANNELS.tailnetObserver.configureServe, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetObserver.configureServe, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    try {
      return await service.configureServe();
    } catch (err) {
      return { ...rejection(err), output: null };
    }
  });

  // Quick setup requires both apply and command authority and derives all configuration in the host.
  ipcMain.handle(CHANNELS.tailnetObserver.guidedSetup, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetObserver.guidedSetup, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    try {
      return await service.guidedSetup();
    } catch (err) {
      return { ...rejection(err), output: null };
    }
  });

  // Accept only the boolean choice; derive own-account identity from the desktop probe.
  ipcMain.handle(CHANNELS.tailnetObserver.setOwnDeviceAdmission, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetObserver.setOwnDeviceAdmission, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isRecord(payload) || typeof payload.enabled !== "boolean") return INPUT_INVALID;
    try {
      await service.setOwnDeviceAdmission(payload.enabled);
      return { ok: true as const };
    } catch (err) {
      return rejection(err);
    }
  });
}

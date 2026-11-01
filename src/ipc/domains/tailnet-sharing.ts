import { TailnetOwnerIdentityError } from "../../main/tailnet-owner-identity.js";
// Pairing and sharing mutations require live local keyboard intent and a main-owned active conversation.
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import {
  isTailnetSharingActivatePairingInput,
  isTailnetSharingCreateCurrentConversationShareInput,
  isTailnetSharingCreateInvitationInput,
  isTailnetSharingRevokeInput,
  parseTailnetSharingCreatedInvitation,
  parseTailnetSharingSnapshot,
} from "../../shared/tailnet-sharing.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";

const DISABLED = Object.freeze({ ok: false as const, error: "tailnet-sharing-disabled" as const });
const INPUT_INVALID = Object.freeze({ ok: false as const, error: "tailnet-sharing-input-invalid" as const });
const OPERATION_REJECTED = Object.freeze({
  ok: false as const,
  error: "tailnet-sharing-operation-rejected" as const,
});
const UNAVAILABLE = Object.freeze({ ok: false as const, error: "tailnet-sharing-unavailable" as const });

// Broadcast only a refetch hint; invitation and share data remain out of events.
function broadcastTailnetSharingChanged(deps: IpcDeps): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const window of windows) {
    sendToWindow(window, CHANNELS.tailnetSharing.changed, {});
  }
}

export function registerTailnetSharingHandlers(deps: IpcDeps): void {
  const owner = deps.tailnetSharingOwnerService;
  if (owner) {
    owner.subscribe(() => {
      broadcastTailnetSharingChanged(deps);
    });
  }

  ipcMain.handle(CHANNELS.tailnetSharing.snapshot, async (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.snapshot, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    try {
      const snapshot = parseTailnetSharingSnapshot(await owner.snapshot());
      return snapshot === null
        ? UNAVAILABLE : { ok: true as const, snapshot };
    } catch {
      return UNAVAILABLE;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.createInvitation, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.createInvitation, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isTailnetSharingCreateInvitationInput(payload)) return INPUT_INVALID;
    try {
      const invitation = parseTailnetSharingCreatedInvitation(
        await owner.createInvitation(payload.duration),
      );
      return invitation === null
        ? OPERATION_REJECTED : { ok: true as const, invitation };
    } catch (error) {
      if (error instanceof TailnetOwnerIdentityError) return { ok: false as const, error: error.code };
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.activatePairing, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.activatePairing, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isTailnetSharingActivatePairingInput(payload)) return INPUT_INVALID;
    try {
      return await owner.activatePairing(payload.id)
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch (error) {
      if (error instanceof TailnetOwnerIdentityError) return { ok: false as const, error: error.code };
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.createCurrentConversationShare, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.createCurrentConversationShare, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isTailnetSharingCreateCurrentConversationShareInput(payload)) return INPUT_INVALID;
    try {
      return await owner.createCurrentConversationShare(
        payload.pairingId,
        payload.permission,
        payload.duration,
      )
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch (error) {
      if (error instanceof TailnetOwnerIdentityError) return { ok: false as const, error: error.code };
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.revokeShare, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.revokeShare, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isTailnetSharingRevokeInput(payload)) return INPUT_INVALID;
    try {
      return await owner.revokeShare(payload.id)
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch (error) {
      if (error instanceof TailnetOwnerIdentityError) return { ok: false as const, error: error.code };
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.revokePairing, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.revokePairing, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isTailnetSharingRevokeInput(payload)) return INPUT_INVALID;
    try {
      return await owner.revokePairing(payload.id)
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch (error) {
      if (error instanceof TailnetOwnerIdentityError) return { ok: false as const, error: error.code };
      return OPERATION_REJECTED;
    }
  });
}

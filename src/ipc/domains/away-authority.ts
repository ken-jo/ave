// Arming requires a host frame, live keyboard intent, and a main-resolved tile conversation.
// Register disabled channels too, returning a stable refusal when no approval gate exists.
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntentPayload, USER_KEYBOARD_REQUIRED } from "../../shared/chat-origin.js";
import {
  isAwayAuthorityArmInput,
  isAwayAuthorityIntentOnlyInput,
  parseAwayAuthorityStatus,
  type AwayAuthorityDurationPreset,
  type AwayAuthorityMode,
} from "../../shared/away-authority-arm.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

const DISABLED = Object.freeze({
  ok: false as const,
  error: "away-authority-disabled" as const,
});
const INPUT_INVALID = Object.freeze({
  ok: false as const,
  error: "away-authority-input-invalid" as const,
});
const OPERATION_REJECTED = Object.freeze({
  ok: false as const,
  error: "away-authority-operation-rejected" as const,
});
const UNAVAILABLE = Object.freeze({
  ok: false as const,
  error: "away-authority-unavailable" as const,
});
const NOTHING_ARMED = Object.freeze({ ok: true as const, status: null });
const ARMED_OK = Object.freeze({ ok: true as const });

// Preset durations remain within the grant parser's lifetime ceiling.
const DURATION_MS: Record<AwayAuthorityDurationPreset, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

// Read-write includes reads to avoid stalling unattended writes; the grant parser still owns armable categories.
const MODE_CATEGORIES: Record<AwayAuthorityMode, readonly string[]> = {
  "read-only": ["read"],
  "read-write": ["read", "write"],
};

export function registerAwayAuthorityHandlers(deps: IpcDeps): void {
  ipcMain.handle(CHANNELS.awayAuthority.status, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.awayAuthority.status, event);
      return UNAUTHORIZED_FRAME;
    }
    const gate = deps.approvalGate;
    if (!gate) return DISABLED;
    try {
      const snapshot = gate.awayAuthoritySnapshot();
      if (snapshot === null) return NOTHING_ARMED;
      // Hide expired grants at read time without retiring them as a user-initiated disarm.
      if (Date.now() >= snapshot.expiresAt) return NOTHING_ARMED;
      const status = parseAwayAuthorityStatus({
        writable: snapshot.categories.includes("write"),
        directories: [...snapshot.directories],
        expiresAt: snapshot.expiresAt,
        remaining: snapshot.remaining,
      });
      return status === null ? UNAVAILABLE : { ok: true as const, status };
    } catch {
      return UNAVAILABLE;
    }
  });

  ipcMain.handle(CHANNELS.awayAuthority.arm, (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.awayAuthority.arm, event);
      return UNAUTHORIZED_FRAME;
    }
    const gate = deps.approvalGate;
    if (!gate) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isAwayAuthorityArmInput(payload)) return INPUT_INVALID;
    try {
      // Resolve the tile's conversation in main; the renderer cannot supply it.
      const loop = deps.findChatGroupLoop(payload.chatGroupId);
      if (!loop) return OPERATION_REJECTED;
      const conversationId = loop.getSessionId();
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        return OPERATION_REJECTED;
      }
      return gate.armAwayAuthority({
        conversationId,
        categories: MODE_CATEGORIES[payload.mode],
        directories: payload.directories,
        ttlMs: DURATION_MS[payload.duration],
        budget: payload.budget,
      })
        ? ARMED_OK
        : OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.awayAuthority.disarm, (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.awayAuthority.disarm, event);
      return UNAUTHORIZED_FRAME;
    }
    const gate = deps.approvalGate;
    if (!gate) return DISABLED;
    if (!hasUserKeyboardIntentPayload(payload)) return USER_KEYBOARD_REQUIRED;
    if (!isAwayAuthorityIntentOnlyInput(payload)) return INPUT_INVALID;
    try {
      // Disarming an already unarmed authority succeeds idempotently.
      gate.retireAwayAuthority("desk-disarm");
      return ARMED_OK;
    } catch {
      return OPERATION_REJECTED;
    }
  });
}

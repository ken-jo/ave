// Retire grants when share identity changes, including revoke, pause, disconnect, or re-pair. Poll offsets also emit document changes; compare the share
// tuple so ordinary inbound traffic cannot retire its own grant.
import { canonicalStringify } from "../shared/canonical-json.js";
import type { TelegramOwnerConnectionSnapshot } from "./telegram-connection-store.js";

// Unreadable share state has a distinct identity; transitions revoke existing grants rather than letting authority outlive its proof.
const UNREADABLE_SHARE = "unreadable";

// Share identity includes desired state, activation epoch, bot, pairing/account identity, and approval/conversation identity.
// Exclude poll offsets, transient errors, unredeemed codes, and derived pairing flags; canonical encoding prevents delimiter ambiguity.
function telegramShareIdentity(
  owner: TelegramOwnerConnectionSnapshot,
): string {
  return canonicalStringify({
    desiredState: owner.desiredState,
    activationEpoch: owner.activationEpoch,
    botFingerprint: owner.botFingerprint,
    pairingId: owner.pairing?.id ?? null,
    pairingAccount: owner.pairing?.accountFingerprint ?? null,
    approvalId: owner.approval?.id ?? null,
    approvalConversation: owner.approval?.conversationDigest ?? null,
  });
}

// Capture the baseline at subscriber construction so the first notification is compared with real share state.
export function createTelegramShareChangeWatcher(options: {
  readonly readOwnerSnapshot: () => TelegramOwnerConnectionSnapshot;
  readonly onShareChanged: () => void;
}): () => void {
  const read = (): string => {
    try {
      return telegramShareIdentity(options.readOwnerSnapshot());
    } catch {
      return UNREADABLE_SHARE;
    }
  };
  let last = read();
  return () => {
    const current = read();
    if (current === last) return;
    last = current;
    options.onShareChanged();
  };
}

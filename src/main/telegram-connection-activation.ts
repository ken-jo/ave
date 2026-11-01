import type { SecretEncryption } from "../data/secret-document-store.js";
// Read encrypted credentials at activation time instead of holding them in longer-lived connection state.
import type { SecretStore } from "../audit/hmac-chain.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import { createTelegramBotApiClient } from "./telegram-bot-api-client.js";
import { maybeStartTelegramConnectionBridge, type TelegramPollHealth } from "./telegram-bridge-server.js";
import {
  createTelegramControlReplySender,
  type TelegramControlNotice,
  type TelegramControlReplySender,
} from "./telegram-control-reply.js";
import type { TelegramConnectionStore } from "./telegram-connection-store.js";
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from "./telegram-connection-service.js";
import {
  createTelegramActorDigester,
  telegramConversationDigest,
} from "./telegram-platform-runtime.js";
import type { TelegramRemoteApprovalGatePort } from "./telegram-remote-approval.js";

export interface StartTelegramConnectionActivationOptions {
  readonly encryption: SecretEncryption;
  readonly store: TelegramConnectionStore;
  readonly settingsService: { getEncryptedSecret(key: string): string | null };
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly conversationCommandPort: ConversationCommandPort;
  readonly getCurrentConversationId: () => string;
  // Require the configured desktop transport: ambient fetch omits the machine proxy and trust store.
  readonly networkFetch: typeof fetch;
  // Stops this activation. Wired to the same owner-initiated teardown the settings surface uses, so a fatal poll outcome and a manual disconnect converge on one path.
  readonly stopBridge: () => Promise<void>;
  // The host approval gate behind the remote-approval card feature. Read at activation time by the composition owner (`main.ts`); absent — in tests and in
  // any boot without a gate — keeps approvals desk-only.
  readonly approvalGate?: TelegramRemoteApprovalGatePort;
  // Whether Telegram is answering this activation's poll loop. The owner service reads it so a share does not keep reading `active` while every poll is failing.
  readonly onPollHealth?: (health: TelegramPollHealth) => void;
  // Test-only injection; production reads Electron's OS-encrypted store.
  readonly secretStore?: SecretStore;
  readonly log?: (message: string) => void;
}

// Forward the ingress-selected notice reason as well as chatId; callbacks with fewer parameters still typecheck.
export function createUnroutableNotifier(
  controlReplies: Pick<TelegramControlReplySender, "notify">,
): (chatId: string, notice: TelegramControlNotice) => Promise<void> {
  return async (chatId, notice) => {
    await controlReplies.notify(chatId, notice);
  };
}

// Confirm pairing only after durable redemption accepted the owner; delivery is best-effort fixed host text.
function createPairedNotifier(
  controlReplies: Pick<TelegramControlReplySender, "notify">,
): (senderId: string) => Promise<void> {
  return async (senderId) => {
    await controlReplies.notify(senderId, "paired");
  };
}

// Reconcile actor-key identity before reading bot credentials because keychain reset usually loses both.
// Without a stored bot identity there is no old digest to invalidate or adopt.
export async function reconcileTelegramActorKey(options: {
  readonly encryption: SecretEncryption;
  readonly store: TelegramConnectionStore;
  // Test-only injection; production reads Electron's OS-encrypted store.
  readonly secretStore?: SecretStore;
}): Promise<void> {
  const botFingerprint = options.store.botFingerprint();
  if (botFingerprint === null) return;
  const digestActor = createTelegramActorDigester({
    encryption: options.encryption,
    botFingerprint,
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
  });
  await options.store.reconcileActorKey(digestActor.actorKeyDigest);
}

// Missing credential or bot identity is a no-op decided by the owner facade; actor-key reconciliation must already have preceded credential reads.
export async function startTelegramConnectionActivation(
  options: StartTelegramConnectionActivationOptions,
): Promise<void> {
  const { store, settingsService } = options;
  if (store.ownerUserId() === null) {
    await store.setLastError("telegram-owner-id-required");
    return;
  }
  const botFingerprint = store.botFingerprint();
  if (botFingerprint === null) return;

  const digestActor = createTelegramActorDigester({
    encryption: options.encryption,
    botFingerprint,
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
  });

  const botToken = settingsService.getEncryptedSecret(TELEGRAM_BOT_TOKEN_SECRET_KEY);
  if (botToken === null) return;

  const controlReplies = createTelegramControlReplySender({
    client: createTelegramBotApiClient({ botToken, fetchImplementation: options.networkFetch }),
    ...(options.log ? { log: options.log } : {}),
  });

  await maybeStartTelegramConnectionBridge({
    encryption: options.encryption,
    conversationSurfaceRuntime: options.conversationSurfaceRuntime,
    conversationCommandPort: options.conversationCommandPort,
    getCurrentConversationId: options.getCurrentConversationId,
    botToken,
    botFingerprint,
    networkFetch: options.networkFetch,
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
    authority: {
      ownerUserId: () => store.ownerUserId(),
      activePairingActorDigest: () => store.activePairingActorDigest(),
      resolveActiveApproval: (actorDigest, conversationDigest) =>
        store.resolveActiveApproval(actorDigest, conversationDigest),
      resolveBoundConversation: (actorDigest) => store.resolveBoundConversation(actorDigest),
    },
    pollOffset: () => store.pollOffset(),
    recordPollOffset: (offset) => store.recordPollOffset(offset),
    hasPendingPairingCode: () => store.ownerSnapshot().pendingCode !== null,
    redeemPairingCode: async (codeDigest, senderId) => {
      if (senderId !== store.ownerUserId()) return false;
      const actorDigest = digestActor.digestFor(senderId);
      if (actorDigest === null) return false;
      return await store.completePairing({ codeDigest, actorDigest, senderId }) !== null;
    },
    isPairedOwner: (senderId) => {
      if (senderId !== store.ownerUserId()) return false;
      const actorDigest = digestActor.digestFor(senderId);
      return actorDigest !== null && store.activePairingActorDigest() === actorDigest;
    },
    notifyUnroutable: createUnroutableNotifier(controlReplies),
    onPaired: createPairedNotifier(controlReplies),
    ...(options.onPollHealth ? { onPollHealth: options.onPollHealth } : {}),
    ...(options.approvalGate ? { approvalGate: options.approvalGate } : {}),
    onFatal: async (code) => {
      // Error persistence is best-effort and must never skip teardown, especially when an unwritable store caused the fatal outcome.
      try {
        await store.setLastError(code);
      } catch {
        options.log?.("[telegram-activation] the fatal poll outcome could not be recorded");
      }
      // Fatal ingress must also stop egress. Start teardown without awaiting it here because teardown waits for this poll loop to finish.
      void options.stopBridge().catch(() => {
        options.log?.("[telegram-activation] teardown after a fatal poll failed");
      });
    },
    ...(options.log ? { log: options.log } : {}),
  });
}

// Inject the same conversation-digest function into store and owner service; mismatched derivations must refuse writes.
export { telegramConversationDigest };

// Re-exported so `main.ts` composes one conversation-digest derivation.
export function telegramConversationDigestFor(
  store: TelegramConnectionStore,
  conversationId: string,
): string | null {
  const botFingerprint = store.botFingerprint();
  if (botFingerprint === null) return null;
  try {
    return telegramConversationDigest(botFingerprint, conversationId);
  } catch {
    return null;
  }
}

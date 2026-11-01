import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
// Fatal polling and owner disconnect must share teardown so egress cannot outlive ingress.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../conversation-command-port.js";
import {
  resetTelegramBridgeServerForTests,
  stopTelegramBridgeServer,
} from "../telegram-bridge-server.js";
import {
  createUnroutableNotifier,
  startTelegramConnectionActivation,
} from "../telegram-connection-activation.js";
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from "../telegram-connection-service.js";
import {
  createTelegramConnectionStore,
  type TelegramConnectionStore,
} from "../telegram-connection-store.js";
import { telegramConversationDigest } from "../telegram-platform-runtime.js";
import { namespaceAt } from "./telegram-connection-namespace.js";
import { OWNER_CHAT_ID, textUpdate } from "./telegram-bridge-fixtures.js";
import { mintTelegramPairingCode, telegramPairingCodeDigest } from "../telegram-pairing-code.js";
import { t } from "../../i18n/index.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { forbidAmbientFetch } from "../../__tests__/support/network-fetch-stubs.js";

const BOT_TOKEN = "8112233445:activation-suite-bot-token";
// The store only ever holds digests, so the fingerprint is what it is given.
const BOT_FINGERPRINT = "f".repeat(64);

afterEach(() => {
  resetTelegramBridgeServerForTests();
  vi.unstubAllGlobals();
});

const tempDirectory = useTempDirs("ave-telegram-activation-");

async function connectedStore(): Promise<TelegramConnectionStore> {
  const store = createTelegramConnectionStore({
    namespace: namespaceAt(tempDirectory()),
    now: () => 1_700_000_000_000,
    conversationDigestFor: telegramConversationDigest,
  });
  await store.open();
  await store.setOwnerUserId(OWNER_CHAT_ID);
  await store.setConnected(BOT_FINGERPRINT);
  return store;
}

// An in-memory stand-in for the OS-encrypted store the actor key lives in.
function memorySecretStore() {
  const values = new Map<string, string>();
  return {
    read: (name: string) => values.get(name) ?? null,
    write: (name: string, value: string) => {
      values.set(name, value);
    },
  };
}

// Every Bot API call answers 401. `getUpdates` maps that to `unauthorized`, which is the one provider outcome the poller treats as unrecoverable.
function rejectingProvider(): typeof fetch {
  forbidAmbientFetch();
  return vi.fn(async () => new Response(
    JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
    { status: 401, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
}

// Park long polls after the seed response until abort; immediate resolved polls starve waitFor timers.
function emptyProvider(): typeof fetch {
  forbidAmbientFetch();
  let polls = 0;
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/getUpdates") && ++polls > 1) {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    }
    return new Response(
      JSON.stringify({ ok: true, result: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

// Spread closure-backed methods to preserve the real shared document while breaking only selected persistence writes.
function storeWithFailingWrites(
  store: TelegramConnectionStore,
  ...names: readonly ("recordPollOffset" | "setLastError")[]
): TelegramConnectionStore {
  const broken = Object.fromEntries(names.map((name) => [
    name,
    async () => {
      throw new Error("telegram-connection-store-write-failed");
    },
  ]));
  return { ...store, ...broken };
}

function activationInput(
  store: TelegramConnectionStore,
  stopBridge: () => Promise<void>,
  networkFetch: typeof fetch,
) {
  return {
    store,
    encryption: unavailableSecretEncryption,
    networkFetch,
    settingsService: { getEncryptedSecret: (key: string) => (
      key === TELEGRAM_BOT_TOKEN_SECRET_KEY ? BOT_TOKEN : null
    ) },
    conversationSurfaceRuntime: {
      sharedProjection: {},
      activity: { isBusy: () => false },
    } as unknown as ConversationSurfaceRuntime,
    conversationCommandPort: { submit: vi.fn() } as unknown as ConversationCommandPort,
    getCurrentConversationId: () => "active-conversation",
    stopBridge,
    secretStore: memorySecretStore(),
  };
}

describe("telegram connection activation", () => {
  it("does not read credentials or start transport without a registered owner", async () => {
    const store = createTelegramConnectionStore({ namespace: namespaceAt(tempDirectory()), conversationDigestFor: telegramConversationDigest });
    await store.open();
    await store.setConnected(BOT_FINGERPRINT);
    const provider = emptyProvider();
    const input = activationInput(store, () => stopTelegramBridgeServer("user"), provider);
    const getEncryptedSecret = vi.fn(() => BOT_TOKEN);
    await startTelegramConnectionActivation({ ...input, settingsService: { getEncryptedSecret } });
    expect(getEncryptedSecret).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(store.ownerSnapshot()).toMatchObject({ ownerUserId: null, lastErrorCode: "telegram-owner-id-required", pairing: null, approval: null });
  });

  describe("the unroutable notifier", () => {
    it("forwards the notice the ingress chose, not a fixed one", async () => {
      const notify = vi.fn(async () => true);
      const notifier = createUnroutableNotifier({ notify });

      await notifier("998877", "commands-not-supported");

      // Forward the control-notice reason as well as chatId; callbacks with fewer parameters still typecheck.
      expect(notify).toHaveBeenCalledWith("998877", "commands-not-supported");
    });

    it("confirms a pairing to the phone that redeemed the code", async () => {
      forbidAmbientFetch();
      const code = mintTelegramPairingCode();
      const store = await connectedStore();
      await store.createPendingCode({ codeDigest: telegramPairingCodeDigest(code)! });
      const sent: Array<{ chat_id?: unknown; text?: unknown }> = [];
      let polls = 0;
      const provider = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const method = String(url).split("/").pop();
        if (method === "sendMessage") {
          sent.push(JSON.parse(String(init?.body)) as { chat_id?: unknown; text?: unknown });
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
        }
        polls += 1;
        // A copied code from another account is rejected before the registered owner redeems it.
        if (polls === 2 || polls === 3) {
          const update = JSON.parse(new TextDecoder().decode(textUpdate(polls, code).rawBody));
          if (polls === 2) {
            update.message.from.id = 987654321;
            update.message.chat.id = 987654321;
          }
          return new Response(JSON.stringify({ ok: true, result: [update] }), { status: 200 });
        }
        if (polls > 3) {
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      await startTelegramConnectionActivation(activationInput(
        store,
        () => stopTelegramBridgeServer("user"),
        provider,
      ));

      try {
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(store.ownerSnapshot().pairing).not.toBeNull();
        expect(String(sent[0]?.chat_id)).toBe(OWNER_CHAT_ID);
        expect(sent[0]?.text).toBe(t("be_telegramBridge.paired"));
      } finally {
        await stopTelegramBridgeServer("user");
      }
    });

    it("still carries the other notice", async () => {
      // Non-vacuous: proves the first assertion is about forwarding and not about a second hardcoded value.
      const notify = vi.fn(async () => true);
      await createUnroutableNotifier({ notify })("112233", "conversation-not-shared");
      expect(notify).toHaveBeenCalledWith("112233", "conversation-not-shared");
    });
  });

  it("tears the activation down when the provider rejects the token", async () => {
    const provider = rejectingProvider();
    const store = await connectedStore();
    // The real teardown, exactly as `main.ts` wires it. A stub would pass even if the handler and the teardown were waiting on each other, which is the
    // failure this whole path is about.
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    await startTelegramConnectionActivation(activationInput(store, stopBridge, provider));
    await vi.waitFor(() => {
      expect(store.ownerSnapshot().lastErrorCode).toBe("telegram-bot-token-rejected");
    });

    // The error alone is not the invariant: a bridge that records a fatal code and keeps its egress channel open still streams assistant text to a phone
    // whose messages can no longer arrive.
    await vi.waitFor(() => {
      expect(stopBridge).toHaveBeenCalledTimes(1);
    });
    // Settling it here rather than leaving it in flight is the deadlock check: the teardown cannot finish until the poll loop that started it unwinds.
    await stopBridge.mock.results[0]?.value;
    // Throws while anything is still active, so reaching this line is the proof that the teardown ran to completion rather than merely being started.
    resetTelegramBridgeServerForTests();
  });

  it("tears the activation down when the poll offset cannot be persisted", async () => {
    const provider = emptyProvider();
    const real = await connectedStore();
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    await startTelegramConnectionActivation(activationInput(
      storeWithFailingWrites(real, "recordPollOffset"),
      stopBridge,
      provider,
    ));

    // The write is the only injected callback whose failure used to escape the loop unclassified: ingress died, nothing was recorded, and the owner surface
    // went on reading `connected` with egress still attached.
    await vi.waitFor(() => {
      expect(real.ownerSnapshot().lastErrorCode).toBe("telegram-connection-state-unwritable");
    });
    await vi.waitFor(() => {
      expect(stopBridge).toHaveBeenCalledTimes(1);
    });
    await stopBridge.mock.results[0]?.value;
    resetTelegramBridgeServerForTests();
  });

  it("tears the activation down even when the fatal outcome cannot be recorded", async () => {
    const provider = emptyProvider();
    const real = await connectedStore();
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    // An offset-write failure can also prevent error persistence; teardown must run even if recording that error throws.
    await startTelegramConnectionActivation(activationInput(
      storeWithFailingWrites(real, "recordPollOffset", "setLastError"),
      stopBridge,
      provider,
    ));

    await vi.waitFor(() => {
      expect(stopBridge).toHaveBeenCalledTimes(1);
    });
    await stopBridge.mock.results[0]?.value;
    // Nothing could be written, which is why the teardown is the only honest signal left rather than a redundant one.
    expect(real.ownerSnapshot().lastErrorCode).toBeNull();
    resetTelegramBridgeServerForTests();
  });

  it("keeps receiving when the same poll writes the offset through", async () => {
    const provider = emptyProvider();
    const store = await connectedStore();
    const stopBridge = vi.fn(() => stopTelegramBridgeServer("user"));

    await startTelegramConnectionActivation(activationInput(store, stopBridge, provider));

    // The control for both cases above: identical wiring, identical provider, and the only difference is a store that accepts the write.
    await vi.waitFor(() => {
      expect(store.pollOffset()).toBe(0);
    });
    expect(store.ownerSnapshot().lastErrorCode).toBeNull();
    expect(stopBridge).not.toHaveBeenCalled();

    await stopTelegramBridgeServer("user");
    resetTelegramBridgeServerForTests();
  });
});

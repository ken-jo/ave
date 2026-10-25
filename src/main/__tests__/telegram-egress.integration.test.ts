import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
// Drive the full timeline-to-outbound projection chain; only the command port and Bot API wire are simulated.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTmpDirTracker } from "../../__tests__/support/tmp-dir-teardown.js";
import { MemorySecretStore } from "../../audit/hmac-chain.js";
import { createConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import { createPlatformConversationEventSink } from "../../engine/conversation-platform-protocol.js";
import type { ConversationCommandPort } from "../conversation-command-port.js";
import {
  maybeStartTelegramConnectionBridge,
  resetTelegramBridgeServerForTests,
  stopTelegramBridgeServer,
} from "../telegram-bridge-server.js";
import {
  BOT_FINGERPRINT,
  BOT_TOKEN,
  BOUND_CONVERSATION,
  OWNER_CHAT_ID,
  ownerPairedAuthority,
  textUpdate,
  type Batch,
} from "./telegram-bridge-fixtures.js";
import { forbidAmbientFetch } from "../../__tests__/support/network-fetch-stubs.js";

const ASSISTANT_TEXT = "응답 텍스트입니다.";
const temporaryDirectories = createTmpDirTracker();

beforeEach(() => {
  const root = temporaryDirectories.track(mkdtempSync(join(tmpdir(), "telegram-egress-home-")));
  vi.stubEnv("AVE_HOME", root);
});

afterEach(async () => {
  try {
    await stopTelegramBridgeServer();
  } finally {
    resetTelegramBridgeServerForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await temporaryDirectories.cleanup();
  }
});

describe("telegram egress integration (real projection, real delivery)", () => {
  it("delivers snapshot + assistant text to sendMessage after a paired inbound message", async () => {
    const surface = createConversationSurfaceRuntime();

    const secretStore = new MemorySecretStore();
    const { authority } = ownerPairedAuthority(secretStore);

    const batches: Batch[] = [];
    const client = {
      getUpdates: vi.fn(async (input: { signal?: AbortSignal } = {}) => {
        const next = batches.shift();
        if (next !== undefined) return next;
        return await new Promise<Batch>((resolve) => {
          const release = () => resolve({ ok: true, value: [] });
          input.signal?.addEventListener("abort", release, { once: true });
        });
      }),
      getMe: vi.fn(async () => ({ ok: true as const, value: { username: "a_bot" } })),
      getWebhookInfo: vi.fn(async () => ({ ok: true as const, value: { hasWebhook: false } })),
      sendMessage: vi.fn(async () => ({ ok: true as const, value: { message_id: 1 } })),
    };

    // Capture outbound wire sends. This is the transport the bridge is handed, not the ambient one: the delivery path takes its `fetch` as a required option
    // now, so observing it means passing the very stub asserted on.
    const sentBodies: Array<Record<string, unknown>> = [];
    const wireFetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      sentBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    });
    // The ambient stack is nobody's transport here: a path that regresses to it fails loudly instead of quietly reaching the machine's network.
    forbidAmbientFetch();

    // Command port stand-in that does what the real port does for a bridge turn: publish semantic events into the ONE timeline the projection reads.
    const submit = vi.fn(() => {
      const sink = createPlatformConversationEventSink(surface.timeline, {
        conversationId: BOUND_CONVERSATION,
        turnId: "local-stream/1",
      });
      const completion = (async () => {
        sink({ kind: "turn.started" });
        sink({ kind: "assistant.text.delta", text: ASSISTANT_TEXT });
        sink({ kind: "turn.completed" });
        return { ok: true };
      })();
      return { completion };
    });

    let offset: number | null = 100;
    batches.push({ ok: true, value: [textUpdate(100, "지금 무슨 작업 중이였어?")] });

    const bridgeLogs: string[] = [];
    await maybeStartTelegramConnectionBridge({
      conversationSurfaceRuntime: surface,
      conversationCommandPort: { submit } as unknown as ConversationCommandPort,
      getCurrentConversationId: () => BOUND_CONVERSATION,
      botToken: BOT_TOKEN,
      botFingerprint: BOT_FINGERPRINT,
      networkFetch: wireFetch as unknown as typeof fetch,
      authority,
      pollOffset: () => offset,
      recordPollOffset: async (next: number) => {
        offset = next;
      },
      hasPendingPairingCode: () => false,
      redeemPairingCode: async () => false,
      onFatal: vi.fn(),
      isPairedOwner: (senderId: string) => senderId === OWNER_CHAT_ID,
      secretStore,
    encryption: unavailableSecretEncryption,
      createBotApiClient: vi.fn(() => client as never),
      log: (message: string) => {
        bridgeLogs.push(message);
      },
    });

    // Wait for the actual assistant send, not a send count: per-chat pacing can leave control notices ahead of it.
    // A generous deadline tolerates worker contention; early teardown would abort healthy delivery.
    const deadline = Date.now() + 45_000;
    const assistantTextSent = (): boolean =>
      sentBodies.some((body) => String(body.text ?? "").includes(ASSISTANT_TEXT));
    while (Date.now() < deadline && !assistantTextSent()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(submit).toHaveBeenCalledTimes(1);
    // At minimum: the attach snapshot, then the streamed assistant text.
    expect(sentBodies.length).toBeGreaterThanOrEqual(2);
    expect(assistantTextSent()).toBe(true);
    // The healthy path must not have closed the safe delivery channel.
    expect(bridgeLogs.filter((line) => line.includes("safe delivery closed"))).toEqual([]);
  }, 60_000);
});

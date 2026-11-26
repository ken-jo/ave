// Resolve button presses through the real ApprovalGate chokepoint used by desktop approvals.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalGate,
  isHostApprovalTimeoutDecision,
} from "../../permissions/approval-gate.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestInput,
} from "../../permissions/approval-gate.js";
import { auditRowTexts } from "../../permissions/__tests__/test-helpers.js";
import {
  createTelegramRemoteApprovalCoordinator,
  type CreateTelegramRemoteApprovalCoordinatorOptions,
} from "../telegram-remote-approval.js";
import type { TelegramCallbackQueryEnvelope } from "../telegram-platform-adapter.js";
import { createExtensionStartAsker } from "../../permissions/extension-start-asker.js";
import {
  __resetExtensionStartsForTest, deferExtensionStart, listPendingExtensionStarts, presentExtensionStartConsent, setExtensionStartAsker,
  settlePendingExtensionStarts, takeExtensionStartGrant,
} from "../../permissions/extension-start-consent.js";
import { extensionStartApprovalRows, type ExtensionStartChoice } from "../../shared/permissions-events.js";

const OWNER_ID = "123456789";
const STRANGER_ID = "987654321";
const SHARED_CONVERSATION = "shared-conversation";
const TOOL_IDENTIFIER = "builtin:list_files";

// Renderer stand-in that records the dock payloads the gate sends.
function deskDock() {
  const sent: ApprovalRequest[] = [];
  return {
    sent,
    webContents: {
      send: (_channel: string, request: ApprovalRequest) => {
        sent.push(request);
      },
      isDestroyed: () => false,
    },
  };
}

function approvalAsk(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    id: "remote-req-1",
    category: "tool",
    toolName: "list_files",
    source: "builtin",
    args: { path: "." },
    reason: "state-changing tool",
    createdAt: Date.now(),
    sessionId: SHARED_CONVERSATION,
    ...overrides,
  };
}

function fakeDecisionCardClient() {
  return {
    sendDecisionCard: vi.fn(async () => ({
      ok: true as const,
      value: { messageId: 42 },
    })),
    editMessageText: vi.fn(async () => ({ ok: true as const, value: true as const })),
    answerCallbackQuery: vi.fn(async () => ({ ok: true as const, value: true as const })),
  };
}

function remoteApprovalHarness(options: {
  timeoutMs?: number;
  coordinator?: Partial<CreateTelegramRemoteApprovalCoordinatorOptions>;
} = {}) {
  const dock = deskDock();
  const auditLogger = { log: vi.fn() };
  const gate = new ApprovalGate(
    dock.webContents as never,
    undefined,
    options.timeoutMs ?? 2_000,
    auditLogger as never,
  );
  const client = fakeDecisionCardClient();
  const coordinator = createTelegramRemoteApprovalCoordinator({
    client,
    gate,
    routeChatIdForConversation: (conversationId) =>
      conversationId === SHARED_CONVERSATION ? OWNER_ID : null,
    isPairedOwner: (senderId) => senderId === OWNER_ID,
    ...options.coordinator,
  });
  return { dock, auditLogger, gate, client, coordinator };
}

function press(data: string, senderId: string = OWNER_ID): TelegramCallbackQueryEnvelope {
  return { provider: "telegram", callbackQueryId: "press-1", senderId, data };
}

// The two opaque tokens minted for the first card the fake client sent.
async function sentCardTokens(client: ReturnType<typeof fakeDecisionCardClient>): Promise<{
  approveToken: string;
  denyToken: string;
}> {
  await vi.waitFor(() => expect(client.sendDecisionCard).toHaveBeenCalled());
  const call = client.sendDecisionCard.mock.calls[0] as unknown as [
    string,
    string,
    readonly { label: string; callbackData: string }[],
  ];
  const [approve, deny] = call[2];
  return { approveToken: approve!.callbackData, denyToken: deny!.callbackData };
}

// Desk echo material for the newest dock payload, to answer locally.
function deskEcho(dock: ReturnType<typeof deskDock>, choice: ApprovalDecision["choice"]): ApprovalDecision {
  const request = dock.sent[dock.sent.length - 1]!;
  return {
    requestId: request.id,
    choice,
    nonce: request.nonce as string,
    hmac: request.hmac as string,
  };
}

describe("telegram remote approval", () => {
  it("resolves the waiting turn as allow-once when the owner presses approve", async () => {
    const { auditLogger, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    // The card carries only the coarse tool identifier and fixed host text.
    expect(client.sendDecisionCard).toHaveBeenCalledWith(
      OWNER_ID,
      `Ave: tool ${TOOL_IDENTIFIER} is waiting for approval. This decides this run only.`,
      [
        { label: "Approve once", callbackData: approveToken },
        expect.objectContaining({ label: "Deny" }),
      ],
    );
    // Opaque token only: no request id, tool name, or conversation id inside.
    expect(approveToken).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(approveToken).not.toContain("remote-req-1");
    expect(approveToken).not.toContain(SHARED_CONVERSATION);

    await coordinator.handleCallbackQuery(press(approveToken));

    const decision = await waiting;
    expect(decision.choice).toBe("allow-once");
    expect(isHostApprovalTimeoutDecision(decision)).toBe(false);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", "Approved for this run");
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `Ave: tool ${TOOL_IDENTIFIER} approved for this run`,
    ));

    // The gate's own audit chokepoint recorded the remote answerer.
    const decided = auditRowTexts(auditLogger).find((row) => row.includes("[approval:decided]"));
    expect(decided).toContain("answeredBy=platform-bridge");
    expect(decided).toContain("choice=allow-once");
  });

  it("denies the tool when the owner presses deny", async () => {
    const { gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { denyToken } = await sentCardTokens(client);

    await coordinator.handleCallbackQuery(press(denyToken));

    const decision = await waiting;
    expect(decision.choice).toBe("deny-once");
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", "Denied");
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `Ave: tool ${TOOL_IDENTIFIER} denied`,
    ));
  });

  it("only acknowledges a press from anyone but the paired owner", async () => {
    const { gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    await coordinator.handleCallbackQuery(press(approveToken, STRANGER_ID));

    // Acknowledged without text — a reply would confirm a live desktop — and nothing resolved: the approval is still pending for the owner.
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", undefined);
    expect(client.editMessageText).not.toHaveBeenCalled();

    await coordinator.handleCallbackQuery(press(approveToken));
    await expect(waiting).resolves.toMatchObject({ choice: "allow-once" });
  });

  it("expires the card with the gate timeout and answers a late press as stale", async () => {
    const { gate, client, coordinator } = remoteApprovalHarness({ timeoutMs: 40 });
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    const decision = await waiting;
    expect(isHostApprovalTimeoutDecision(decision)).toBe(true);
    expect(decision.choice).toBe("deny-once");
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `Ave: the approval for tool ${TOOL_IDENTIFIER} is no longer active`,
    ));

    // The token died with the card: a late press can no longer decide anything.
    await coordinator.handleCallbackQuery(press(approveToken));
    expect(client.answerCallbackQuery)
      .toHaveBeenCalledWith("press-1", "This approval is no longer active");
  });

  it("keeps a local desk decision and answers the late remote press as stale", async () => {
    const { dock, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    // The desk answers first, through the same chokepoint the dock IPC uses.
    gate.resolve("remote-req-1", deskEcho(dock, "deny-once"));
    await expect(waiting).resolves.toMatchObject({ choice: "deny-once" });
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `Ave: tool ${TOOL_IDENTIFIER} denied`,
    ));

    // The remote press arrives late: harmlessly ignored, and the desk's decision — a DENY — is not flipped by the approve button.
    await coordinator.handleCallbackQuery(press(approveToken));
    expect(client.answerCallbackQuery)
      .toHaveBeenCalledWith("press-1", "This approval is no longer active");
  });

  it("ignores the desk's late answer after the remote decision settled first", async () => {
    const { dock, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);
    const lateDeskAnswer = deskEcho(dock, "deny-once");

    await coordinator.handleCallbackQuery(press(approveToken));
    await expect(waiting).resolves.toMatchObject({ choice: "allow-once" });

    // The dock click lands after the remote press: nothing left to resolve.
    expect(gate.resolve("remote-req-1", lateDeskAnswer)).toBeNull();
  });

  it("offers no card outside the single policy chokepoint's terms", async () => {
    const excluded: readonly [string, Partial<ApprovalRequestInput>][] = [
      ["no conversation attribution", { sessionId: undefined }],
      ["conversation not currently routed", { sessionId: "some-other-conversation" }],
      ["request refuses a one-shot choice", { allowedChoices: ["allow-once", "allow-always"] }],
      ["tool identifier outside the shared grammar", { toolName: "bad tool name" }],
    ];
    for (const [name, overrides] of excluded) {
      const { dock, gate, client } = remoteApprovalHarness();
      const waiting = gate.requestAndWait(approvalAsk(overrides));
      await vi.waitFor(() => expect(dock.sent.length, name).toBeGreaterThan(0));

      // The desk was asked; the phone was not.
      expect(client.sendDecisionCard, name).not.toHaveBeenCalled();
      gate.resolve("remote-req-1", deskEcho(dock, "deny-once"));
      await waiting;
    }
  });

  it("retires live cards on dispose and only acknowledges presses after it", async () => {
    const { dock, gate, client, coordinator } = remoteApprovalHarness();
    const waiting = gate.requestAndWait(approvalAsk());
    const { approveToken } = await sentCardTokens(client);

    coordinator.dispose();

    // Buttons that can no longer reach a handler stop looking pressable.
    await vi.waitFor(() => expect(client.editMessageText).toHaveBeenCalledWith(
      OWNER_ID,
      42,
      `Ave: the approval for tool ${TOOL_IDENTIFIER} is no longer active`,
    ));
    await coordinator.handleCallbackQuery(press(approveToken));
    expect(client.answerCallbackQuery).toHaveBeenCalledWith("press-1", undefined);

    // The approval itself is untouched: the desk still owns the decision.
    gate.resolve("remote-req-1", deskEcho(dock, "allow-once"));
    await expect(waiting).resolves.toMatchObject({ choice: "allow-once" });
  });
});

describe("extension starts on the remote surface", () => {
  afterEach(() => __resetExtensionStartsForTest());

  const KEYS = ["plugin-child:notes", "mcp-stdio:files", "worker:notes/index"];
  const START_TOOL = "extension_start";

  /** Waiting starts whose retry is the spawn: it presents the consent parked for it and records whether the gate let it through. */
  function waitingStarts(harness: ReturnType<typeof remoteApprovalHarness>, keys: readonly string[] = KEYS) {
    const spawned: string[] = [];
    const notify = vi.fn();
    setExtensionStartAsker(createExtensionStartAsker({ approvalGate: harness.gate, reason: () => "start without isolation?", notify }));
    for (const key of keys) {
      deferExtensionStart({ key, identity: "fixture", kind: "plugin-child", label: `label of ${key}`, cause: "no-backend", retry: async () => {
        if (presentExtensionStartConsent({ key, identity: "fixture", authority: takeExtensionStartGrant(key), spend: true })) spawned.push(key);
      } });
    }
    const settling = settlePendingExtensionStarts({ sessionId: SHARED_CONVERSATION, attended: true });
    return { spawned, notify, settling };
  }

  /** The remote cards sent so far, in order: their text and their two tokens. */
  async function remoteCards(client: ReturnType<typeof fakeDecisionCardClient>, count: number) {
    await vi.waitFor(() => expect(client.sendDecisionCard).toHaveBeenCalledTimes(count));
    return (client.sendDecisionCard.mock.calls as unknown as [string, string, readonly { callbackData: string }[]][]).map(([, text, buttons]) => {
      const [approve, deny] = buttons;
      if (approve === undefined || deny === undefined) throw new Error("a remote card has no buttons");
      return { text, approve: approve.callbackData, deny: deny.callbackData };
    });
  }

  function deskAnswer(dock: ReturnType<typeof deskDock>, choices: readonly ExtensionStartChoice[]): ApprovalDecision {
    const request = dock.sent.at(-1);
    if (request === undefined) throw new Error("the desk got no card");
    const map = Object.fromEntries((extensionStartApprovalRows(request.args) ?? []).map((row, index) => [row.id, choices[index] ?? "no"]));
    return { requestId: request.id, choice: choices.includes("yes") ? "allow-once" : "deny-once", extensionStartChoices: map, nonce: request.nonce as string, hmac: request.hmac as string };
  }

  it("offers each waiting start as its own remote card and starts only the ones answered yes", async () => {
    const harness = remoteApprovalHarness();
    const { spawned, notify, settling } = waitingStarts(harness);
    const cards = await remoteCards(harness.client, 3);
    // The desk still has one card for all three; the remote surface has one per start, numbered in the desk card's order.
    expect(harness.dock.sent).toHaveLength(1);
    expect(cards.map((card) => card.text)).toEqual([1, 2, 3].map((n) => `Ave: tool ${START_TOOL} is waiting for approval (${n} of 3). This decides this run only.`));
    // Fixed host text only: no start name, key or row id leaves the host.
    const wire = JSON.stringify(harness.client.sendDecisionCard.mock.calls);
    for (const key of KEYS) expect(wire).not.toContain(key);
    for (const row of extensionStartApprovalRows(harness.dock.sent[0]?.args) ?? []) expect(wire).not.toContain(row.id);

    await harness.coordinator.handleCallbackQuery(press(cards[0]?.approve ?? ""));
    await harness.coordinator.handleCallbackQuery(press(cards[1]?.deny ?? ""));
    // Two of three rows answered: nothing has started and the card is still open.
    expect(spawned).toEqual([]);
    expect(harness.gate.pendingCount).toBe(1);
    await harness.coordinator.handleCallbackQuery(press(cards[2]?.approve ?? ""));
    await settling;
    expect(spawned).toEqual(["plugin-child:notes", "worker:notes/index"]);
    expect(notify.mock.calls.map(([start, why]) => [start.key, why])).toEqual([["mcp-stdio:files", "declined"]]);
    expect(listPendingExtensionStarts()).toMatchObject([{ key: "mcp-stdio:files", state: "declined" }]);
    const calls = (mock: { mock: { calls: unknown[] } }) => mock.mock.calls as unknown as readonly (readonly unknown[])[];
    // An answer given while other starts still wait is only recorded: nothing starts until the last one is answered.
    expect(calls(harness.client.answerCallbackQuery).map((call) => call[1])).toEqual([
      "Recorded. It starts once the other starts on this card are answered.",
      "Recorded. It will not start.",
      "Approved for this run",
    ]);
    expect(calls(harness.client.editMessageText).map((call) => String(call[2])).sort()).toEqual([
      `Ave: tool ${START_TOOL} allowed; it starts once the other starts on this card are answered`,
      `Ave: tool ${START_TOOL} approved for this run`,
      `Ave: tool ${START_TOOL} will not start`,
    ]);
  });

  it("says on the last remote card how many starts are waiting on the desktop only, when not every start got a remote card", async () => {
    const harness = remoteApprovalHarness();
    const keys = Array.from({ length: 10 }, (_, index) => `plugin-child:p${index}`);
    const { spawned, settling } = waitingStarts(harness, keys);
    const cards = await remoteCards(harness.client, 8);
    expect(cards.slice(0, 7).map((card) => card.text)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `Ave: tool ${START_TOOL} is waiting for approval (${n} of 10). This decides this run only.`));
    expect(cards[7]?.text).toBe(`Ave: tool ${START_TOOL} is waiting for approval (8 of 10). 2 more can only be answered on the desktop. This decides this run only.`);
    // The remote answers decide the eight starts they were shown; the card stays open for the other two.
    for (const card of cards) await harness.coordinator.handleCallbackQuery(press(card.approve));
    expect(spawned).toEqual([]);
    expect(harness.gate.pendingCount).toBe(1);
    const request = harness.dock.sent.at(-1);
    harness.gate.resolveFromDesktopRenderer(request?.id ?? "", { requestId: request?.id ?? "", choice: "deny-once", nonce: request?.nonce as string, hmac: request?.hmac as string }, harness.dock.webContents as never);
    await settling;
    expect(spawned).toEqual(keys.slice(0, 8));
  });

  it("still lets one press answer a card that lists one start", async () => {
    const harness = remoteApprovalHarness();
    const { spawned, settling } = waitingStarts(harness, ["plugin-child:notes"]);
    const cards = await remoteCards(harness.client, 1);
    expect(cards[0]?.text).toBe(`Ave: tool ${START_TOOL} is waiting for approval. This decides this run only.`);
    await harness.coordinator.handleCallbackQuery(press(cards[0]?.approve ?? ""));
    await settling;
    expect(spawned).toEqual(["plugin-child:notes"]);
  });

  it("starts a start once when the remote surface and the desk both say yes to it", async () => {
    const harness = remoteApprovalHarness();
    const { spawned, settling } = waitingStarts(harness);
    const cards = await remoteCards(harness.client, 3);
    await harness.coordinator.handleCallbackQuery(press(cards[0]?.approve ?? ""));
    // The same press again: that row is answered, so it is stale and changes nothing.
    await harness.coordinator.handleCallbackQuery(press(cards[0]?.approve ?? ""));
    expect(harness.client.answerCallbackQuery).toHaveBeenLastCalledWith("press-1", "This approval is no longer active");
    harness.gate.resolveFromDesktopRenderer(harness.dock.sent[0]?.id ?? "", deskAnswer(harness.dock, ["yes", "no", "no"]), harness.dock.webContents as never);
    await settling;
    expect(spawned).toEqual(["plugin-child:notes"]);
    // A press that arrives after the card was settled starts nothing.
    await harness.coordinator.handleCallbackQuery(press(cards[2]?.approve ?? ""));
    expect(harness.client.answerCallbackQuery).toHaveBeenLastCalledWith("press-1", "This approval is no longer active");
    expect(spawned).toEqual(["plugin-child:notes"]);
    for (const key of KEYS) expect(takeExtensionStartGrant(key)).toBeUndefined();
  });

  it("keeps the first answer for a row: a later desk yes does not start what the remote surface refused, nor a later no stop what it allowed", async () => {
    const harness = remoteApprovalHarness();
    const { spawned, settling } = waitingStarts(harness);
    const cards = await remoteCards(harness.client, 3);
    await harness.coordinator.handleCallbackQuery(press(cards[0]?.deny ?? ""));
    await harness.coordinator.handleCallbackQuery(press(cards[1]?.approve ?? ""));
    const settled = harness.gate.resolveFromDesktopRenderer(harness.dock.sent[0]?.id ?? "", deskAnswer(harness.dock, ["yes", "no", "yes"]), harness.dock.webContents as never);
    const [first, second, third] = (extensionStartApprovalRows(harness.dock.sent[0]?.args) ?? []).map((row) => row.id);
    expect(settled).toMatchObject({ choice: "allow-once", extensionStartChoices: { [first ?? ""]: "no", [second ?? ""]: "yes", [third ?? ""]: "yes" } });
    await settling;
    expect(spawned).toEqual(["mcp-stdio:files", "worker:notes/index"]);
    expect(auditRowTexts(harness.auditLogger).filter((row) => row.startsWith("[approval:extension-start-row-late]"))).toHaveLength(2);
  });

  it("reads a dismissed desk card as a no only for the rows nobody answered yet", async () => {
    const harness = remoteApprovalHarness();
    const { spawned, settling } = waitingStarts(harness);
    const cards = await remoteCards(harness.client, 3);
    await harness.coordinator.handleCallbackQuery(press(cards[1]?.approve ?? ""));
    const request = harness.dock.sent[0];
    harness.gate.resolveFromDesktopRenderer(request?.id ?? "", { requestId: request?.id ?? "", choice: "deny-once", nonce: request?.nonce as string, hmac: request?.hmac as string }, harness.dock.webContents as never);
    await settling;
    expect(spawned).toEqual(["mcp-stdio:files"]);
  });
});

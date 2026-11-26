import { approvalPresentationDenial, presentRemoteApprovalCard } from "../permissions/approval-presentation.js";
// Verified button presses resolve through the same ApprovalGate checks as desktop decisions. Cards contain fixed host text and coarse tool IDs only;
// callback tokens map to pending approvals in memory.
import { randomBytes } from "node:crypto";
import {
  isHostApprovalTimeoutDecision,
  type ApprovalDecision,
  type PendingApprovalObserver,
  type PendingApprovalView,
} from "../permissions/approval-gate.js";
import { isSharedApprovalToolIdentifier } from "../shared/permission-review-status.js";
import type {
  TelegramBotApiClient,
  TelegramDecisionButton,
} from "./telegram-bot-api-client.js";
import type { TelegramCallbackQueryEnvelope } from "./telegram-platform-adapter.js";

// Active cards at once. An approval wait is a blocking, sequential state, so more than a handful of live cards means something is wrong upstream; the
// bound keeps a pathological producer from turning the bridge into a card flood.
const MAX_ACTIVE_CARDS = 8;

// 128-bit random token, base64url: 22 chars, inside the opaque grammar.
const CALLBACK_TOKEN_BYTES = 16;

// Fixed host sentences, in the same deliberately unlocalized register as the adapter's `OUTBOUND_STATUS_TEXT`. The tool identifier interpolated below is
// validated against the one shared grammar before it may appear.
const CARD_TEXT = Object.freeze({
  prompt: (tool: string) =>
    `Ave: tool ${tool} is waiting for approval. This decides this run only.`,
  // One of several starts waiting on the same desk card, numbered in that card's order.
  promptRow: (tool: string, position: number, total: number) =>
    `Ave: tool ${tool} is waiting for approval (${position} of ${total}). This decides this run only.`,
  // The last remote card when the card bound left some starts without one: those are on the desk card only.
  promptRowLast: (tool: string, position: number, total: number, deskOnly: number) =>
    `Ave: tool ${tool} is waiting for approval (${position} of ${total}). ${deskOnly} more can only be answered on the desktop. This decides this run only.`,
  approved: (tool: string) => `Ave: tool ${tool} approved for this run`,
  denied: (tool: string) => `Ave: tool ${tool} denied`,
  expired: (tool: string) => `Ave: the approval for tool ${tool} is no longer active`,
  approveButton: "Approve once",
  denyButton: "Deny",
  // A start answered while others on its card still wait is only recorded: nothing starts until the last one is answered.
  rowAllowed: (tool: string) => `Ave: tool ${tool} allowed; it starts once the other starts on this card are answered`,
  rowDeclined: (tool: string) => `Ave: tool ${tool} will not start`,
  ackRowAllowed: "Recorded. It starts once the other starts on this card are answered.",
  ackRowDeclined: "Recorded. It will not start.",
  ackApproved: "Approved for this run",
  ackDenied: "Denied",
  ackStale: "This approval is no longer active",
});

// The narrow slice of the approval gate this feature is allowed to touch: observe what is parked, and answer through the one shared resolve chokepoint
// as the `"platform-bridge"` answerer.
export interface TelegramRemoteApprovalGatePort {
  observePendingApprovals(observer: PendingApprovalObserver): () => void;
  resolveWithFreshIdentity(
    requestId: string,
    decision: ApprovalDecision,
    answeredBy: "platform-bridge",
  ): Promise<ApprovalDecision | null> | ApprovalDecision | null;
}

export interface TelegramRemoteApprovalCoordinator {
  // The one entry for a verified inline-keyboard press from the poller.
  handleCallbackQuery(callback: TelegramCallbackQueryEnvelope): Promise<void>;
  // Detach from the gate and best-effort invalidate cards still showing buttons.
  dispose(): void;
}

export interface CreateTelegramRemoteApprovalCoordinatorOptions {
  readonly client: Pick<
    TelegramBotApiClient,
    "sendDecisionCard" | "editMessageText" | "answerCallbackQuery"
  >;
  readonly gate: TelegramRemoteApprovalGatePort;
  // The egress fence, re-checked per card: the chat id of the CURRENT route bound to this conversation, or null when the approval's conversation is not
  // the paired, shared, on-screen one. Null means no card is sent at all.
  readonly routeChatIdForConversation: (conversationId: string) => string | null;
  // Same trust derivation as message inbound: the sender id digests to the currently paired owner. A press failing this is acknowledged (to clear the
  // client spinner) and otherwise ignored without any distinguishable reply.
  readonly isPairedOwner: (senderId: string) => boolean;
  readonly log?: (message: string) => void;
}

// What the single remote-approval policy offers for one parked approval, or null for "not remotely decidable".
interface RemoteApprovalOffer {
  readonly conversationId: string;
  readonly toolIdentifier: string;
  // The ONLY choices a remote press can produce.
  readonly approveChoice: "allow-once";
  readonly denyChoice: "deny-once";
  // An extension-start ask: one remote card per waiting start, each answering its own row. Undefined for every other ask.
  readonly rows?: readonly string[];
}

// Remote approval is one-shot only; offer allow-once/deny-once and retain the gate’s allowed-choice validation.
function remoteApprovalOffer(view: PendingApprovalView): RemoteApprovalOffer | null {
  // Only an ordinary tool ask. Directory-scope grants, plugin agent actions, and rationale cards are desk-only decisions.
  if (view.category !== "tool") return null;
  // An extension-start ask is offered one start at a time: each start keeps its own yes or no, and no press answers them all.
  const rows = view.kind === "extension-start" ? view.extensionStartRows : undefined;
  if (view.kind !== undefined && view.kind !== "tool" && (rows === undefined || rows.length === 0)) return null;
  // An approval with no conversation attribution cannot be fenced to the shared conversation, so it is not offered.
  if (view.sessionId === undefined) return null;
  // Requests that constrain their answers must accept both one-shot choices.
  if (
    view.allowedChoices !== undefined
    && (!view.allowedChoices.includes("allow-once")
      || !view.allowedChoices.includes("deny-once"))
  ) {
    return null;
  }
  const toolIdentifier = view.source === undefined
    ? view.toolName
    : `${view.source}:${view.toolName}`;
  // Fail closed: a name outside the shared grammar never reaches the wire.
  if (!isSharedApprovalToolIdentifier(toolIdentifier)) return null;
  return {
    conversationId: view.sessionId,
    toolIdentifier,
    approveChoice: "allow-once",
    denyChoice: "deny-once",
    ...(rows === undefined ? {} : { rows }),
  };
}

interface RemoteApprovalCard {
  readonly requestId: string;
  // The one row of an extension-start ask this card answers; undefined when the card answers the whole request.
  readonly row?: string;
  readonly toolIdentifier: string;
  readonly chatId: string;
  // Echo material for the shared resolve chokepoint; never leaves the host.
  readonly echoNonce: string;
  readonly echoHmac: string;
  readonly approveToken: string;
  readonly denyToken: string;
  // Learned from the send result; edits are impossible before it arrives.
  messageId?: number;
  // Set at settlement; applied as soon as a message id exists.
  finalText?: string;
}

export function createTelegramRemoteApprovalCoordinator(
  options: CreateTelegramRemoteApprovalCoordinatorOptions,
): TelegramRemoteApprovalCoordinator {
  if (
    !options
    || typeof options.client?.sendDecisionCard !== "function"
    || typeof options.client?.editMessageText !== "function"
    || typeof options.client?.answerCallbackQuery !== "function"
    || typeof options.gate?.observePendingApprovals !== "function"
    || typeof options.gate?.resolveWithFreshIdentity !== "function"
    || typeof options.routeChatIdForConversation !== "function"
    || typeof options.isPairedOwner !== "function"
  ) {
    throw new TypeError("telegram-remote-approval-options-invalid");
  }
  const { client, gate, log } = options;
  const cardsByRequest = new Map<string, Set<RemoteApprovalCard>>();
  const activeCardCount = (): number => [...cardsByRequest.values()].reduce((count, cards) => count + cards.size, 0);
  const forgetCard = (card: RemoteApprovalCard): void => {
    const cards = cardsByRequest.get(card.requestId);
    cards?.delete(card);
    if (cards?.size === 0) cardsByRequest.delete(card.requestId);
    cardsByToken.delete(card.approveToken);
    cardsByToken.delete(card.denyToken);
  };
  const cardsByToken = new Map<string, { card: RemoteApprovalCard; choice: "allow-once" | "deny-once" }>();
  let disposed = false;

  const editCard = (card: RemoteApprovalCard): void => {
    if (card.messageId === undefined || card.finalText === undefined) return;
    void client
      .editMessageText(card.chatId, card.messageId, card.finalText)
      .then((result) => {
        if (!result.ok) log?.("[telegram-remote-approval] card edit failed");
      })
      .catch(() => {
        log?.("[telegram-remote-approval] card edit failed");
      });
  };

  const retireCard = (card: RemoteApprovalCard, finalText: string): void => {
    forgetCard(card);
    card.finalText = finalText;
    editCard(card);
  };

  const finalTextFor = (card: RemoteApprovalCard, decision: ApprovalDecision): string => {
    // Read before the guard: its `decision is ApprovalDecision` predicate would otherwise narrow the negated branch to `never`.
    // A row card shows its own start's answer. An answer that names no row is for the whole ask: a dismissed desk card, or the one start of a one-start card.
    const rowAnswer = card.row === undefined ? undefined : decision.extensionStartChoices?.[card.row];
    const approved = rowAnswer === undefined ? decision.choice.startsWith("allow") : rowAnswer === "yes";
    if (isHostApprovalTimeoutDecision(decision)) return CARD_TEXT.expired(card.toolIdentifier);
    return approved
      ? CARD_TEXT.approved(card.toolIdentifier)
      : CARD_TEXT.denied(card.toolIdentifier);
  };

  const observer: PendingApprovalObserver = {
    onPending: (view) => {
      if (disposed || approvalPresentationDenial()) return;
      const offer = remoteApprovalOffer(view);
      if (offer === null) return;
      let chatId: string | null;
      try {
        chatId = options.routeChatIdForConversation(offer.conversationId);
      } catch {
        return;
      }
      if (chatId === null) return;
      if (cardsByRequest.has(view.requestId)) return;
      const rows: readonly (string | undefined)[] = offer.rows ?? [undefined];
      // A start the bound leaves without a remote card is still on the desk card; the remote answers decide only the starts they
      // were shown, and the last card says how many were not.
      const shown = Math.min(rows.length, Math.max(0, MAX_ACTIVE_CARDS - activeCardCount()));
      if (shown < rows.length) log?.("[telegram-remote-approval] card skipped: active card bound reached");
      for (const [index, row] of rows.slice(0, shown).entries()) {
        const card: RemoteApprovalCard = {
          requestId: view.requestId,
          ...(row === undefined ? {} : { row }),
          toolIdentifier: offer.toolIdentifier,
          chatId,
          echoNonce: view.nonce,
          echoHmac: view.hmac,
          approveToken: randomBytes(CALLBACK_TOKEN_BYTES).toString("base64url"),
          denyToken: randomBytes(CALLBACK_TOKEN_BYTES).toString("base64url"),
        };
        const cards = cardsByRequest.get(card.requestId) ?? new Set<RemoteApprovalCard>();
        cards.add(card);
        cardsByRequest.set(card.requestId, cards);
        cardsByToken.set(card.approveToken, { card, choice: offer.approveChoice });
        cardsByToken.set(card.denyToken, { card, choice: offer.denyChoice });
        const buttons: readonly TelegramDecisionButton[] = [
          { label: CARD_TEXT.approveButton, callbackData: card.approveToken },
          { label: CARD_TEXT.denyButton, callbackData: card.denyToken },
        ];
        const prompt = row === undefined || rows.length === 1
          ? CARD_TEXT.prompt(card.toolIdentifier)
          : shown < rows.length && index === shown - 1
            ? CARD_TEXT.promptRowLast(card.toolIdentifier, index + 1, rows.length, rows.length - shown)
            : CARD_TEXT.promptRow(card.toolIdentifier, index + 1, rows.length);
        const sent = presentRemoteApprovalCard(client, card.chatId, prompt, buttons);
        if (!sent) {
          forgetCard(card);
          continue;
        }
        void sent.then((result) => {
            if (!result.ok) {
              // An unsent card must not keep live tokens: a press can only arrive for a card that exists on the owner's screen.
              forgetCard(card);
              log?.("[telegram-remote-approval] card send failed");
              return;
            }
            card.messageId = result.value.messageId;
            // Settled while the send was in flight: apply the final edit now.
            editCard(card);
          })
          .catch(() => {
            forgetCard(card);
            log?.("[telegram-remote-approval] card send failed");
          });
      }
    },
    onSettled: (requestId, decision) => {
      for (const card of [...(cardsByRequest.get(requestId) ?? [])]) retireCard(card, finalTextFor(card, decision));
    },
  };
  const unsubscribe = gate.observePendingApprovals(observer);

  const acknowledge = async (callbackQueryId: string, text?: string): Promise<void> => {
    try {
      const result = await client.answerCallbackQuery(callbackQueryId, text);
      if (!result.ok) log?.("[telegram-remote-approval] callback acknowledgement failed");
    } catch {
      log?.("[telegram-remote-approval] callback acknowledgement failed");
    }
  };

  return Object.freeze({
    async handleCallbackQuery(callback: TelegramCallbackQueryEnvelope): Promise<void> {
      // Acknowledge unpaired button presses silently, whether tokens exist or not, to clear the spinner without exposing a live desktop or token oracle.
      let paired: boolean;
      try {
        paired = options.isPairedOwner(callback.senderId);
      } catch {
        paired = false;
      }
      if (disposed || !paired) {
        await acknowledge(callback.callbackQueryId);
        return;
      }
      const binding = cardsByToken.get(callback.data);
      if (binding === undefined) {
        // Expired, already decided, or never minted: all one answer, so a late press after a local decision stays harmless and indistinct.
        await acknowledge(callback.callbackQueryId, CARD_TEXT.ackStale);
        return;
      }
      // The SAME resolve chokepoint the desktop dock's IPC handler calls, with the gate's own echo material. Integrity, allowed-choice, and audit all happen
      // in the gate; settlement re-enters this module only through the observer above, which edits the card.
      const decision = await gate.resolveWithFreshIdentity(
        binding.card.requestId,
        {
          requestId: binding.card.requestId,
          choice: binding.choice,
          ...(binding.card.row === undefined ? {} : { extensionStartRow: binding.card.row }),
          nonce: binding.card.echoNonce,
          hmac: binding.card.echoHmac,
        },
        "platform-bridge",
      );
      if (decision === null) {
        // Raced by a local decision between lookup and resolve.
        await acknowledge(callback.callbackQueryId, CARD_TEXT.ackStale);
        return;
      }
      // A row answered while other starts still wait: the gate has not settled the ask, so this card is closed here.
      if (binding.card.row !== undefined && cardsByToken.get(callback.data) === binding) {
        const allowed = binding.choice === "allow-once";
        retireCard(binding.card, allowed ? CARD_TEXT.rowAllowed(binding.card.toolIdentifier) : CARD_TEXT.rowDeclined(binding.card.toolIdentifier));
        await acknowledge(callback.callbackQueryId, allowed ? CARD_TEXT.ackRowAllowed : CARD_TEXT.ackRowDeclined);
        return;
      }
      await acknowledge(
        callback.callbackQueryId,
        (binding.card.row === undefined ? decision.choice.startsWith("allow") : binding.choice === "allow-once") ? CARD_TEXT.ackApproved : CARD_TEXT.ackDenied,
      );
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      // Buttons that can no longer reach a handler must not keep looking pressable. Best-effort and not awaited: teardown never blocks on a provider.
      for (const cards of [...cardsByRequest.values()]) {
        for (const card of [...cards]) retireCard(card, CARD_TEXT.expired(card.toolIdentifier));
      }
    },
  });
}

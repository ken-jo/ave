import type { SecretEncryption } from "../data/secret-document-store.js";
// Default-off outbound polling starts only from the owner’s stored connection; it opens no listener or webhook and shares no other route family.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createTailnetControllerReceiptStore,
  type TailnetControllerReceiptStore,
} from "../api/tailnet-controller-receipt-store.js";
import type { SecretStore } from "../audit/hmac-chain.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import {
  createPlatformBridgeDeliveryAdapter,
  type PlatformBridgeDeliveryAdapter,
  type PlatformBridgeDeliveryChannel,
} from "./platform-bridge-delivery.js";
import {
  createPlatformBridgeInboundGateway,
  type PlatformBridgeInboundAuthorizer,
  type PlatformBridgeInboundGateway,
  type PlatformBridgeInboundResult,
  type PlatformBridgeReceiptStore,
  type PlatformBridgeWebhookVerifier,
} from "./platform-bridge-inbound.js";
import {
  coalesceTelegramDeliveryQueue,
  createTelegramOutboundTransport,
  createTelegramPollingVerifier,
  parseTelegramCallbackQueryUpdate,
  parseTelegramTextUpdate,
  type TelegramCallbackQueryEnvelope,
  type TelegramDeliveryChannel,
} from "./telegram-platform-adapter.js";
import {
  createTelegramPairedPlatformRuntime,
  type TelegramPairedRouteAuthority,
  type TelegramPlatformRoute,
  type TelegramPlatformRuntime,
} from "./telegram-platform-runtime.js";
import {
  createTelegramRemoteApprovalCoordinator,
  type TelegramRemoteApprovalCoordinator,
  type TelegramRemoteApprovalGatePort,
} from "./telegram-remote-approval.js";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
  type TelegramPolledUpdate,
} from "./telegram-bot-api-client.js";
import type { TelegramControlNotice } from "./telegram-control-reply.js";
import {
  looksLikeTelegramPairingCode,
  telegramPairingCodeDigest,
} from "./telegram-pairing-code.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { TELEGRAM_BRIDGE_FEATURE } from "./telegram-connection-store.js";

// Advance offsets only after terminal delivery outcomes; retry releasable outcomes with the same update.
// Bound API bodies before parsing and retain per-envelope limits after splitting updates.

// Outcomes that are terminal for this delivery. Every one of them either handled the update or rejected it permanently, so re-polling it would wedge the
// loop on a message that can never succeed.
const ADVANCING_RESULTS: ReadonlySet<PlatformBridgeInboundResult> = new Set([
  "accepted",
  "duplicate",
  "invalid-request",
  "request-too-large",
  "verification-failed",
  "invalid-envelope",
  "slash-command-rejected",
  "authorization-denied",
  "idempotency-conflict",
  // The receipt is retained and replay is deliberately blocked, so retrying could never resolve it either.
  "command-outcome-unknown",
]);

// Count only consumed pre-envelope failures; disabled repolls rather than advancing and must not count as lost data.
const PRE_ENVELOPE_GATEWAY_RESULTS = [
  "invalid-request",
  "request-too-large",
  "verification-failed",
  "invalid-envelope",
] as const satisfies readonly PlatformBridgeInboundResult[];

// Why an update died before it could become an envelope. The vocabulary is fixed at compile time and carries no payload material: `unparsable-update` is
// a boolean fact about the adapter's return, and the rest are the shared core's own provider-safe admission outcomes.
type PreEnvelopeDropReason =
  | "unparsable-update"
  | typeof PRE_ENVELOPE_GATEWAY_RESULTS[number];

const PRE_ENVELOPE_GATEWAY_RESULT_SET: ReadonlySet<PlatformBridgeInboundResult> =
  new Set(PRE_ENVELOPE_GATEWAY_RESULTS);

function preEnvelopeGatewayReason(
  result: PlatformBridgeInboundResult,
): PreEnvelopeDropReason | undefined {
  return PRE_ENVELOPE_GATEWAY_RESULT_SET.has(result)
    ? result as PreEnvelopeDropReason
    : undefined;
}

const RETRY_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

// Back off transient poll failures from two seconds to one minute; reset the streak on the first provider response.
function telegramTransientBackoffMs(consecutive: number): number {
  const exponent = Math.min(Math.max(consecutive, 1) - 1, 16);
  return Math.min(RETRY_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;

type TelegramPollingFatalCode =
  | "telegram-bot-token-rejected"
  | "telegram-webhook-conflict"
  | "telegram-poll-conflict"
  // A refused offset write is fatal: continuing would report a connected bridge whose pairing and approval state cannot persist.
  | "telegram-connection-state-unwritable";

export interface TelegramPollingIngressOptions {
  readonly client: TelegramBotApiClient;
  readonly gateway: PlatformBridgeInboundGateway;
  // Last confirmed offset, or null before the first poll of this connection.
  readonly pollOffset: () => number | null;
  readonly recordPollOffset: (offset: number) => Promise<void>;
  readonly hasPendingPairingCode: () => boolean;
  // True only on a constant-time digest match against a live pending code.
  readonly redeemPairingCode: (codeDigest: string, senderId: string) => Promise<boolean>;
  // Terminal condition: the loop stops and the owner must act.
  readonly onFatal: (code: TelegramPollingFatalCode) => void | Promise<void>;
  readonly onPaired?: (senderId: string) => void | Promise<void>;
  // Whether this sender is the already-paired owner. The shared core reports both a stranger and an unshared owner as `authorization-denied`, so this is
  // the only way to tell them apart — and a stranger must never be answered.
  readonly isPairedOwner?: (senderId: string) => boolean;
  // Best-effort, cooldown-gated host notice. Never carries conversation data.
  readonly notifyUnroutable?: (
    chatId: string,
    notice: TelegramControlNotice,
  ) => void | Promise<void>;
  // Handler for a verified inline-keyboard press. Absent means every callback update is consumed and dropped — the loop must still advance past it, so a
  // bridge without remote approval wired cannot wedge on one.
  readonly onCallbackQuery?: (
    callback: TelegramCallbackQueryEnvelope,
  ) => void | Promise<void>;
  readonly log?: (message: string) => void;
  // Whether Telegram is answering this loop. `retrying` on the first failed poll of a streak, `receiving` once a poll is answered again, `stopped` when
  // the loop exits for any reason. Transitions only — never once per poll.
  readonly onHealth?: (health: TelegramPollHealth) => void;
  // Test seam; production sleeps on a timer that the abort signal cancels.
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type TelegramPollHealth = "receiving" | "retrying" | "stopped";

export interface TelegramPollingIngress {
  // Resolves once the loop has fully exited.
  readonly finished: Promise<void>;
  stop(): void;
  // On wake or connectivity return, cancel stale long polls and backoff without ending the loop or advancing unprocessed offsets.
  nudge(): void;
}

// What `nudge` reaches inside the running loop.
interface PollWake {
  requested: boolean;
  interrupt: (() => void) | null;
}

export function startTelegramPollingIngress(
  options: TelegramPollingIngressOptions,
): TelegramPollingIngress {
  if (!options || typeof options !== "object") {
    throw new TypeError("telegram-polling-ingress-options-invalid");
  }
  for (const name of [
    "pollOffset",
    "recordPollOffset",
    "hasPendingPairingCode",
    "redeemPairingCode",
    "onFatal",
  ] as const) {
    if (typeof options[name] !== "function") {
      throw new TypeError("telegram-polling-ingress-options-invalid");
    }
  }
  if (typeof options.client?.getUpdates !== "function"
    || typeof options.gateway?.handleWebhook !== "function") {
    throw new TypeError("telegram-polling-ingress-options-invalid");
  }

  const controller = new AbortController();
  const { signal } = controller;
  const wait = options.wait ?? defaultWait;

  const wake: PollWake = { requested: false, interrupt: null };

  const finished = run(options, signal, wait, wake).catch(() => {
    // Reached only by a throw this module did not classify. It still ends ingress, so it must leave a trace rather than resolving as if the loop had been asked to stop.
    options.log?.("[telegram-poll] the poll loop ended unexpectedly");
  });
  return Object.freeze({
    finished,
    stop(): void {
      controller.abort();
    },
    nudge(): void {
      if (signal.aborted) return;
      wake.requested = true;
      wake.interrupt?.();
    },
  });
}

async function run(
  options: TelegramPollingIngressOptions,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  wake: PollWake,
): Promise<void> {
  const drops = createPreEnvelopeDropCounter(options.log);
  try {
    await poll(options, signal, wait, drops, wake);
  } finally {
    // Every exit is an activation ending — aborted, fatal, or thrown — and the final tally is the number an operator asks for after a bad session.
    drops.finish();
    reportHealth(options, "stopped");
  }
}

// A health listener is the owner surface's business; it cannot stop the loop.
function reportHealth(options: TelegramPollingIngressOptions, health: TelegramPollHealth): void {
  try {
    options.onHealth?.(health);
  } catch {
    // the loop's own state is the authority
  }
}

type Interruptible<T> =
  | { readonly interrupted: false; readonly value: T }
  // `value` is whatever the abandoned step still produced, if anything.
  | { readonly interrupted: true; readonly value: T | undefined };

// Both stop and nudge abort the request; nudge triggers re-polling, while stop leaves the signal aborted for the caller.
async function interruptible<T>(
  signal: AbortSignal,
  wake: PollWake,
  step: (signal: AbortSignal) => Promise<T>,
): Promise<Interruptible<T>> {
  const local = new AbortController();
  let interrupted = false;
  const forward = (): void => local.abort();
  if (signal.aborted) local.abort();
  else signal.addEventListener("abort", forward, { once: true });
  wake.interrupt = () => {
    interrupted = true;
    local.abort();
  };
  try {
    const value = await step(local.signal);
    return interrupted ? { interrupted: true, value } : { interrupted: false, value };
  } catch (err) {
    if (interrupted) return { interrupted: true, value: undefined };
    throw err;
  } finally {
    wake.interrupt = null;
    signal.removeEventListener("abort", forward);
  }
}

async function poll(
  options: TelegramPollingIngressOptions,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  drops: PreEnvelopeDropCounter,
  wake: PollWake,
): Promise<void> {
  let offset = options.pollOffset();
  let backoffMs = 0;
  // Drives the backoff; a wake restarts it.
  let streak = 0;
  // Failed polls this outage, for the recovery line; a wake does not reset it.
  let failedPolls = 0;
  const transient = (): number => {
    streak += 1;
    failedPolls += 1;
    if (failedPolls === 1) {
      options.log?.("[telegram-poll] polling Telegram failed; backing off");
      reportHealth(options, "retrying");
    }
    return telegramTransientBackoffMs(streak);
  };
  const reached = (): void => {
    if (failedPolls > 0) {
      options.log?.(`[telegram-poll] polling Telegram again after ${failedPolls} failed polls`);
      reportHealth(options, "receiving");
    }
    streak = 0;
    failedPolls = 0;
  };

  while (!signal.aborted) {
    if (backoffMs > 0) {
      const delay = backoffMs;
      // On time or cut short by a nudge, the wait is over either way; only a stop ends the loop here.
      await interruptible(signal, wake, (waitSignal) => wait(delay, waitSignal)).catch(() => undefined);
      if (signal.aborted) return;
      backoffMs = 0;
    }
    if (wake.requested) {
      wake.requested = false;
      streak = 0;
    }

    if (offset === null) {
      const seed = await interruptible(signal, wake, (requestSignal) => seedOffset(options, requestSignal));
      if (signal.aborted) return;
      const seeded = seed.value;
      // A fatal outcome already reported stands even if a nudge raced it.
      if (seeded !== undefined && typeof seeded !== "number" && seeded.kind === "stop") return;
      if (seed.interrupted || seeded === undefined) continue;
      if (typeof seeded !== "number") {
        backoffMs = seeded.kind === "transient" ? transient() : seeded.ms;
        continue;
      }
      reached();
      offset = seeded;
      if (!await confirmOffset(options, offset)) return;
      continue;
    }

    const pollOffset = offset;
    const polled = await interruptible(
      signal,
      wake,
      (requestSignal) => options.client.getUpdates({ offset: pollOffset, signal: requestSignal }),
    );
    if (signal.aborted) return;
    // An abandoned long poll is not a failed one; any updates it carried are fetched again, because the offset has not moved.
    if (polled.interrupted) continue;
    const result = polled.value;
    if (!result.ok) {
      const next = await handleFailure(options, result.reason, result.retryAfterMs, signal);
      if (next.kind === "stop") return;
      backoffMs = next.kind === "transient" ? transient() : next.ms;
      continue;
    }
    reached();

    // Strictly sequential. The shared core holds no mutex and the turn lease is single-holder, so a concurrent fan-out would silently drop all but one
    // message as `streaming-active`.
    for (const update of result.value) {
      if (signal.aborted) return;
      const disposition = await handleUpdate(options, update, drops);
      if (disposition === "retry") {
        backoffMs = RETRY_BACKOFF_MS;
        break;
      }
      offset = update.updateId + 1;
      if (!await confirmOffset(options, offset)) return;
    }
  }
}

// Failed durable offset confirmation is fatal: surface the reason and tear down activation so ingress and egress cannot diverge.
async function confirmOffset(
  options: TelegramPollingIngressOptions,
  offset: number,
): Promise<boolean> {
  try {
    await options.recordPollOffset(offset);
    return true;
  } catch {
    options.log?.("[telegram-poll] the poll offset could not be saved; stopping");
    await safeFatal(options, "telegram-connection-state-unwritable");
    return false;
  }
}

// Skip whatever accumulated before this connection existed. Replaying a day of backlog as live turns would produce a burst of model calls and local
// approval prompts the owner never asked for.
async function seedOffset(
  options: TelegramPollingIngressOptions,
  signal: AbortSignal,
): Promise<number | FailureDisposition> {
  const result = await options.client.getUpdates({
    offset: -1,
    limit: 1,
    timeoutSeconds: 0,
    signal,
  });
  if (!result.ok) {
    return await handleFailure(options, result.reason, result.retryAfterMs, signal);
  }
  const last = result.value[result.value.length - 1];
  return last === undefined ? 0 : last.updateId + 1;
}

type UpdateDisposition = "advance" | "retry";

// Count pre-envelope drops per activation without persisting identity or payloads.
// Log first reason, powers of ten, and exit only so hostile traffic cannot amplify logs.
interface PreEnvelopeDropCounter {
  record(reason: PreEnvelopeDropReason): void;
  // Final tally for an activation that ended between milestones.
  finish(): void;
}

function createPreEnvelopeDropCounter(
  log: ((message: string) => void) | undefined,
): PreEnvelopeDropCounter {
  const counts = new Map<PreEnvelopeDropReason, number>();
  let total = 0;
  // The first drop of every reason already logs, so the first milestone that adds anything is ten.
  let nextMilestone = 10;

  const report = (prefix: string): void => {
    const breakdown = [...counts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    log?.(`[telegram-poll] ${prefix} total=${total} ${breakdown}`);
  };

  return {
    record(reason: PreEnvelopeDropReason): void {
      const seen = counts.get(reason);
      counts.set(reason, (seen ?? 0) + 1);
      total += 1;
      if (seen === undefined) {
        report("pre-envelope drop, first of this kind:");
        return;
      }
      if (total >= nextMilestone) {
        report("pre-envelope drops:");
        nextMilestone *= 10;
      }
    },
    finish(): void {
      if (total === 0) return;
      report("pre-envelope drops for this activation:");
    },
  };
}

async function handleUpdate(
  options: TelegramPollingIngressOptions,
  update: TelegramPolledUpdate,
  drops: PreEnvelopeDropCounter,
): Promise<UpdateDisposition> {
  const envelope = parseTelegramTextUpdate(update.rawBody);
  // Advance permanently unsupported updates to avoid wedging the poller; count them so provider schema drift is distinguishable from no traffic.
  if (envelope === undefined) {
    // Parse verified button decisions outside the conversation gateway; consume even unhandled presses because retry cannot resolve them.
    const callback = parseTelegramCallbackQueryUpdate(update.rawBody);
    if (callback !== undefined) {
      if (options.onCallbackQuery !== undefined) {
        try {
          await options.onCallbackQuery(callback);
        } catch {
          options.log?.("[telegram-poll] callback handling failed");
        }
      }
      return "advance";
    }
    drops.record("unparsable-update");
    return "advance";
  }

  if (looksLikeTelegramPairingCode(envelope.text)) {
    // Consumed and dropped whether or not it matches, so a near-miss credential can never land in the conversation transcript.
    await redeemPairing(options, envelope.text.trim(), envelope.senderId);
    return "advance";
  }

  const result = await options.gateway.handleWebhook({ rawBody: update.rawBody });
  // Count only failures before envelope normalization; deliberate pairing consumption is not lost data.
  const preEnvelope = preEnvelopeGatewayReason(result);
  if (preEnvelope !== undefined) drops.record(preEnvelope);
  // Notify paired owners only for understood policy refusals such as no share or slash commands; handled or retryable outcomes stay silent.
  if (SILENTLY_CONSUMED_RESULTS.has(result)) {
    await notifyIfPairedOwner(options, envelope.senderId, noticeFor(result));
  }
  return ADVANCING_RESULTS.has(result) ? "advance" : "retry";
}

// Outcomes where the paired owner's message is consumed and nothing is done with it. Each needs a different sentence, because "nothing is shared" and
// "commands are not supported" are different problems for the owner to fix.
const SILENTLY_CONSUMED_RESULTS: ReadonlySet<PlatformBridgeInboundResult> = new Set([
  "authorization-denied",
  "slash-command-rejected",
]);

function noticeFor(result: PlatformBridgeInboundResult): TelegramControlNotice {
  return result === "slash-command-rejected"
    ? "commands-not-supported"
    : "conversation-not-shared";
}

async function notifyIfPairedOwner(
  options: TelegramPollingIngressOptions,
  senderId: string,
  notice: TelegramControlNotice,
): Promise<void> {
  if (options.isPairedOwner === undefined || options.notifyUnroutable === undefined) return;
  try {
    // Silence for anyone who is not the paired owner: answering a stranger would confirm that this bot is attached to a live desktop.
    if (!options.isPairedOwner(senderId)) return;
    await options.notifyUnroutable(senderId, notice);
  } catch {
    options.log?.("[telegram-poll] control notice failed");
  }
}

async function redeemPairing(
  options: TelegramPollingIngressOptions,
  candidate: string,
  senderId: string,
): Promise<void> {
  let pending: boolean;
  try {
    pending = options.hasPendingPairingCode();
  } catch {
    return;
  }
  // Nothing to redeem: stay silent rather than confirm to an unknown sender that this bot is attached to a live desktop.
  if (!pending) return;

  const codeDigest = telegramPairingCodeDigest(candidate);
  if (codeDigest === null) return;
  try {
    if (await options.redeemPairingCode(codeDigest, senderId)) {
      await options.onPaired?.(senderId);
    }
    // The durable store alone debits failed pairing attempts; ingress must not charge again.
  } catch {
    options.log?.("[telegram-poll] pairing redemption failed");
  }
}

// What the loop does after a failed poll: end the activation, wait the interval Telegram named, or back off on the transient-failure streak.
type FailureDisposition =
  | { readonly kind: "stop" }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "transient" };

async function handleFailure(
  options: TelegramPollingIngressOptions,
  reason: "unauthorized" | "conflict" | "rate-limited" | "unreachable" | "invalid-response",
  retryAfterMs: number | undefined,
  signal: AbortSignal,
): Promise<FailureDisposition> {
  if (reason === "unauthorized") {
    await safeFatal(options, "telegram-bot-token-rejected");
    return { kind: "stop" };
  }
  if (reason === "conflict") {
    // Classify by asking Telegram what it thinks is configured, never by parsing the 409 description: its contents are explicitly not stable.
    const info = await options.client.getWebhookInfo(signal);
    if (!info.ok) {
      // Unclassified is not "another poller": ending the connection with a reason nobody verified sends the owner after the wrong fix. Back off and let the
      // next poll's 409, if it recurs, be classified then.
      options.log?.("[telegram-poll] a poll conflict could not be classified; retrying");
      return { kind: "transient" };
    }
    await safeFatal(
      options,
      info.value.hasWebhook ? "telegram-webhook-conflict" : "telegram-poll-conflict",
    );
    return { kind: "stop" };
  }
  if (reason === "rate-limited") {
    return { kind: "wait", ms: Math.min(retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS, MAX_BACKOFF_MS) };
  }
  return { kind: "transient" };
}

async function safeFatal(
  options: TelegramPollingIngressOptions,
  code: TelegramPollingFatalCode,
): Promise<void> {
  try {
    await options.onFatal(code);
  } catch {
    options.log?.("[telegram-poll] fatal handler failed");
  }
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("telegram-polling-ingress-aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("telegram-polling-ingress-aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const TELEGRAM_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const TELEGRAM_MAX_RAW_BODY_BYTES = 64 * 1024;
// Telegram's Bot API limit is 4,096 UTF-16 code units per text message, the same unit `String.length` and the shared ingress core count. A code-point
// bound is not stricter, it is up to twice as permissive: 4,096 emoji are 8,192 units, which the Bot API rejects outright.
const TELEGRAM_MAX_TEXT_UTF16_UNITS = 4_096;
// Upper bound on how long a stop waits for already-queued safe deliveries.
const TELEGRAM_DELIVERY_DRAIN_TIMEOUT_MS = 2_000;

export interface TelegramBridgeServer {
  // Loopback port for the webhook path; null when updates are polled.
  readonly port: number | null;
}

// How one activation receives updates, and how that reception is torn down.
interface TelegramIngressHandle {
  readonly port: number | null;
  close(): Promise<void>;
  // Poll again now; see {@link TelegramPollingIngress.nudge}.
  nudge(): void;
}

// All activations share receipt, delivery, projection, and gateway policy; only runtime, verification, and ingress differ.
interface TelegramActivationPlan {
  readonly botToken: string;
  readonly botFingerprint: string;
  createRuntime(activationEpoch: number): Promise<TelegramPlatformRuntime>;
  readonly verifier: PlatformBridgeWebhookVerifier;
  startIngress(
    gateway: PlatformBridgeInboundGateway,
    onCallbackQuery?: (callback: TelegramCallbackQueryEnvelope) => Promise<void>,
  ): Promise<TelegramIngressHandle>;
  // Bind remote approvals to this activation’s runtime currency fence; absent attachment keeps approvals on the desktop.
  createRemoteApproval?(runtime: TelegramPlatformRuntime): TelegramRemoteApprovalCoordinator;
}

interface StartTelegramBridgeServerOptions {
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly conversationCommandPort: ConversationCommandPort;
  readonly getCurrentConversationId: () => string;
  // The transport the outbound delivery path runs on. Same option, same reason as on {@link StartTelegramConnectionBridgeOptions}.
  readonly networkFetch: typeof fetch;
  readonly receiptStore?: PlatformBridgeReceiptStore;
  readonly log?: (message: string) => void;
}

interface ActiveTelegramDeliveryDestination {
  readonly route: TelegramPlatformRoute;
  readonly channel: TelegramDeliveryChannel;
  generation: number | undefined;
}

interface ActiveTelegramBridge {
  readonly ingress: TelegramIngressHandle;
  readonly runtime: TelegramPlatformRuntime;
  readonly delivery: PlatformBridgeDeliveryAdapter<TelegramDeliveryChannel>;
  readonly deliveryDestinations: Map<string, ActiveTelegramDeliveryDestination>;
  // Retained so a stop can drain open sends before the adapter is closed.
  readonly channels: Map<string, PlatformBridgeDeliveryChannel>;
  readonly remoteApproval: TelegramRemoteApprovalCoordinator | undefined;
}

let activeBridge: ActiveTelegramBridge | null = null;
let startPromise: Promise<TelegramBridgeServer | null> | null = null;
let activeStartAttempt: number | null = null;
let startAttemptSequence = 0;
let stopPromise: Promise<void> | null = null;
let lifecycleGeneration = 0;
// Only app shutdown is terminal. An owner-initiated stop returns this module to a startable state so a later connect is a real reconnect rather than a
// silent permanent null.
let shutdownRequested = false;
let activationSequence = 0;

// Keep receipt ownership process-stable across reconnects so pending receipts settle instead of accumulating as unprunable outcome-unknown.
const installationReceiptOwnerId = randomUUID();

export interface StartTelegramConnectionBridgeOptions {
  readonly encryption: SecretEncryption;
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly conversationCommandPort: ConversationCommandPort;
  readonly getCurrentConversationId: () => string;
  // Process-held credential from the owner's encrypted store.
  readonly botToken: string;
  readonly botFingerprint: string;
  // Use the same required OS-aware transport for polling, control, delivery, and approval cards.
  readonly networkFetch: typeof fetch;
  readonly authority: TelegramPairedRouteAuthority;
  readonly pollOffset: () => number | null;
  readonly recordPollOffset: (offset: number) => Promise<void>;
  readonly hasPendingPairingCode: () => boolean;
  readonly redeemPairingCode: (codeDigest: string, senderId: string) => Promise<boolean>;
  readonly onFatal: (code: TelegramPollingFatalCode) => void | Promise<void>;
  readonly onPaired?: (senderId: string) => void | Promise<void>;
  // Poll-health transitions of this activation; see {@link TelegramPollingIngressOptions.onHealth}.
  readonly onPollHealth?: (health: TelegramPollHealth) => void;
  // Distinguishes an unshared owner from a stranger; only the former is answered.
  readonly isPairedOwner?: (senderId: string) => boolean;
  readonly notifyUnroutable?: (
    chatId: string,
    notice: TelegramControlNotice,
  ) => void | Promise<void>;
  readonly receiptStore?: PlatformBridgeReceiptStore;
  readonly log?: (message: string) => void;
  // The host approval gate, exposed only through the narrow remote-approval port. Present means the paired owner may decide parked tool approvals from a
  // button card; absent keeps approvals desk-only.
  readonly approvalGate?: TelegramRemoteApprovalGatePort;
  // Test-only injection; production builds a real Bot API client.
  readonly createBotApiClient?: (botToken: string) => TelegramBotApiClient;
  // The store the actor secret is derived from. Threaded rather than defaulted here so the caller's digester and this runtime read one secret: two
  // independently-defaulted stores would mint actor digests that disagree.
  readonly secretStore?: SecretStore;
}

// Receive through outbound polling without opening a listener, so Disconnect cannot leave a forwarding target behind.
export async function maybeStartTelegramConnectionBridge(
  options: StartTelegramConnectionBridgeOptions,
): Promise<TelegramBridgeServer | null> {
  if (shutdownRequested) return null;
  if (stopPromise) {
    await stopPromise;
    if (shutdownRequested) return null;
  }
  if (activeBridge) return Object.freeze({ port: activeBridge.ingress.port });
  if (startPromise) return await startPromise;

  const client = options.createBotApiClient
    ? options.createBotApiClient(options.botToken)
    : defaultBotApiClient(options.botToken, options.networkFetch);
  const plan: TelegramActivationPlan = {
    botToken: options.botToken,
    botFingerprint: options.botFingerprint,
    createRuntime: (activationEpoch) => Promise.resolve(createTelegramPairedPlatformRuntime({
      encryption: options.encryption,
      botFingerprint: options.botFingerprint,
      authority: options.authority,
      getCurrentConversationId: options.getCurrentConversationId,
      activationEpoch,
      ...(options.secretStore ? { secretStore: options.secretStore } : {}),
    })),
    verifier: createTelegramPollingVerifier(),
    startIngress: (gateway, onCallbackQuery) => {
      const poll = startTelegramPollingIngress({
        client,
        gateway,
        pollOffset: options.pollOffset,
        recordPollOffset: options.recordPollOffset,
        hasPendingPairingCode: options.hasPendingPairingCode,
        redeemPairingCode: options.redeemPairingCode,
        onFatal: options.onFatal,
        ...(options.onPaired ? { onPaired: options.onPaired } : {}),
        ...(options.onPollHealth ? { onHealth: options.onPollHealth } : {}),
        ...(options.isPairedOwner ? { isPairedOwner: options.isPairedOwner } : {}),
        ...(options.notifyUnroutable ? { notifyUnroutable: options.notifyUnroutable } : {}),
        ...(onCallbackQuery ? { onCallbackQuery } : {}),
        ...(options.log ? { log: options.log } : {}),
      });
      return Promise.resolve({
        port: null,
        close: async () => {
          poll.stop();
          await poll.finished;
        },
        nudge: () => poll.nudge(),
      });
    },
    // Remote approval exists only when BOTH the gate seam and the paired-owner predicate are wired: without the predicate no press could ever be attributed,
    // so offering cards would mint tokens nothing may consume.
    ...(options.approvalGate === undefined || options.isPairedOwner === undefined
      ? {}
      : {
        createRemoteApproval: (runtime: TelegramPlatformRuntime) =>
          createTelegramRemoteApprovalCoordinator({
            client,
            gate: options.approvalGate!,
            // The same currency the delivery fence enforces: the approval's conversation must be the route's bound conversation AND that route must still be current
            // (paired, shared, on screen).
            routeChatIdForConversation: (conversationId) => {
              for (const route of runtime.routes) {
                if (route.conversationId === conversationId && runtime.isRouteCurrent(route)) {
                  return route.chatId;
                }
              }
              return null;
            },
            isPairedOwner: options.isPairedOwner!,
            ...(options.log ? { log: options.log } : {}),
          }),
      }),
  };

  const attempt = ++startAttemptSequence;
  activeStartAttempt = attempt;
  const pending = startActivation(plan, {
    conversationSurfaceRuntime: options.conversationSurfaceRuntime,
    conversationCommandPort: options.conversationCommandPort,
    getCurrentConversationId: options.getCurrentConversationId,
    networkFetch: options.networkFetch,
    ...(options.receiptStore ? { receiptStore: options.receiptStore } : {}),
    ...(options.log ? { log: options.log } : {}),
  }, lifecycleGeneration);
  startPromise = pending;
  try {
    return await pending;
  } finally {
    if (activeStartAttempt === attempt) {
      startPromise = null;
      activeStartAttempt = null;
    }
  }
}

function defaultBotApiClient(
  botToken: string,
  fetchImplementation: typeof fetch,
): TelegramBotApiClient {
  return createTelegramBotApiClient({ botToken, fetchImplementation });
}

async function startActivation(
  plan: TelegramActivationPlan,
  options: StartTelegramBridgeServerOptions,
  generation: number,
): Promise<TelegramBridgeServer | null> {
  // Consumed only past the start checks, so a boot without a stored connection leaves the first real activation at epoch 1.
  const activationEpoch = ++activationSequence;
  const runtime = await plan.createRuntime(activationEpoch);
  if (generation !== lifecycleGeneration) {
    runtime.dispose();
    return null;
  }

  const receiptStore = options.receiptStore ?? createTelegramBridgeReceiptStore();
  const deliveryDestinations = new Map<string, ActiveTelegramDeliveryDestination>();
  const releaseDeliveryDestination = (channel: TelegramDeliveryChannel): void => {
    const lease = channel.deliveryLease;
    if (lease === undefined) return;
    const active = deliveryDestinations.get(lease);
    if (active?.channel === channel) deliveryDestinations.delete(lease);
  };
  const delivery = createPlatformBridgeDeliveryAdapter<TelegramDeliveryChannel>({
    transport: createTelegramOutboundTransport({
      botToken: plan.botToken,
      fetch: options.networkFetch,
      // Egress failures classify themselves into this sink (network / HTTP status / Bot API error code only); without it a failed send is indistinguishable from a delivered one.
      ...(options.log ? { log: options.log } : {}),
      isChannelCurrent: (channel, generation) => {
        const lease = channel.deliveryLease;
        if (lease === undefined) return false;
        const active = deliveryDestinations.get(lease);
        if (active === undefined || active.channel !== channel) return false;
        if (active.generation === undefined) active.generation = generation;
        return active.generation === generation && runtime.isRouteCurrent(active.route);
      },
    }),
    maxTextChars: TELEGRAM_MAX_TEXT_UTF16_UNITS,
    coalesceQueuedMessages: coalesceTelegramDeliveryQueue,
    onBackpressure: (channel) => {
      releaseDeliveryDestination(channel);
      options.log?.("[telegram-bridge] safe delivery closed after backpressure");
    },
    onDeliveryFailure: (channel, reason) => {
      releaseDeliveryDestination(channel);
      options.log?.(
        `[telegram-bridge] safe delivery closed after provider failure${
          reason !== undefined ? ` (${reason})` : ""
        }`,
      );
    },
  });
  const channels = new Map<string, PlatformBridgeDeliveryChannel>();
  const attachRoute = (route: TelegramPlatformRoute): void => {
    if (!runtime.isRouteCurrent(route)) return;
    const key = route.binding.routeId;
    const existing = channels.get(key);
    if (existing && !existing.state().closed) return;
    if (existing) channels.delete(key);
    for (const [lease, destination] of deliveryDestinations) {
      if (destination.route === route) deliveryDestinations.delete(lease);
    }
    const destination = Object.freeze({
      chatId: route.chatId,
      deliveryLease: randomUUID(),
    } satisfies TelegramDeliveryChannel);
    const channel = delivery.openChannel(destination, route.conversationId);
    deliveryDestinations.set(destination.deliveryLease!, { route, channel: destination, generation: undefined });
    channels.set(key, channel);
    channel.attach(
      options.conversationSurfaceRuntime.sharedProjection,
      () => ({ busy: options.conversationSurfaceRuntime.activity.isBusy() }),
    );
  };
  const authorize: PlatformBridgeInboundAuthorizer = (envelope) => {
    const authorization = runtime.authorize(envelope);
    if (authorization !== null && authorization !== undefined) {
      // Bots cannot start a user conversation themselves. A verified, paired user message is the earliest point at which a route may receive its safe snapshot
      // and future safe projection.
      const route = runtime.routeForEnvelope(envelope);
      if (route !== null) attachRoute(route);
    }
    return authorization;
  };
  const gateway = createPlatformBridgeInboundGateway({
    enabled: true,
    verifier: plan.verifier,
    authorize,
    receiptStore,
    commandPort: options.conversationCommandPort,
    maxRawBodyBytes: TELEGRAM_MAX_RAW_BODY_BYTES,
    // The gateway and Telegram's own verifier bound the same unit, so the core cannot admit a message the provider boundary would reject.
    maxTextChars: TELEGRAM_MAX_TEXT_UTF16_UNITS,
    receiptOwnerId: installationReceiptOwnerId,
    // Without this, every receipt reserve/settle/release failure and every submit or completion-registration throw is silent — exactly the states in which
    // an inbound message is permanently lost.
    ...(options.log ? { log: options.log } : {}),
  });

  // Created before ingress so the first polled press already has a handler, and disposed on every teardown path below so no card can outlive the
  // activation that minted its tokens.
  const remoteApproval = plan.createRemoteApproval?.(runtime);
  let ingress: TelegramIngressHandle;
  try {
    ingress = await plan.startIngress(
      gateway,
      remoteApproval === undefined
        ? undefined
        : (callback) => remoteApproval.handleCallbackQuery(callback),
    );
  } catch (error) {
    remoteApproval?.dispose();
    delivery.close();
    runtime.dispose();
    throw error;
  }
  if (generation !== lifecycleGeneration) {
    remoteApproval?.dispose();
    runtime.dispose();
    delivery.close();
    await ingress.close();
    return null;
  }

  activeBridge = { ingress, runtime, delivery, deliveryDestinations, channels, remoteApproval };
  options.log?.("[telegram-bridge] receiving updates over an outbound connection");
  return Object.freeze({ port: ingress.port });
}

async function stopActivation(): Promise<void> {
  lifecycleGeneration += 1;
  const pending = startPromise;
  const current = takeActiveBridge();
  if (current) await closeBridge(current);
  if (pending) await pending.catch(() => undefined);
  const late = takeActiveBridge();
  if (late) await closeBridge(late);
}

function takeActiveBridge(): ActiveTelegramBridge | null {
  const current = activeBridge;
  activeBridge = null;
  return current;
}

async function closeBridge(bridge: ActiveTelegramBridge): Promise<void> {
  // Invalidate first: an in-flight webhook that already passed header parsing cannot reserve a new command or publish a queued provider send afterwards.
  // The remote-approval detach is part of the same invalidation — a press arriving mid-teardown must find no live token.
  bridge.remoteApproval?.dispose();
  bridge.deliveryDestinations.clear();
  bridge.runtime.dispose();
  // Drain before closing: closed channels report idle immediately, and dispatched requests remain subject to their own timeout.
  await drainOpenChannels(bridge.channels);
  bridge.delivery.close();
  await bridge.ingress.close();
}

async function drainOpenChannels(
  channels: ReadonlyMap<string, PlatformBridgeDeliveryChannel>,
): Promise<void> {
  const open = [...channels.values()].filter((channel) => !channel.state().closed);
  if (open.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TELEGRAM_DELIVERY_DRAIN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([
      Promise.all(open.map((channel) => channel.waitForIdle())),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Ask the running activation, if any, to poll Telegram now — the machine woke from sleep or came back online. Returns whether there was one to ask; with
// none it does nothing, so a wake can never start a bridge the owner stopped.
export function nudgeTelegramBridgeServer(): boolean {
  if (activeBridge === null) return false;
  activeBridge.ingress.nudge();
  return true;
}

// Close Telegram ingress and egress. `"shutdown"` is terminal for the process; `"user"` leaves this module startable so the owner can reconnect.
export function stopTelegramBridgeServer(
  reason: "shutdown" | "user" = "shutdown",
): Promise<void> {
  // Latch synchronously at the entry point: a shutdown arriving while an owner-initiated stop is already in flight must still be terminal.
  if (reason === "shutdown") shutdownRequested = true;
  if (stopPromise) return stopPromise;
  const pending = stopActivation();
  const tracked = pending.finally(() => {
    if (stopPromise === tracked) stopPromise = null;
  });
  stopPromise = tracked;
  return tracked;
}

// @internal Test-only reset; production uses one immutable boot snapshot.
export function resetTelegramBridgeServerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("telegram-bridge-test-reset-outside-test");
  }
  if (activeBridge || startPromise || stopPromise || activeStartAttempt !== null) {
    throw new Error("telegram-bridge-test-reset-while-active");
  }
  lifecycleGeneration += 1;
  activationSequence = 0;
  shutdownRequested = false;
}

function createTelegramBridgeReceiptStore(): TailnetControllerReceiptStore {
  const namespace = openFeatureNamespace(TELEGRAM_BRIDGE_FEATURE);
  return createTailnetControllerReceiptStore({
    filePath: join(namespace.dir, "command-receipts.json"),
    ttlMs: TELEGRAM_RECEIPT_TTL_MS,
  });
}

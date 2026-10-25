import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { SettingsService } from "../data/settings-store.js";
import type { A2AMessage } from "../shared/a2a.js";
import type { ConversationLoop } from "./conversation-loop.js";
import { GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";
import {
  type ParentMailboxEntry,
  type ParentMailboxLoadDiagnostic,
  type SubAgentMessageMailbox,
} from "./subagent-message-mailbox.js";
import {
  canonicalizeAgentMessage,
  isSafeA2AMessageId,
  sanitizeA2ALabel,
  wrapChildReportForParentJudgment,
} from "./a2a-subagent-message-codec.js";

export { formatAgentMessage } from "./a2a-subagent-message-codec.js";
export interface ResolvedSubAgentAddress {
  parentSessionId: string;
  childSessionId: string;
  childTitle: string;
  /** Current-process fallback lease for an initial metadata write failure. */
  ephemeralMessageId?: string;
}

export interface DeliverToParentInput {
  parentSessionId: string;
  childSessionId: string;
  message: A2AMessage;
}

interface DeliveryAuditInput {
  parentSessionId: unknown;
  childSessionId: unknown;
  message?: unknown;
}

export type DeliverToParentResult =
  | { ok: true; disposition: "queued" | "mailbox" | "wake-requested"; messageId: string }
  | {
      ok: false;
      disposition: "dropped";
      reason:
        | "unknown-child"
        | "cross-origin"
        | "duplicate-message"
        | "invalid-message"
        | "unsupported-part"
        | "message-too-long"
        | "budget-exhausted"
        | "storage-failed"
        | "message-bus-unavailable";
    };

export type ParentWakeHandler = (parentSessionId: string) => Promise<void>;

// Persist before delivery; acknowledge only after injection so dropped guidance remains durable.
// Active guidance and in-flight wakes own delivery; other refusal reasons require an external change.
const SOFT_WAKE_REFUSALS = new Set(["turn-active", "wake-in-flight"]);

export class A2ASubAgentMessageBus {
  private wakeHandler: ParentWakeHandler | null = null;
  private readonly wakeInFlight = new Set<string>();
  // Spend the per-parent dirty token before waking; mailbox contents alone cannot bound retries.
  private readonly wakeDirty = new Map<string, DeliverToParentInput>();
  private readonly ephemeralLeasesByEntryId = new Map<string, {
    parentSessionId: string;
    childSessionId: string;
    messageId: string;
  }>();

  constructor(
    private readonly deps: {
      parentLoop: ConversationLoop;
      mailbox: SubAgentMessageMailbox;
      settingsService: SettingsService;
      auditLogger: AuditLogger;
      resolveChildAddress: (
        parentSessionId: string,
        childSessionId: string,
        messageId: string,
      ) => Promise<ResolvedSubAgentAddress | null>;
      releaseEphemeralChildAddress?: (
        parentSessionId: string,
        childSessionId: string,
        messageId: string,
      ) => void;
    },
  ) {}

  setWakeHandler(handler: ParentWakeHandler | null): void {
    this.wakeHandler = handler;
  }

  async peekParentMailbox(parentSessionId: string): Promise<ParentMailboxEntry[]> {
    const mailboxResult = typeof this.deps.mailbox.peekWithDiagnostics === "function"
      ? await this.deps.mailbox.peekWithDiagnostics(parentSessionId)
      : {
          entries: await this.deps.mailbox.peek(parentSessionId),
          diagnostics: [],
          cleanupFailed: false,
        };
    for (const diagnostic of mailboxResult.diagnostics) {
      this.auditPersistedDiagnostic(
        diagnostic,
        "dropped:" + diagnostic.reason,
      );
      if (!mailboxResult.cleanupFailed) {
        this.releaseEphemeralAddress(diagnostic);
      }
    }
    if (mailboxResult.cleanupFailed) {
      this.auditPersistedDiagnostic(
        undefined,
        "drop-cleanup-failed",
      );
    }

    const entries = mailboxResult.entries;
    const accepted: ParentMailboxEntry[] = [];
    const rejected: ParentMailboxEntry[] = [];

    for (const entry of entries) {
      const input: DeliverToParentInput = {
        parentSessionId,
        childSessionId: entry.childSessionId,
        message: entry.message,
      };
      let address: ResolvedSubAgentAddress | null;
      try {
        address = await this.deps.resolveChildAddress(
          parentSessionId,
          entry.childSessionId,
          entry.message.messageId,
        );
      } catch {
        // Lookup failures may be transient; retain the durable entry without injecting it.
        this.audit("warn", input, "dropped:storage-failed");
        continue;
      }

      if (!address) {
        this.audit("warn", input, "dropped:unknown-child");
        rejected.push(entry);
        continue;
      }
      if (
        entry.parentSessionId !== parentSessionId
        || address.parentSessionId !== parentSessionId
      ) {
        this.audit("warn", input, "dropped:cross-origin");
        rejected.push(entry);
        continue;
      }

      const canonical = canonicalizeAgentMessage(address, entry.message);
      let sameMessage = false;
      if (canonical.ok) {
        try {
          sameMessage = JSON.stringify(canonical.message) === JSON.stringify(entry.message);
        } catch {
          sameMessage = false;
        }
      }
      if (
        address.childSessionId !== entry.childSessionId
        || (address.ephemeralMessageId !== undefined
          && address.ephemeralMessageId !== entry.message.messageId)
        || !canonical.ok
        || canonical.detectionCount !== 0
        || !sameMessage
        || canonical.childTitle !== entry.childTitle
        || canonical.formattedText !== entry.formattedText
        || canonical.approvalLabel !== entry.approvalLabel
      ) {
        this.audit("warn", input, "dropped:invalid-message");
        rejected.push(entry);
        continue;
      }

      accepted.push({
        ...entry,
        childTitle: canonical.childTitle,
        message: canonical.message,
        formattedText: canonical.formattedText,
        approvalLabel: canonical.approvalLabel,
      });
    }

    if (rejected.length > 0) {
      const rejectedIds = rejected.map((entry) => entry.id);
      let removed = 0;
      try {
        removed = await this.deps.mailbox.acknowledge(parentSessionId, rejectedIds);
      } catch {
        // Failed copy-on-write persistence leaves rejected entries durable and quarantined.
      }
      if (removed !== rejectedIds.length) {
        for (const entry of rejected) {
          this.audit("warn", {
            parentSessionId,
            childSessionId: entry.childSessionId,
            message: entry.message,
          }, "drop-ack-failed");
        }
        return [];
      }
      for (const entry of rejected) {
        this.releaseEphemeralAddress(entry);
      }
    }

    return accepted;
  }

  async acknowledgeParentMailbox(
    parentSessionId: string,
    ids: readonly string[],
  ): Promise<number> {
    const removed = await this.deps.mailbox.acknowledge(parentSessionId, ids);
    if (removed === ids.length) {
      for (const id of ids) {
        const lease = this.ephemeralLeasesByEntryId.get(id);
        if (!lease) continue;
        this.deps.releaseEphemeralChildAddress?.(
          lease.parentSessionId,
          lease.childSessionId,
          lease.messageId,
        );
        this.ephemeralLeasesByEntryId.delete(id);
      }
    }
    return removed;
  }

  async deliverToParent(input: DeliverToParentInput): Promise<DeliverToParentResult> {
    const rawMessage = input.message as unknown;
    if (
      rawMessage === null
      || typeof rawMessage !== "object"
      || !isSafeA2AMessageId((rawMessage as { messageId?: unknown }).messageId)
    ) {
      return this.drop(input, "invalid-message");
    }

    let address: ResolvedSubAgentAddress | null;
    try {
      address = await this.deps.resolveChildAddress(
        input.parentSessionId,
        input.childSessionId,
        input.message.messageId,
      );
    } catch {
      return this.drop(input, "storage-failed");
    }
    if (!address) return this.drop(input, "unknown-child");
    if (address.parentSessionId !== input.parentSessionId) {
      return this.drop(input, "cross-origin");
    }
    if (
      address.childSessionId !== input.childSessionId
      || (address.ephemeralMessageId !== undefined
        && address.ephemeralMessageId !== input.message.messageId)
    ) {
      return this.drop(input, "invalid-message");
    }
    const canonical = canonicalizeAgentMessage(address, input.message);
    if (!canonical.ok) return this.drop(input, canonical.reason);

    let serializedMessage: string;
    try {
      serializedMessage = JSON.stringify(canonical.message);
    } catch {
      return this.drop(input, "invalid-message");
    }
    if (serializedMessage.length > GUIDE_MAX_CHARS) {
      return this.drop(input, "message-too-long");
    }
    if (canonical.formattedText.length > GUIDE_MAX_CHARS) {
      return this.drop(input, "message-too-long");
    }
    const deliveryInput: DeliverToParentInput = {
      ...input,
      message: canonical.message,
    };

    const entry: ParentMailboxEntry = {
      id: randomUUID(),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      childTitle: canonical.childTitle,
      createdAt: new Date().toISOString(),
      message: canonical.message,
      formattedText: canonical.formattedText,
      approvalLabel: canonical.approvalLabel,
    };
    let stored;
    try {
      stored = await this.deps.mailbox.enqueue(entry);
    } catch {
      return this.drop(input, "storage-failed");
    }
    if (!stored.ok) {
      const reason = stored.reason === "message-too-long"
        ? "message-too-long"
        : stored.reason === "duplicate-message"
          ? "duplicate-message"
          : "budget-exhausted";
      return this.drop(input, reason);
    }
    this.audit("info", deliveryInput, `stored:detections=${canonical.detectionCount}`);
    if (canonical.emptyBody) {
      // Audit empty producer reports even when the codec supplies a host-composed body.
      this.audit("warn", deliveryInput, "empty-body-fallback");
    }

    if (address.ephemeralMessageId !== undefined) {
      this.ephemeralLeasesByEntryId.set(entry.id, {
        parentSessionId: entry.parentSessionId,
        childSessionId: entry.childSessionId,
        messageId: address.ephemeralMessageId,
      });
    }

    // Mark durable delivery dirty before branching so every path owes one delivery attempt.
    this.wakeDirty.set(input.parentSessionId, deliveryInput);

    if (
      this.deps.parentLoop.getSessionId() === input.parentSessionId
      && this.deps.parentLoop.hasActiveTurn()
    ) {
      const queued = this.deps.parentLoop.queueGuidanceWithDisposition(
        wrapChildReportForParentJudgment(entry.formattedText),
        {
          approvalReasonPrefix: entry.approvalLabel,
          subAgentTitle: entry.childTitle,
          onInjected: () => this.acknowledgeParentMailbox(
            entry.parentSessionId,
            [entry.id],
          )
            .then((removed) => {
              if (removed === 1) {
                // Clear only the acknowledged token; a newer delivery may already own the parent slot.
                if (this.wakeDirty.get(entry.parentSessionId) === deliveryInput) {
                  this.wakeDirty.delete(entry.parentSessionId);
                }
              }
              this.audit(
                removed === 1 ? "info" : "warn",
                deliveryInput,
                removed === 1 ? "injected" : "ack-failed",
              );
            })
            .catch(() => this.audit("warn", deliveryInput, "ack-failed")),
          onDropped: (reason) => {
            this.audit("warn", deliveryInput, `deferred:${reason}`);
            // Turn cleanup will drain this token through its settlement notification.
            if (reason === "joined-limit") {
              // Undeliverable queued guidance must spend its token through the lease-aware wake handler.
              this.drain(entry.parentSessionId);
            }
          },
        },
      );
      if (queued === "queued") {
        return { ok: true, disposition: "queued", messageId: canonical.message.messageId };
      }
      this.audit("warn", deliveryInput, `deferred:${queued}`);
    }

    return this.drain(input.parentSessionId)
      ? { ok: true, disposition: "wake-requested", messageId: canonical.message.messageId }
      : { ok: true, disposition: "mailbox", messageId: canonical.message.messageId };
  }

  // Turn settlement retries owed delivery after the loop releases its lease.
  notifyTurnSettled(parentSessionId: string): void {
    this.drain(parentSessionId);
  }

  /** Spend a dirty token before waking; never re-arm from unconsumed mailbox contents.
   * Refused entries wait for a new delivery or the next manual turn. */
  private drain(parentSessionId: string): boolean {
    const input = this.wakeDirty.get(parentSessionId);
    if (input === undefined) return false;

    const refusals = this.wakeRefusalReasons(parentSessionId);
    // Active turns do not block lease-aware dispatch; every other refusal does.
    const blocking = refusals.filter((reason) => reason !== "turn-active");
    if (blocking.length > 0) {
      // Audit hard refusals; retain their token for re-evaluation on the next trigger.
      this.audit(
        blocking.every((reason) => SOFT_WAKE_REFUSALS.has(reason)) ? "info" : "warn",
        input,
        `mailbox-no-wake:${refusals.join(",")}`,
      );
      return false;
    }
    const handler = this.wakeHandler;
    if (handler === null) return false;

    // Spend before dispatch; deliveries arriving during the wake mint the next token.
    this.wakeDirty.delete(parentSessionId);
    this.wakeInFlight.add(parentSessionId);
    try {
      void handler(parentSessionId)
        .then(() => this.audit("info", input, "wake-finished"))
        .catch(() => this.audit("warn", input, "wake-failed"))
        .finally(() => {
          this.wakeInFlight.delete(parentSessionId);
          this.drain(parentSessionId);
        });
    } catch {
      // Synchronous handler throws must clear in-flight state or every future drain is blocked.
      this.wakeInFlight.delete(parentSessionId);
      this.wakeDirty.set(parentSessionId, input);
      this.audit("warn", input, "wake-failed");
      return false;
    }
    return true;
  }

  private releaseEphemeralAddress(
    entry: Pick<ParentMailboxEntry, "parentSessionId" | "childSessionId" | "message">
      | ParentMailboxLoadDiagnostic,
  ): void {
    const parentSessionId = entry.parentSessionId;
    const childSessionId = entry.childSessionId;
    const messageId = "message" in entry ? entry.message.messageId : entry.messageId;
    if (!parentSessionId || !childSessionId || !messageId) return;
    this.deps.releaseEphemeralChildAddress?.(
      parentSessionId,
      childSessionId,
      messageId,
    );
    for (const [entryId, lease] of this.ephemeralLeasesByEntryId) {
      if (
        lease.parentSessionId === parentSessionId
        && lease.childSessionId === childSessionId
        && lease.messageId === messageId
      ) {
        this.ephemeralLeasesByEntryId.delete(entryId);
      }
    }
  }

  private wakeFlagEnabled(): boolean {
    // Settings materialize features; the default guards only its optional type.
    return this.deps.settingsService.get("features")?.subAgentAutonomousWake ?? false;
  }

  /** Report every wake refusal so durable messages cannot stall without an audit reason. */
  private wakeRefusalReasons(parentSessionId: string): string[] {
    const reasons: string[] = [];
    if (!this.wakeFlagEnabled()) {
      reasons.push("flag-off");
    }
    if (this.deps.parentLoop.getSessionId() !== parentSessionId) {
      reasons.push("session-mismatch");
    }
    if (this.wakeHandler === null) reasons.push("handler-unregistered");
    if (this.deps.parentLoop.hasActiveTurn()) reasons.push("turn-active");
    if (this.wakeInFlight.has(parentSessionId)) reasons.push("wake-in-flight");
    return reasons;
  }

  private drop(
    input: DeliverToParentInput,
    reason: Exclude<DeliverToParentResult, { ok: true }>["reason"],
  ): DeliverToParentResult {
    this.audit("warn", input, `dropped:${reason}`);
    return { ok: false, disposition: "dropped", reason };
  }

  private auditPersistedDiagnostic(
    diagnostic: ParentMailboxLoadDiagnostic | undefined,
    outcome: string,
  ): void {
    this.audit("warn", {
      parentSessionId: diagnostic?.parentSessionId ?? "unknown",
      childSessionId: diagnostic?.childSessionId,
      message: { messageId: diagnostic?.messageId },
    }, outcome);
  }

  private audit(type: "info" | "warn", input: DeliveryAuditInput, outcome: string): void {
    const rawMessage = (input as { message?: unknown }).message;
    const rawMessageId = rawMessage !== null
      && typeof rawMessage === "object"
      && !Array.isArray(rawMessage)
      ? (rawMessage as { messageId?: unknown }).messageId
      : undefined;
    const messageId = isSafeA2AMessageId(rawMessageId) ? rawMessageId : "invalid";
    const parentSessionId = typeof input.parentSessionId === "string"
      ? input.parentSessionId
      : "unknown";
    const childSessionId = typeof input.childSessionId === "string"
      ? sanitizeA2ALabel(input.childSessionId)
      : "invalid";
    this.deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: parentSessionId || "unknown",
      type,
      input: `a2a:parent-delivery:${outcome}:child=${childSessionId}:message=${messageId}`,
    });
  }
}

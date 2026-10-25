/** Each side tracks registrations and must release its own resources even when the peer dies. */
import { randomUUID } from "node:crypto";
import type { SubscriptionCloseReason } from "./host-api-wire.js";

/** Run release exactly once; its reason determines whether to notify the peer and its ID identifies the registration. */
export type SubscriptionRelease<T> = (
  value: T,
  reason: SubscriptionCloseReason,
  subscriptionId: string,
) => void;

interface LedgerEntry<T> {
  readonly value: T;
  readonly release: SubscriptionRelease<T>;
}

export class SubscriptionLedgerEndedError extends Error {
  constructor(label: string, subscriptionId: string) {
    super(
      `[${label}] cannot open subscription '${subscriptionId}': the ledger has ended`,
    );
    this.name = "SubscriptionLedgerEndedError";
  }
}

/** Refuse duplicate IDs rather than lose a registration release. */
export class DuplicateSubscriptionError extends Error {
  constructor(label: string, subscriptionId: string) {
    super(`[${label}] subscription '${subscriptionId}' is already open`);
    this.name = "DuplicateSubscriptionError";
  }
}

/** Host and child share lifetime rules but provide their own release callbacks. */
export class SubscriptionLedger<T> {
  private readonly entries = new Map<string, LedgerEntry<T>>();
  private ended = false;

  /** Prefix errors with the owning side label. */
  constructor(private readonly label: string) {}

  get openCount(): number {
    return this.entries.size;
  }

  /** Derive kind counts from the live map so closure cannot desynchronize a second counter. */
  countWhere(matches: (value: T) => boolean): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (matches(entry.value)) count += 1;
    }
    return count;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  open(value: T, release: SubscriptionRelease<T>): string {
    const subscriptionId = randomUUID();
    this.adopt(subscriptionId, value, release);
    return subscriptionId;
  }

  /** Adopt peer IDs before events can arrive; duplicate IDs refuse rather than overwrite. */
  adopt(subscriptionId: string, value: T, release: SubscriptionRelease<T>): void {
    if (this.ended) {
      throw new SubscriptionLedgerEndedError(this.label, subscriptionId);
    }
    if (this.entries.has(subscriptionId)) {
      throw new DuplicateSubscriptionError(this.label, subscriptionId);
    }
    this.entries.set(subscriptionId, { value, release });
  }

  get(subscriptionId: string): T | undefined {
    return this.entries.get(subscriptionId)?.value;
  }

  /** Remove entries before invoking release so reentrant disposal stays idempotent; return whether one closed. */
  close(subscriptionId: string, reason: SubscriptionCloseReason): boolean {
    const entry = this.entries.get(subscriptionId);
    if (!entry) return false;
    this.entries.delete(subscriptionId);
    entry.release(entry.value, reason, subscriptionId);
    return true;
  }

  /** End once, release all live registrations and refuse new ones; return the count closed. */
  end(reason: SubscriptionCloseReason): number {
    this.ended = true;
    let closed = 0;
    // Iterate a snapshot because release callbacks can close sibling entries.
    for (const subscriptionId of [...this.entries.keys()]) {
      if (this.close(subscriptionId, reason)) closed += 1;
    }
    return closed;
  }
}

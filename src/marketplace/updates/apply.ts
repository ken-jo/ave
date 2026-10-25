/** Apply one package at a time when idle; escalation never bypasses the idle gate by itself.
 * Active component calls must drain, and shutdown lets only the already-started apply finish. */
import { errorMessage } from "../../shared/error-message.js";
import { isCommittedPluginGenerationPublicationError } from "../../plugins/committed-generation-publication-error.js";
import { CarriedApprovalWithdrawnError } from "../../plugins/plugin-contribution-trust.js";
import type { PackageKind } from "../catalog/types.js";
import { UpdateNeedsReviewError, type ConsentDelta } from "./consent.js";

export const ESCALATE_AFTER_MS = 30 * 60 * 1000;
export const CALLS_RETRY_MS = 5_000;

export type ApplyOutcome =
  | { state: "applied" | "approval-pending" }
  /** A durable commit whose generation failed to start is not an attempt. */
  | { state: "applied-not-running" }
  /** Consent deferral is not an attempt. */
  | { state: "needs-review"; delta: ConsentDelta | null }
  /** Pre-commit failure counts as an attempt and preserves the previous version. */
  | { state: "failed"; error: unknown }
  /** Changed install identity, policy, offer or settings supersedes the queued update without applying. */
  | { state: "superseded" };

function causes(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);
  const found: unknown[] = [error];
  if (error instanceof AggregateError) for (const inner of error.errors) found.push(...causes(inner, seen));
  if (error instanceof Error && error.cause !== undefined) found.push(...causes(error.cause, seen));
  return found;
}

/** Inspect nested causes and aggregates to distinguish consent, post-commit publication and pre-commit failure. */
export function classifyApplyError(error: unknown): Exclude<ApplyOutcome, { state: "approval-pending" | "superseded" }> {
  const all = causes(error);
  const review = all.find((item): item is UpdateNeedsReviewError => item instanceof UpdateNeedsReviewError);
  if (review) return { state: "needs-review", delta: review.delta };
  if (all.some((item) => item instanceof CarriedApprovalWithdrawnError)) return { state: "needs-review", delta: null };
  const committed = all.find(isCommittedPluginGenerationPublicationError);
  if (committed) return committed.outcome.state === "active" ? { state: "applied" } : { state: "applied-not-running" };
  return { state: "failed", error };
}

export interface ApplyItem {
  id: string;
  kind: PackageKind;
  name: string;
  provides: readonly string[];
  needs: readonly string[];
}

/** Capability providers precede consumers, with key ordering for ties and unsatisfiable cycles. */
export function applyOrder<T extends ApplyItem>(items: readonly T[]): T[] {
  const byKey = (left: T, right: T) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const plugins = items.filter((item) => item.kind === "plugin").sort(byKey);
  const rest = items.filter((item) => item.kind !== "plugin").sort(byKey);
  const ordered: T[] = [];
  const pending = [...plugins];
  while (pending.length > 0) {
    const ready = pending.find((item) => !item.needs.some((need) => pending.some((other) => other !== item && other.provides.includes(need))));
    const next = ready ?? pending[0]!;
    ordered.push(next);
    pending.splice(pending.indexOf(next), 1);
  }
  return [...ordered, ...rest];
}

export interface ApplyQueueOptions<T extends ApplyItem> {
  activity: { isBusy(): boolean; onIdle(listener: () => void): () => void };
  apply(item: T, signal: AbortSignal): Promise<ApplyOutcome>;
  callsInFlight(item: T): Promise<boolean>;
  /** Await outcome persistence before applying the next package. */
  settled(item: T, outcome: ApplyOutcome): Promise<void>;
  changed(): void;
  signal: AbortSignal;
  now(): number;
  log: { warn(message: string): void };
}

export interface ApplyQueueState {
  waitingSince: number | null;
  escalated: boolean;
  applying: string | null;
  queued: string[];
  waitingForCalls: string[];
}

export class ApplyQueue<T extends ApplyItem> {
  private items: T[] = [];
  private applying: T | null = null;
  private running: Promise<void> | null = null;
  private waitingSince: number | null = null;
  private escalated = false;
  private escalation: ReturnType<typeof setTimeout> | null = null;
  /** Apply now bypasses idle until the queue empties. */
  private forced = false;
  private readonly waitingForCalls = new Set<string>();
  /** Waits end on idle, timer, replacement or shutdown; Apply now ends only idle waits. */
  private waiting: { wake: () => void; idle: boolean } | null = null;
  /** Queue revisions invalidate readiness checks that awaited component calls. */
  private revision = 0;

  constructor(private readonly options: ApplyQueueOptions<T>) {
    options.signal.addEventListener("abort", () => {
      this.revision += 1;
      this.items = [];
      this.clearWait();
      this.waiting?.wake();
    }, { once: true });
  }

  /** Replace queued work without interrupting or duplicating the current apply. */
  replace(items: readonly T[]): void {
    if (this.options.signal.aborted) return;
    const applying = this.applying?.id;
    this.revision += 1;
    this.items = applyOrder(items.filter((item) => item.id !== applying));
    for (const id of [...this.waitingForCalls]) if (!this.items.some((item) => item.id === id)) this.waitingForCalls.delete(id);
    this.options.changed();
    if (this.items.length > 0) this.start();
    else this.waiting?.wake();
  }

  /** Remove ineligible queued work without affecting the current apply. */
  retain(keep: (item: T) => boolean): void {
    if (this.options.signal.aborted) return;
    const before = this.items.length;
    this.items = this.items.filter(keep);
    if (this.items.length === before) return;
    this.revision += 1;
    for (const id of [...this.waitingForCalls]) if (!this.items.some((item) => item.id === id)) this.waitingForCalls.delete(id);
    this.options.changed();
    if (this.items.length === 0) this.waiting?.wake();
  }

  /** Apply now bypasses idle, never active component-call waits. */
  applyNow(): void {
    if (this.options.signal.aborted || (this.items.length === 0 && !this.applying)) return;
    this.forced = true;
    if (this.waiting?.idle) this.waiting.wake();
    this.start();
  }

  state(): ApplyQueueState {
    return {
      waitingSince: this.waitingSince,
      escalated: this.escalated,
      applying: this.applying?.id ?? null,
      queued: this.items.map((item) => item.id),
      waitingForCalls: [...this.waitingForCalls],
    };
  }

  async drained(): Promise<void> {
    while (this.running) await this.running;
  }

  private start(): void {
    if (this.running || this.options.signal.aborted) return;
    this.running = this.work().catch((error: unknown) => {
      this.options.log.warn(`marketplace apply queue stopped: ${errorMessage(error)}`);
      this.items = [];
    }).finally(() => {
      this.running = null;
      this.forced = false;
      this.clearWait();
      this.options.changed();
    });
  }

  private async work(): Promise<void> {
    while (this.items.length > 0 && !this.options.signal.aborted) {
      if (!this.forced && this.options.activity.isBusy()) {
        await this.waitFor((wake) => this.options.activity.onIdle(wake));
        continue;
      }
      const revision = this.revision;
      const next = await this.nextReady(revision);
      if (this.options.signal.aborted) return;
      // Recheck if external queue changes invalidated the awaited result.
      if (this.revision !== revision) continue;
      if (!next) {
        // Wait for idle or a retry timer instead of polling active component calls.
        await this.waitFor((wake) => {
          const off = this.options.activity.onIdle(wake);
          const timer = setTimeout(wake, CALLS_RETRY_MS);
          timer.unref?.();
          return () => {
            off();
            clearTimeout(timer);
          };
        }, false);
        continue;
      }
      // Recheck conversation activity after awaiting the component-call check.
      if (!this.forced && this.options.activity.isBusy()) continue;
      this.clearWait();
      const at = this.items.indexOf(next);
      if (at < 0) throw new Error(`apply queue: ${next.id} was to start but is no longer queued`);
      this.items.splice(at, 1);
      this.waitingForCalls.delete(next.id);
      this.applying = next;
      this.options.changed();
      let outcome: ApplyOutcome;
      try {
        outcome = await this.options.apply(next, this.options.signal);
      } catch (error) {
        outcome = classifyApplyError(error);
      }
      this.applying = null;
      await this.options.settled(next, outcome);
      this.options.changed();
    }
  }

  /** Stop readiness checks when the queue revision changes during an await. */
  private async nextReady(revision: number): Promise<T | null> {
    for (const item of this.items) {
      if (item.kind !== "agent-plugin") return item;
      const busy = await this.options.callsInFlight(item);
      if (this.revision !== revision) return null;
      if (!busy) return item;
      if (!this.waitingForCalls.has(item.id)) {
        this.waitingForCalls.add(item.id);
        this.options.changed();
      }
    }
    return null;
  }

  /** Subscribe before rechecking idle; active-call waits require an event or timer, never polling. */
  private async waitFor(subscribe: (wake: () => void) => () => void, idle = true): Promise<void> {
    const off: { current: (() => void) | null } = { current: null };
    await new Promise<void>((resolve) => {
      let done = false;
      const wake = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.waiting = { wake, idle };
      off.current = subscribe(wake);
      if (this.options.signal.aborted) wake();
      else if (idle) {
        // Subscribed first, then read again: an idle moment in between is not missed.
        if (this.forced || !this.options.activity.isBusy()) wake();
        else this.startWaiting();
      }
    });
    off.current?.();
    this.waiting = null;
  }

  private startWaiting(): void {
    if (this.waitingSince !== null) return;
    this.waitingSince = this.options.now();
    this.options.changed();
    this.escalation = setTimeout(() => {
      this.escalation = null;
      if (this.waitingSince === null || this.options.signal.aborted) return;
      this.escalated = true;
      this.options.changed();
    }, ESCALATE_AFTER_MS);
    this.escalation.unref?.();
  }

  private clearWait(): void {
    if (this.escalation) clearTimeout(this.escalation);
    this.escalation = null;
    const changed = this.waitingSince !== null || this.escalated;
    this.waitingSince = null;
    this.escalated = false;
    if (changed && !this.options.signal.aborted) this.options.changed();
  }
}

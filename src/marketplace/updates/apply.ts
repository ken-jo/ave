/**
 * The apply queue (design §18.7.4): one package at a time, and only while
 * the conversation is idle.
 *
 * - **Idle gate, boot included.** A package starts only while
 *   `activity.isBusy()` is false. The queue subscribes to `onIdle` first and
 *   then rechecks, so an idle moment between the check and the subscription
 *   is not missed. The gate is read again right before each package starts,
 *   after every wait of its own (an agent plugin's call check); a turn that
 *   starts once a package is applying is not blocked.
 * - **Escalation, not a bound.** After 30 minutes of waiting the queue is
 *   `escalated`, which the Updates card and the toolbar show with *Apply
 *   now*. *Apply now* skips only the idle gate, for what is queued then; an
 *   agent plugin still waits for its calls. Without it the queue keeps
 *   waiting, as long as it takes.
 * - **An agent plugin** applies only while its running activation holds no
 *   call; otherwise it stays waiting and the queue moves on, trying it again
 *   on the next idle moment or {@link CALLS_RETRY_MS} later. Every wait ends
 *   on an event or a timer, never by polling.
 * - **Order**: extensions in dependency order (a provider of a capability
 *   before what requires it), then the rest by key.
 * - **Shutdown** (`signal`) starts nothing more. An apply already running
 *   finishes; its outcome is the caller's to drop.
 *
 * Each package is its own transaction; {@link classifyApplyError} turns what
 * an install throws into the outcome its update records (§18.7.4's table).
 */
import { errorMessage } from "../../shared/error-message.js";
import { isCommittedPluginGenerationPublicationError } from "../../plugins/committed-generation-publication-error.js";
import { CarriedApprovalWithdrawnError } from "../../plugins/plugin-contribution-trust.js";
import type { PackageKind } from "../catalog/types.js";
import { UpdateNeedsReviewError, type ConsentDelta } from "./consent.js";

/** How long the queue waits for idle before it tells the user (§18.7.4). */
export const ESCALATE_AFTER_MS = 30 * 60 * 1000;
/** How soon an agent plugin whose calls were running is tried again without an idle moment. */
export const CALLS_RETRY_MS = 5_000;

/** What one apply ended with. */
export type ApplyOutcome =
  /** Installed and running; `approval-pending`: a component of it is not approved (§18.7.2). */
  | { state: "applied" | "approval-pending" }
  /** Committed, but its generation did not start (§18.7.4). Not an attempt. */
  | { state: "applied-not-running" }
  /** A consent deferral: checkpoint two, or a carried approval withdrawn (§18.7.3). Not an attempt. */
  | { state: "needs-review"; delta: ConsentDelta | null }
  /** Failed before commit: the previous version stays. An attempt. */
  | { state: "failed"; error: unknown }
  /**
   * Nothing was done: what is installed is no longer what the update was
   * offered for (a user install or uninstall came first), or the policy,
   * the source or the switches no longer let it apply by itself.
   */
  | { state: "superseded" };

function causes(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);
  const found: unknown[] = [error];
  if (error instanceof AggregateError) for (const inner of error.errors) found.push(...causes(inner, seen));
  if (error instanceof Error && error.cause !== undefined) found.push(...causes(error.cause, seen));
  return found;
}

/**
 * The outcome of an install that threw (§18.7.4), from the error and every
 * cause and aggregated error under it: a consent deferral, a publication
 * failure after the durable commit, or a failure before commit.
 */
export function classifyApplyError(error: unknown): Exclude<ApplyOutcome, { state: "approval-pending" | "superseded" }> {
  const all = causes(error);
  const review = all.find((item): item is UpdateNeedsReviewError => item instanceof UpdateNeedsReviewError);
  if (review) return { state: "needs-review", delta: review.delta };
  if (all.some((item) => item instanceof CarriedApprovalWithdrawnError)) return { state: "needs-review", delta: null };
  const committed = all.find(isCommittedPluginGenerationPublicationError);
  if (committed) return committed.outcome.state === "active" ? { state: "applied" } : { state: "applied-not-running" };
  return { state: "failed", error };
}

/** One package the queue applies. */
export interface ApplyItem {
  /** `<sourceId>:<kind>:<name>` (`updateRecordKey`). */
  id: string;
  kind: PackageKind;
  name: string;
  /** An extension's capabilities and the capabilities it requires, for the order. */
  provides: readonly string[];
  needs: readonly string[];
}

/**
 * Extensions first, each after the queued extensions that provide what it
 * requires, ties by key; then everything else by key. A cycle cannot be
 * satisfied in any order: its members follow by key.
 */
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
  /** Apply one package; a throw is classified like the install's own. */
  apply(item: T, signal: AbortSignal): Promise<ApplyOutcome>;
  /** An agent plugin's running activation holds a call (§18.7.4). */
  callsInFlight(item: T): Promise<boolean>;
  /** One package ended; awaited before the next starts. */
  settled(item: T, outcome: ApplyOutcome): Promise<void>;
  /** What {@link ApplyQueue.state} answers changed. */
  changed(): void;
  /** The scheduler's shutdown. */
  signal: AbortSignal;
  now(): number;
  log: { warn(message: string): void };
}

export interface ApplyQueueState {
  /** Since when the queue waits for idle (epoch ms); null when it does not. */
  waitingSince: number | null;
  /** It has waited {@link ESCALATE_AFTER_MS}: *Apply now* is offered. */
  escalated: boolean;
  /** The package applying now. */
  applying: string | null;
  /** Queued, in order, the one applying excluded. */
  queued: string[];
  /** Agent plugins that wait for their calls. */
  waitingForCalls: string[];
}

export class ApplyQueue<T extends ApplyItem> {
  private items: T[] = [];
  private applying: T | null = null;
  private running: Promise<void> | null = null;
  private waitingSince: number | null = null;
  private escalated = false;
  private escalation: ReturnType<typeof setTimeout> | null = null;
  /** *Apply now*: the idle gate is skipped until the queue empties. */
  private forced = false;
  private readonly waitingForCalls = new Set<string>();
  /**
   * The current wait and what ends it: idle (or *Apply now*) for the idle
   * gate; idle or the retry timer for an agent plugin's calls; a replacement
   * or shutdown for either.
   */
  private waiting: { wake: () => void; idle: boolean } | null = null;

  constructor(private readonly options: ApplyQueueOptions<T>) {
    options.signal.addEventListener("abort", () => {
      this.items = [];
      this.clearWait();
      this.waiting?.wake();
    }, { once: true });
  }

  /**
   * Replace what is queued with `items` (an apply check's results, §18.7.1);
   * the package applying now is left alone, and not queued again.
   */
  replace(items: readonly T[]): void {
    if (this.options.signal.aborted) return;
    const applying = this.applying?.id;
    this.items = applyOrder(items.filter((item) => item.id !== applying));
    for (const id of [...this.waitingForCalls]) if (!this.items.some((item) => item.id === id)) this.waitingForCalls.delete(id);
    this.options.changed();
    if (this.items.length > 0) this.start();
    else this.waiting?.wake();
  }

  /**
   * Drop what is queued that `keep` refuses (a switch turned off, a version
   * skipped); the package applying now is left alone.
   */
  retain(keep: (item: T) => boolean): void {
    if (this.options.signal.aborted) return;
    const before = this.items.length;
    this.items = this.items.filter(keep);
    if (this.items.length === before) return;
    for (const id of [...this.waitingForCalls]) if (!this.items.some((item) => item.id === id)) this.waitingForCalls.delete(id);
    this.options.changed();
    if (this.items.length === 0) this.waiting?.wake();
  }

  /** *Apply now* (§18.7.4): skip the idle gate for what is queued; an agent plugin's call wait stays. */
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

  /** Resolves when the queue has nothing left to apply (tests, and the scheduler's *Check now*). */
  async drained(): Promise<void> {
    while (this.running) await this.running;
  }

  private start(): void {
    if (this.running || this.options.signal.aborted) return;
    this.running = this.work().catch((error: unknown) => {
      // A bug in the queue itself: what is queued waits for the next apply check.
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
      const next = await this.nextReady();
      if (this.options.signal.aborted) return;
      if (!next) {
        // Every package left is an agent plugin whose calls run: try again on the next idle moment or shortly.
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
      // The call check awaited: a conversation may have started meanwhile. Read the gate again before starting.
      if (!this.forced && this.options.activity.isBusy()) continue;
      this.clearWait();
      this.items.splice(this.items.indexOf(next), 1);
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

  /** The first queued package that may start: an agent plugin only while none of its calls runs. */
  private async nextReady(): Promise<T | null> {
    for (const item of this.items) {
      if (item.kind !== "agent-plugin") return item;
      if (!(await this.options.callsInFlight(item))) return item;
      if (!this.waitingForCalls.has(item.id)) {
        this.waitingForCalls.add(item.id);
        this.options.changed();
      }
    }
    return null;
  }

  /**
   * Wait until `subscribe`'s wake, a replacement or shutdown; for the idle
   * gate (`idle`), also *Apply now*. The idle gate's wait is subscribed first
   * and the gate read again, and it starts the escalation clock. *Apply now*
   * never ends another wait: an agent plugin's calls are waited for by event
   * or timer, not by polling.
   */
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

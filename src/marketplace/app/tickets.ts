/**
 * Single-use ids for install plans and source previews (design §13): an id
 * is taken once and expires after ten minutes, so a renderer cannot replay
 * a plan or act on one whose source has moved on meanwhile. Both are
 * PLAN_EXPIRED.
 */
import { randomBytes } from "node:crypto";
import { MarketplaceError } from "../errors.js";

const TICKET_TTL_MS = 10 * 60 * 1000;

interface Held<T> {
  value: T;
  expiresAt: number;
  slot: string | null;
  timer: ReturnType<typeof setTimeout>;
}

export class Tickets<T> {
  private readonly held = new Map<string, Held<T>>();
  /** The live ticket id per slot: a newer ticket for the same thing replaces the older one. */
  private readonly slots = new Map<string, string>();

  constructor(
    private readonly what: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = TICKET_TTL_MS,
    /** Called with a value dropped unused, e.g. to remove a preview's scratch clone. */
    private readonly onDrop?: (value: T) => void,
  ) {}

  private sweep(): void {
    const now = this.now();
    for (const [id, item] of this.held) {
      if (item.expiresAt <= now) this.drop(id, item);
    }
  }

  private release(id: string, item: Held<T>): void {
    clearTimeout(item.timer);
    this.held.delete(id);
    if (item.slot !== null && this.slots.get(item.slot) === id) this.slots.delete(item.slot);
  }

  private drop(id: string, item: Held<T>): void {
    this.release(id, item);
    this.onDrop?.(item.value);
  }

  /**
   * Hold `value` for the TTL. A value left unused is dropped when it expires even if no one asks
   * again, so a preview's clone or typed token does not outlive an abandoned dialog. Issuing into
   * an occupied `slot` drops the ticket held there: only the newest plan for one package is live.
   */
  issue(value: T, slot: string | null = null): { id: string; expiresAt: string } {
    this.sweep();
    if (slot !== null) {
      const previous = this.slots.get(slot);
      const item = previous === undefined ? undefined : this.held.get(previous);
      if (previous !== undefined && item) this.drop(previous, item);
    }
    const id = randomBytes(18).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    const timer = setTimeout(() => {
      const item = this.held.get(id);
      if (item) this.drop(id, item);
    }, this.ttlMs);
    timer.unref?.();
    this.held.set(id, { value, expiresAt, slot, timer });
    if (slot !== null) this.slots.set(slot, id);
    return { id, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Read without using it up; PLAN_EXPIRED when unknown or expired. */
  peek(id: string): T {
    this.sweep();
    const item = this.held.get(id);
    if (!item) throw new MarketplaceError("PLAN_EXPIRED", `the ${this.what} is no longer valid; start again`);
    return item.value;
  }

  /** Use the id up. */
  take(id: string): T {
    const value = this.peek(id);
    this.release(id, this.held.get(id)!);
    return value;
  }

  /** Drop every held value (shutdown). */
  clear(): void {
    for (const [id, item] of [...this.held]) this.drop(id, item);
  }
}

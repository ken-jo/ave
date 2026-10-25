/** Single-use tickets expire after ten minutes to prevent replay and stale-plan execution. */
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
  private readonly slots = new Map<string, string>();

  constructor(
    private readonly what: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = TICKET_TTL_MS,
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

  /** Expiry actively drops unused values; a newer ticket in the same slot drops the older one. */
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

  peek(id: string): T {
    this.sweep();
    const item = this.held.get(id);
    if (!item) throw new MarketplaceError("PLAN_EXPIRED", `the ${this.what} is no longer valid; start again`);
    return item.value;
  }

  take(id: string): T {
    const value = this.peek(id);
    this.release(id, this.held.get(id)!);
    return value;
  }

  clear(): void {
    for (const [id, item] of [...this.held]) this.drop(id, item);
  }
}

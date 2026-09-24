/**
 * Single-use ids for install plans and source previews (design §13): an id
 * is taken once and expires after ten minutes, so a renderer cannot replay
 * a plan or act on one whose source has moved on meanwhile. Both are
 * PLAN_EXPIRED.
 */
import { randomBytes } from "node:crypto";
import { MarketplaceError } from "../errors.js";

export const TICKET_TTL_MS = 10 * 60 * 1000;

interface Held<T> {
  value: T;
  expiresAt: number;
}

export class Tickets<T> {
  private readonly held = new Map<string, Held<T>>();

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
      if (item.expiresAt <= now) {
        this.held.delete(id);
        this.onDrop?.(item.value);
      }
    }
  }

  issue(value: T): { id: string; expiresAt: string } {
    this.sweep();
    const id = randomBytes(18).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.held.set(id, { value, expiresAt });
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
    this.held.delete(id);
    return value;
  }

  /** Drop every held value (shutdown). */
  clear(): void {
    for (const item of this.held.values()) this.onDrop?.(item.value);
    this.held.clear();
  }
}

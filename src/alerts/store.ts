/**
 * Open and closed alert identities: `~/.ave/alerts/open.json`.
 *
 * An identity is open while its card (or, for a card-less level, its
 * lifetime) runs, and closed once the user dismissed or accepted it, until
 * the lifetime it had would have ended. Both tables persist so a restart can
 * neither bring back what the user closed nor forget what is still open. The
 * file holds alert ids, kind ids and enums only — never a key, a slot value
 * or rendered text.
 */
import { join } from "node:path";
import type { AlertVisibility } from "../plugins/public-contract.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/is-record.js";
import { isAlertVisibility } from "../shared/alerts-types.js";
import { readJsonFileOrEmpty, writeJsonAtomic } from "../main/storage/feature-namespace.js";

const log = createLogger("alerts");

const STORE_FILE = "open.json";
const STORE_VERSION = 1;

export type AlertPriority = "low" | "normal" | "high";

const PRIORITY_RANK: Record<AlertPriority, number> = { low: 0, normal: 1, high: 2 };

function isAlertPriority(value: unknown): value is AlertPriority {
  return value === "low" || value === "normal" || value === "high";
}

/** Open alerts per kind; a further raise evicts the lowest priority, then the oldest. */
const MAX_OPEN_PER_KIND = 3;
/** Closed identities kept per plugin; the oldest leave first. */
export const MAX_CLOSED_PER_PLUGIN = 512;
/** Refreshes one identity may take per window, so re-raising cannot pin a card on top. */
export const MAX_REFRESHES_PER_WINDOW = 6;
export const REFRESH_WINDOW_MS = 10 * 60_000;

export interface OpenAlert {
  alertId: string;
  pluginId: string;
  kindId: string;
  priority: AlertPriority;
  visibility: AlertVisibility;
  raisedAt: number;
  expiresAt: number;
  /** Refresh times inside the current refresh window. */
  refreshes: number[];
}

interface ClosedAlert {
  alertId: string;
  pluginId: string;
  until: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hydrateOpen(value: unknown): OpenAlert | null {
  if (!isRecord(value)) return null;
  const { alertId, pluginId, kindId, priority, visibility, raisedAt, expiresAt, refreshes } = value;
  if (
    typeof alertId !== "string" || typeof pluginId !== "string" || typeof kindId !== "string"
    || !isAlertPriority(priority) || !isAlertVisibility(visibility)
    || !isFiniteNumber(raisedAt) || !isFiniteNumber(expiresAt)
    || !Array.isArray(refreshes) || !refreshes.every(isFiniteNumber)
  ) {
    return null;
  }
  return { alertId, pluginId, kindId, priority, visibility, raisedAt, expiresAt, refreshes: [...refreshes] };
}

function hydrateClosed(value: unknown): ClosedAlert | null {
  if (!isRecord(value)) return null;
  const { alertId, pluginId, until } = value;
  if (typeof alertId !== "string" || typeof pluginId !== "string" || !isFiniteNumber(until)) return null;
  return { alertId, pluginId, until };
}

export class AlertStore {
  private readonly openById = new Map<string, OpenAlert>();
  /** Insertion order is closing order, which is what the per-plugin cap evicts by. */
  private readonly closedById = new Map<string, ClosedAlert>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dir: () => string) {}

  /** Read the file; entries already past their lifetime are left behind. */
  async load(now: number): Promise<void> {
    const parsed = await readJsonFileOrEmpty<unknown>(join(this.dir(), STORE_FILE), () => null, (value) => value);
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION) return;
    for (const raw of Array.isArray(parsed.open) ? parsed.open : []) {
      const entry = hydrateOpen(raw);
      if (entry && entry.expiresAt > now) this.openById.set(entry.alertId, entry);
    }
    for (const raw of Array.isArray(parsed.closed) ? parsed.closed : []) {
      const entry = hydrateClosed(raw);
      if (entry && entry.until > now) this.closedById.set(entry.alertId, entry);
    }
  }

  getOpen(alertId: string): OpenAlert | undefined {
    return this.openById.get(alertId);
  }

  listOpen(): OpenAlert[] {
    return [...this.openById.values()];
  }

  isClosed(alertId: string, now: number): boolean {
    const closed = this.closedById.get(alertId);
    return closed !== undefined && closed.until > now;
  }

  /**
   * Open a new identity. Returns the alerts it evicted from its kind to stay
   * within {@link MAX_OPEN_PER_KIND}: the lowest priority, then the oldest.
   */
  add(entry: OpenAlert): OpenAlert[] {
    const sameKind = [...this.openById.values()].filter(
      (open) => open.pluginId === entry.pluginId && open.kindId === entry.kindId,
    );
    const evicted: OpenAlert[] = [];
    while (sameKind.length - evicted.length >= MAX_OPEN_PER_KIND) {
      const remaining = sameKind.filter((open) => !evicted.includes(open));
      remaining.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.raisedAt - b.raisedAt);
      evicted.push(remaining[0]!);
    }
    for (const gone of evicted) this.openById.delete(gone.alertId);
    this.openById.set(entry.alertId, entry);
    this.persist();
    return evicted;
  }

  /** Charge one refresh to an open identity; `false` when its window is spent, and nothing changes. */
  refresh(alertId: string, now: number, update: { expiresAt: number; priority: AlertPriority }): boolean {
    const open = this.openById.get(alertId);
    if (!open) throw new Error(`AlertStore.refresh: ${alertId} is not open`);
    const recent = open.refreshes.filter((at) => now - at < REFRESH_WINDOW_MS);
    if (recent.length >= MAX_REFRESHES_PER_WINDOW) return false;
    this.openById.set(alertId, { ...open, ...update, refreshes: [...recent, now] });
    this.persist();
    return true;
  }

  /** The user dismissed or accepted it: it stays closed until the lifetime it had would have ended. */
  close(alertId: string): OpenAlert | undefined {
    const open = this.openById.get(alertId);
    if (!open) return undefined;
    this.openById.delete(alertId);
    this.closedById.delete(alertId);
    this.closedById.set(alertId, { alertId, pluginId: open.pluginId, until: open.expiresAt });
    const ofPlugin = [...this.closedById.values()].filter((closed) => closed.pluginId === open.pluginId);
    for (const oldest of ofPlugin.slice(0, Math.max(0, ofPlugin.length - MAX_CLOSED_PER_PLUGIN))) {
      this.closedById.delete(oldest.alertId);
    }
    this.persist();
    return open;
  }

  /** Withdrawn by its plugin: it leaves without closing, so a later raise opens it again. */
  remove(alertId: string): OpenAlert | undefined {
    const open = this.openById.get(alertId);
    if (!open) return undefined;
    this.openById.delete(alertId);
    this.persist();
    return open;
  }

  /** Every open alert past its lifetime, removed; closed entries past theirs are dropped too. */
  expire(now: number): OpenAlert[] {
    const expired = [...this.openById.values()].filter((open) => open.expiresAt <= now);
    for (const open of expired) this.openById.delete(open.alertId);
    let closedChanged = false;
    for (const closed of [...this.closedById.values()]) {
      if (closed.until <= now) {
        this.closedById.delete(closed.alertId);
        closedChanged = true;
      }
    }
    if (expired.length > 0 || closedChanged) this.persist();
    return expired;
  }

  /** Every open alert of a plugin that is gone, removed. Closed identities stay: a reinstall must not reopen them. */
  removePlugin(pluginId: string): OpenAlert[] {
    const removed = [...this.openById.values()].filter((open) => open.pluginId === pluginId);
    for (const open of removed) this.openById.delete(open.alertId);
    if (removed.length > 0) this.persist();
    return removed;
  }

  /** Resolves once every queued write has settled. */
  flush(): Promise<void> {
    return this.writes;
  }

  private persist(): void {
    const file = {
      version: STORE_VERSION,
      open: [...this.openById.values()],
      closed: [...this.closedById.values()],
    };
    this.writes = this.writes.then(() => writeJsonAtomic(this.dir(), STORE_FILE, file)).catch((err: unknown) => {
      // The in-memory tables still hold for this session.
      log.warn(`could not persist open alerts: ${errorMessage(err)}`);
    });
  }
}

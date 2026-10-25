/** Persist open and closed identities across restarts, containing ids and enums only; never keys, slots, or rendered text. */
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

/** Evict the lowest priority, then oldest, when a kind exceeds its open cap. */
const MAX_OPEN_PER_KIND = 3;
/** Evict the oldest closed identities when a plugin exceeds its cap. */
export const MAX_CLOSED_PER_PLUGIN = 512;
/** Bound refreshes so repeated raises cannot pin cards to the top. */
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
  /** Insertion order preserves closing order for cap eviction. */
  private readonly closedById = new Map<string, ClosedAlert>();
  private writes: Promise<void> = Promise.resolve();
  private writeQueued = false;

  constructor(private readonly dir: () => string) {}

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

  /** Return evicted alerts in priority-then-age order. */
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

  /** A spent refresh window returns false without mutation. */
  refresh(alertId: string, now: number, update: { expiresAt: number; priority: AlertPriority }): boolean {
    const open = this.openById.get(alertId);
    if (!open) throw new Error(`AlertStore.refresh: ${alertId} is not open`);
    const recent = open.refreshes.filter((at) => now - at < REFRESH_WINDOW_MS);
    if (recent.length >= MAX_REFRESHES_PER_WINDOW) return false;
    this.openById.set(alertId, { ...open, ...update, refreshes: [...recent, now] });
    this.persist();
    return true;
  }

  /** Answered identities remain closed until their original expiry. */
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

  /** Withdrawal does not close an identity; a later raise may reopen it. */
  remove(alertId: string): OpenAlert | undefined {
    const open = this.openById.get(alertId);
    if (!open) return undefined;
    this.openById.delete(alertId);
    this.persist();
    return open;
  }

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

  /** Retain closed identities on uninstall so reinstall cannot reopen them. */
  removePlugin(pluginId: string): OpenAlert[] {
    const removed = [...this.openById.values()].filter((open) => open.pluginId === pluginId);
    for (const open of removed) this.openById.delete(open.alertId);
    if (removed.length > 0) this.persist();
    return removed;
  }

  flush(): Promise<void> {
    return this.writes;
  }

  /** Coalesce queued mutations into one write of the latest tables. */
  private persist(): void {
    if (this.writeQueued) return;
    this.writeQueued = true;
    this.writes = this.writes.then(() => {
      this.writeQueued = false;
      const file = {
        version: STORE_VERSION,
        open: [...this.openById.values()],
        closed: [...this.closedById.values()],
      };
      return writeJsonAtomic(this.dir(), STORE_FILE, file);
    }).catch((err: unknown) => {
      log.warn(`could not persist open alerts: ${errorMessage(err)}`);
    });
  }
}

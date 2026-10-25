/** Refused raises must not charge cooldown or rate windows. */
import type { AlertVisibility } from "../plugins/public-contract.js";

export const ALERT_KIND_COOLDOWN_MS = 5 * 60_000;
export const ALERT_RATE_WINDOW_MS = 60_000;
export const ALERT_RATE_MAX_CALLS = 6;

const TTL_MIN_MS = 60_000;
const TTL_MAX_MS = 7 * 24 * 60 * 60_000;
const TTL_DEFAULT_MS = 24 * 60 * 60_000;

/** Clamp TTL to one minute–seven days; reject non-numeric input. */
export function clampTtl(ttlMs: unknown): number | null {
  if (ttlMs === undefined) return TTL_DEFAULT_MS;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) return null;
  return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, ttlMs));
}

const VISIBILITY_RANK: Record<AlertVisibility, number> = { silent: 0, "summary-only": 1, "user-visible": 2 };

/** A raise may lower declared visibility, never increase it. */
export function effectiveVisibility(declared: AlertVisibility, requested: AlertVisibility | undefined): AlertVisibility {
  if (requested === undefined) return declared;
  return VISIBILITY_RANK[requested] < VISIBILITY_RANK[declared] ? requested : declared;
}

export interface InstalledPredecessor {
  /** Null means the install has no bound marketplace source. */
  sourceId: string | null;
  revoked: boolean;
}

/** Only the expected or unbound source can block successors. Loaded predecessors still block after mid-session revocation. */
export function predecessorBlocks(input: {
  installed: InstalledPredecessor | null;
  loaded: boolean;
  sourceHint: string;
}): boolean {
  const { installed, loaded, sourceHint } = input;
  if (installed === null && !loaded) return false;
  const sourceId = installed?.sourceId ?? null;
  if (sourceId !== null && sourceId !== sourceHint) return false;
  if (loaded) return true;
  return installed !== null && !installed.revoked;
}

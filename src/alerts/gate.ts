/**
 * The rules of the raise pipeline that decide without side effects: whether a
 * predecessor still blocks a kind, the effective visibility, the card
 * lifetime, and the budgets. `service.ts` runs them in order and records
 * windows only after an alert is accepted, so a refusal never charges one.
 */
import type { AlertVisibility } from "../plugins/public-contract.js";

/** One fire per kind per window. */
export const ALERT_KIND_COOLDOWN_MS = 5 * 60_000;
/** Raises per plugin per rate window, in a bucket of their own. */
export const ALERT_RATE_WINDOW_MS = 60_000;
export const ALERT_RATE_MAX_CALLS = 6;

const TTL_MIN_MS = 60_000;
const TTL_MAX_MS = 7 * 24 * 60 * 60_000;
const TTL_DEFAULT_MS = 24 * 60 * 60_000;

/** The card lifetime, clamped to 1 minute – 7 days; `null` when `ttlMs` is not a number at all. */
export function clampTtl(ttlMs: unknown): number | null {
  if (ttlMs === undefined) return TTL_DEFAULT_MS;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) return null;
  return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, ttlMs));
}

const VISIBILITY_RANK: Record<AlertVisibility, number> = { silent: 0, "summary-only": 1, "user-visible": 2 };

/** A raise may lower the declared visibility, never raise it. */
export function effectiveVisibility(declared: AlertVisibility, requested: AlertVisibility | undefined): AlertVisibility {
  if (requested === undefined) return declared;
  return VISIBILITY_RANK[requested] < VISIBILITY_RANK[declared] ? requested : declared;
}

/** What the host knows about the installed package that carries a predecessor's name. */
export interface InstalledPredecessor {
  /** The marketplace source the package is bound to; `null` when it was never bound. */
  sourceId: string | null;
  revoked: boolean;
}

/**
 * Whether the predecessor a kind inherits from still owns the user's choice.
 *
 * Only a package from the expected source counts — the hint the successor
 * carries, or no bound source at all, which an old or never-bound install
 * has and which must block rather than double. A same-named package from an
 * unrelated source never blocks. A matching package blocks while it is
 * loaded (a revocation applied mid-session does not stop a running plugin),
 * or while it is installed and not revoked.
 */
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

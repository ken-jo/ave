/**
 * When each declared overlay suggestion was last accepted.
 *
 * A plugin that declares an `alerts` block raises its recurring alerts
 * through the alert pipeline and keeps `triggerConversation` for one-time
 * suggestions only: a declared source is accepted at most once per 30 days.
 * The window has to outlive a restart — a watcher that re-emits after every
 * boot would otherwise get a fresh suggestion each time — so acceptances are
 * kept in `~/.ave/alerts/suggestions.json`.
 *
 * An acceptance is the trigger gate's `accepted: true`, not the user's click:
 * the limit bounds how often a plugin may put a suggestion in front of the
 * user, whatever the user then does with it.
 */
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/is-record.js";
import {
  openFeatureNamespace,
  readJsonFileOrEmpty,
  writeJsonAtomic,
} from "../main/storage/feature-namespace.js";

const log = createLogger("alerts");

export const SUGGESTION_ACCEPTANCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const LEDGER_FILE = "suggestions.json";
const LEDGER_VERSION = 1;

/** `pluginId` → declared source → epoch ms of the last acceptance. */
type Acceptances = Map<string, Map<string, number>>;

interface LedgerFile {
  version: typeof LEDGER_VERSION;
  accepted: Record<string, Record<string, number>>;
}

/**
 * Keep only well-formed entries; a damaged entry is not an acceptance anyone
 * relies on. Expired ones are harmless — {@link SuggestionLedger.isLimited}
 * reads the window — and leave the file at the next write.
 */
function hydrate(parsed: unknown): Acceptances {
  const out: Acceptances = new Map();
  if (!isRecord(parsed) || parsed.version !== LEDGER_VERSION || !isRecord(parsed.accepted)) return out;
  for (const [pluginId, sources] of Object.entries(parsed.accepted)) {
    if (!isRecord(sources)) continue;
    for (const [source, at] of Object.entries(sources)) {
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      let bySource = out.get(pluginId);
      if (!bySource) out.set(pluginId, (bySource = new Map()));
      bySource.set(source, at);
    }
  }
  return out;
}

export class SuggestionLedger {
  private acceptances: Acceptances | null = null;
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: () => string = () => openFeatureNamespace("alerts").dir,
    private readonly windowMs: number = SUGGESTION_ACCEPTANCE_WINDOW_MS,
  ) {}

  /** Read the file once; every gate call awaits this before it asks {@link isLimited}. */
  load(): Promise<void> {
    this.loading ??= readJsonFileOrEmpty<Acceptances>(
      join(this.dir(), LEDGER_FILE),
      () => new Map(),
      hydrate,
    ).then(
      (acceptances) => {
        this.acceptances = acceptances;
      },
      (err: unknown) => {
        // Let the next call read again rather than pinning one failed read.
        this.loading = null;
        throw err;
      },
    );
    return this.loading;
  }

  private loaded(): Acceptances {
    if (this.acceptances === null) {
      throw new Error("SuggestionLedger used before load() resolved");
    }
    return this.acceptances;
  }

  /** Whether `source` was accepted for `pluginId` within the window. A clock set back keeps the limit. */
  isLimited(pluginId: string, source: string, now: number): boolean {
    const at = this.loaded().get(pluginId)?.get(source);
    return at !== undefined && now - at < this.windowMs;
  }

  /** Record an acceptance in memory at once, and queue the write that makes it survive a restart. */
  record(pluginId: string, source: string, now: number): void {
    const acceptances = this.loaded();
    let bySource = acceptances.get(pluginId);
    if (!bySource) acceptances.set(pluginId, (bySource = new Map()));
    bySource.set(source, now);
    for (const [id, sources] of acceptances) {
      for (const [declared, at] of sources) {
        if (now - at >= this.windowMs) sources.delete(declared);
      }
      if (sources.size === 0) acceptances.delete(id);
    }
    const file: LedgerFile = {
      version: LEDGER_VERSION,
      accepted: Object.fromEntries(
        [...acceptances].map(([id, sources]) => [id, Object.fromEntries(sources)]),
      ),
    };
    this.writes = this.writes.then(() => writeJsonAtomic(this.dir(), LEDGER_FILE, file)).catch((err: unknown) => {
      // The in-memory entry still holds the limit for this session.
      log.warn(`could not persist suggestion acceptances: ${errorMessage(err)}`);
    });
  }

  /** Resolves once every queued write has settled. */
  flush(): Promise<void> {
    return this.writes;
  }
}

export const suggestionLedger = new SuggestionLedger();

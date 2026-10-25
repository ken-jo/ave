/** Persist one acceptance per declared source per 30 days. Acceptance means gate admission, regardless of whether the user clicks. */
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

type Acceptances = Map<string, Map<string, number>>;

interface LedgerFile {
  version: typeof LEDGER_VERSION;
  accepted: Record<string, Record<string, number>>;
}

/** Drop malformed entries; expire valid entries on the next write. */
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

  /** Clock rollback must not reset the acceptance window. */
  isLimited(pluginId: string, source: string, now: number): boolean {
    const at = this.loaded().get(pluginId)?.get(source);
    return at !== undefined && now - at < this.windowMs;
  }

  /** Record in memory immediately, then queue persistence. */
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
      log.warn(`could not persist suggestion acceptances: ${errorMessage(err)}`);
    });
  }

  flush(): Promise<void> {
    return this.writes;
  }
}

export const suggestionLedger = new SuggestionLedger();

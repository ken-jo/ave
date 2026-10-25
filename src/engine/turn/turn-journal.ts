// Serialize row appends in history order and throttle partial snapshots to bound crash loss.
// Host exit aborts running turns and waits for bounded settlement; final saves remain the commit point.
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
import { createLogger } from "../../lib/logger.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { MAX_TURN_PARTIAL_CHARS } from "../../memory/session-turn-journal.js";
import type { ConversationHistory, StoredMessage } from "../conversation-history.js";

const log = createLogger("turn-journal");

const DEFAULT_PARTIAL_INTERVAL_MS = 1_000;

type JournalStore = Pick<
  MemoryManager,
  "appendSessionProgress" | "beginTurnJournal" | "writeTurnPartial" | "endTurnJournal" | "clearTurnJournal"
>;

export interface TurnJournalOptions {
  partialIntervalMs?: number;
  now?: () => number;
}

export class TurnJournal {
  private readonly startedAt: number;
  private readonly partialIntervalMs: number;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private open = false;
  private roundRowId: string | undefined;
  private pendingPartial: (() => { content: string; thought?: string }) | undefined;
  private partialTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPartialWriteAt = Number.NEGATIVE_INFINITY;
  private lastWrittenPartialId: string | undefined;

  constructor(
    private readonly store: JournalStore,
    private readonly sessionId: string,
    private readonly history: ConversationHistory,
    options: TurnJournalOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.partialIntervalMs = options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS;
    this.startedAt = this.now();
  }

  // Start after accepted input is durable so progress appends extend the correct baseline.
  async begin(): Promise<void> {
    if (this.open) return;
    try {
      await this.store.beginTurnJournal(this.sessionId, this.startedAt);
    } catch (err) {
      // Journal setup is best-effort and must not take down the turn.
      log.warn("turn journal could not open: %s", err);
      return;
    }
    this.open = true;
    this.history.setAppendObserver((message) => this.onAppend(message));
  }

  // Share snapshot and committed row IDs so recovery can suppress already-committed partials.
  currentRoundRowId(): string {
    this.roundRowId ??= createDlpSafeUuid();
    return this.roundRowId;
  }

  // Every committed, interrupted, or notice row starts a fresh round ID and clears pending text.
  private roundEnded(): string | undefined {
    const ended = this.roundRowId;
    this.roundRowId = undefined;
    this.pendingPartial = undefined;
    if (this.partialTimer !== undefined) {
      clearTimeout(this.partialTimer);
      this.partialTimer = undefined;
    }
    return ended;
  }

  private onAppend(message: StoredMessage): void {
    const endedRoundId = message.role === "assistant" ? this.roundEnded() : undefined;
    // Persist replacement rows before clearing partials or a crash can lose both copies.
    this.chain = this.chain.then(async () => {
      const persisted = await this.syncRows();
      if (persisted && endedRoundId !== undefined && message.meta.messageId !== endedRoundId) {
        await this.clearPartialIfStill(endedRoundId);
      }
    });
  }

  private async clearPartialIfStill(roundId: string): Promise<void> {
    if (!this.open || this.lastWrittenPartialId !== roundId) return;
    try {
      await this.store.writeTurnPartial(this.sessionId, this.startedAt, undefined);
      this.lastWrittenPartialId = undefined;
    } catch (err) {
      log.warn("turn partial clear failed: %s", err);
    }
  }

  // Render only when writing a snapshot so burst deltas cost one render per interval.
  notePartial(render: () => { content: string; thought?: string }): void {
    if (!this.open) return;
    this.pendingPartial = render;
    if (this.partialTimer !== undefined) return;
    const wait = Math.max(0, this.lastPartialWriteAt + this.partialIntervalMs - this.now());
    this.partialTimer = setTimeout(() => {
      this.partialTimer = undefined;
      this.writePartial();
    }, wait);
    this.partialTimer.unref?.();
  }

  private writePartial(): void {
    const render = this.pendingPartial;
    if (!this.open || render === undefined) return;
    this.pendingPartial = undefined;
    this.lastPartialWriteAt = this.now();
    const { content, thought } = render();
    const messageId = this.currentRoundRowId();
    const partial = {
      messageId,
      content: content.slice(0, MAX_TURN_PARTIAL_CHARS),
      ...(thought ? { thought: thought.slice(0, MAX_TURN_PARTIAL_CHARS) } : {}),
      updatedAt: this.lastPartialWriteAt,
    };
    // Serialize snapshots with row appends so superseded data reaches disk in order.
    this.chain = this.chain.then(async () => {
      if (!this.open) return;
      try {
        await this.store.writeTurnPartial(this.sessionId, this.startedAt, partial);
        this.lastWrittenPartialId = messageId;
      } catch (err) {
        log.warn("turn partial snapshot failed: %s", err);
      }
    });
  }

  private async syncRows(): Promise<boolean> {
    // Read under the transcript lock so queued appends cannot overwrite a newer save.
    if (!this.open) return false;
    try {
      await this.store.appendSessionProgress(this.sessionId, () => this.history.getMessages());
      return true;
    } catch (err) {
      log.warn("turn progress append failed: %s", err);
      return false;
    }
  }

  async settled(): Promise<void> {
    await this.chain;
  }

  // Remove recovery sidecars only after successful transcript sync; best-effort final saves may fail.
  async end(): Promise<void> {
    if (!this.open) return;
    this.history.setAppendObserver(undefined);
    this.roundEnded();
    await this.chain;
    const persisted = await this.syncRows();
    this.open = false;
    try {
      this.store.endTurnJournal(this.sessionId);
      if (persisted) this.store.clearTurnJournal(this.sessionId);
    } catch (err) {
      log.warn("turn journal could not close: %s", err);
    }
  }
}

class HostExitAbortError extends Error {
  readonly hostExit = true as const;
  constructor() {
    super("application shutdown");
    this.name = "HostExitAbortError";
  }
}

export function isHostExitAbort(reason: unknown): boolean {
  return reason instanceof HostExitAbortError;
}

interface RunningTurn {
  readonly abort: (reason: Error) => void;
  readonly settled: Promise<void>;
}

const runningTurns = new Set<RunningTurn>();

// Settle registration in finally after the last persistence step.
export function registerRunningTurn(abort: (reason: Error) => void): { settle(): void } {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const entry: RunningTurn = { abort, settled };
  runningTurns.add(entry);
  return {
    settle(): void {
      runningTurns.delete(entry);
      settle();
    },
  };
}

/** Abort every running loop on host exit and wait within the deadline for interrupted records.
 * Timed-out turns retain their crash journal. */
export async function interruptRunningTurnsForExit(
  timeoutMs: number,
): Promise<{ turns: number; settled: boolean }> {
  const turns = [...runningTurns];
  if (turns.length === 0) return { turns: 0, settled: true };
  for (const turn of turns) {
    try {
      turn.abort(new HostExitAbortError());
    } catch (err) {
      log.warn("running turn abort failed: %s", err);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const settled = await Promise.race([
    Promise.all(turns.map((turn) => turn.settled)).then(() => true as const),
    deadline,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { turns: turns.length, settled };
}

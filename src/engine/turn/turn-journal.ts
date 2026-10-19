/**
 * The running turn's side of crash durability (storage side:
 * `memory/session-turn-journal.ts`).
 *
 * Every row the turn appends to history — each assistant round, each
 * tool_result — is handed to `MemoryManager.appendSessionProgress` as soon as
 * it exists, on one serial chain so writes land in history order. The text of
 * the round still streaming is snapshotted into the in-flight sidecar at most
 * once per `partialIntervalMs`, so a process that dies loses at most that much
 * of the answer. The turn's own end-of-turn `saveSession` stays the commit
 * point; this only shrinks what a death before it can cost.
 *
 * Also here: the process-wide set of running turns, which the app's quit path
 * aborts as `host-exit` and waits on (bounded) so a graceful quit records the
 * turn as interrupted rather than relying on the journal alone.
 */
import { createDlpSafeUuid } from "../../shared/dlp-safe-id.js";
import { createLogger } from "../../lib/logger.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { MAX_TURN_PARTIAL_CHARS } from "../../memory/session-turn-journal.js";
import type { ConversationHistory, StoredMessage } from "../conversation-history.js";

const log = createLogger("turn-journal");

/** Default cap on how often the streaming partial is snapshotted. */
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

  /**
   * Start journaling. Called once the turn's accepted user message is on disk
   * (the `turn-accepted` save), so the transcript and this process's record of
   * it agree and the first round can be appended rather than rewritten.
   */
  async begin(): Promise<void> {
    if (this.open) return;
    try {
      await this.store.beginTurnJournal(this.sessionId, this.startedAt);
    } catch (err) {
      // Durability is best effort on top of the turn's own saves; a journal
      // that cannot open must not take the turn down with it.
      log.warn("turn journal could not open: %s", err);
      return;
    }
    this.open = true;
    this.history.setAppendObserver((message) => this.onAppend(message));
  }

  /**
   * The id the current round's committed assistant row will carry. The
   * partial snapshot is filed under it, and recovery drops a partial whose id
   * is already on disk, so a round that committed is never shown twice.
   */
  currentRoundRowId(): string {
    this.roundRowId ??= createDlpSafeUuid();
    return this.roundRowId;
  }

  /**
   * An assistant row ended the streaming round (committed, interrupted, or a
   * host notice): the next round gets a fresh id and no pending snapshot.
   */
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
    // A snapshot of the round that just ended must go only AFTER the row that
    // replaces it is on disk — clearing it first would open a window where a
    // death loses the round entirely. A row under the snapshot's own id needs
    // no clear (recovery drops a snapshot whose id is on disk); a notice row
    // under a different id does.
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

  /**
   * The streaming round's text changed. `render` is read only when a snapshot
   * is actually written, so a burst of deltas costs one render per interval.
   */
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
    // On the same chain as the row appends, so a snapshot and the row that
    // supersedes it reach the disk in the order they happened.
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
    // Read under the transcript lock, so queued appends never overwrite a newer save.
    if (!this.open) return false;
    try {
      await this.store.appendSessionProgress(this.sessionId, () => this.history.getMessages());
      return true;
    } catch (err) {
      log.warn("turn progress append failed: %s", err);
      return false;
    }
  }

  /** Writes queued so far have reached the file. */
  async settled(): Promise<void> {
    await this.chain;
  }

  /**
   * Deregister at turn end. Remove the recovery sidecar only after a successful
   * transcript sync, since the turn's best-effort final save may have failed.
   */
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

// ─── Running turns, for the quit path ───────────────────────────────────────

/** Abort reason for turns stopped because the app is exiting. */
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

/**
 * Register a turn that has an abort controller. `settle` must be called from
 * the turn's `finally`, after its last persistence step.
 */
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

/**
 * Stop every running turn as `host-exit` and wait — at most `timeoutMs` — for
 * each to finish recording itself. Covers every loop in the process (main
 * tiles, side chat, sub-agent children, headless lanes) because they all run
 * through `runTurn`. A turn that misses the deadline still has its journal on
 * disk; the wait only buys the cleaner "interrupted" record.
 */
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

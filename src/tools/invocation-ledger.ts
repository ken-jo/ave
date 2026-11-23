import type { AuditLogger } from "../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../audit/audit-schema.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { HostExitAbortError, isHostExitAbort } from "../shared/host-exit-abort.js";

const log = createLogger("invocation-ledger");
const shutdown = new AbortController();
const pending = new Set<Promise<unknown>>();
// Enqueued terminal rows still committing; the close joins them without counting them as invocations.
const commits = new Set<Promise<unknown>>();
const detached = new Map<object, () => Promise<unknown>>();
const sealClaims = new Set<() => void>();
// Every attempt whose terminal row is still unclaimed and that registered a host writer.
const openTerminals = new Set<TerminalLedger>();
// Attempts whose terminal row is enqueued and not yet committed.
const enqueuedTerminals = new Set<TerminalLedger>();
// Attempts a rationale card holds, by tool-use id, until its sealed start adopts them.
const suspendedTerminals = new Map<string, TerminalLedger>();
let closing: Promise<number> | undefined;
let auditClosed = false;
let shutdownStarted = false;
let shutdownFailure: { error: unknown } | undefined;

/** Who may claim an attempt's terminal row: its current owner, or the host when it ends the attempt itself. */
type TerminalOwner = "invocation" | "rationale";
/**
 * open → enqueued (one claim, at the synchronous enqueue of the row) → committed | failed. The owner moves
 * invocation → rationale while a rationale card holds the attempt, and back to invocation at its sealed start.
 */
type TerminalState = "open" | "enqueued" | "committed" | "failed";
/** Why the host ends an attempt itself; `selected` is a human outcome already accepted for it. */
type HostTerminalCause = "host-shutdown" | "user-abort" | "error";
/** The lifecycle event only the ledger emits, once, after an invocation's deny row is enqueued. */
export type TerminalLifecycleEvent = "PermissionDenied";
/**
 * Writes the attempt's terminal row; only the ledger hands one out. The call claims the attempt and enqueues the row
 * synchronously, so a writer that throws first leaves the attempt open. `logger` is absent when the chain is neither
 * set up nor required; `denied` fires the denial lifecycle. A refused claim writes and fires nothing.
 */
export type TerminalRowWriter = (row: {
  logger?: Pick<AuditLogger, "appendPermissionAuditEntry">;
  entry: PermissionAuditEntryInput;
  denied?: (event: TerminalLifecycleEvent) => Promise<unknown>;
}) => Promise<void>;
type HostTerminalWrite = (cause: HostTerminalCause, detail: string, selected: unknown, row: TerminalRowWriter) => Promise<unknown>;

/** A refused terminal claim: a second claim of the same attempt, or a claim after the sink closed. */
class TerminalClaimError extends Error {
  constructor(message: string, readonly kind: "already-claimed" | "closed-sink") {
    super(message);
    this.name = "TerminalClaimError";
  }
}

/** One terminal row per attempt. History, hooks and plain telemetry run after the claim and never undo it. */
export interface InvocationTerminal {
  readonly attempt: number;
  readonly owner: TerminalOwner;
  readonly state: TerminalState;
  /** The host's writer: it ends the attempt when a forced quit, a held card's abort or an invocation failure finds it unclaimed. */
  hostTerminal(write: HostTerminalWrite): void;
  /** Records a human outcome accepted before the next yield, so a host write in that window keeps it. */
  select(outcome: unknown): void;
  /** True exactly once. A second claim, or one after the sink closed, is refused, recorded as an audit failure and false. */
  claim(by: TerminalOwner | "host"): boolean;
  /** Runs `enqueue` with the owner's row writer, to be called before its first await. A refused claim runs nothing and
   * resolves undefined: the refusal is already logged and recorded, and the late caller still returns its result. An
   * `enqueue` that fails before its row is an integrity failure: the host writes the row and the attempt ends failed. */
  commit<T>(enqueue: (row: TerminalRowWriter) => Promise<T>): Promise<T | undefined>;
  /** The sandbox retry: a new attempt of the same admission, after this one's row. */
  nextAttempt(): InvocationTerminal;
}

class TerminalLedger implements InvocationTerminal {
  #state: TerminalState = "open";
  #owner: TerminalOwner = "invocation";
  #write: HostTerminalWrite | undefined;
  #selected: unknown;
  #releaseAbort: (() => void) | undefined;
  #key: string | undefined;
  #integrityFailure = false;

  constructor(readonly tool: string, readonly attempt: number, readonly signal: AbortSignal) {}

  get owner(): TerminalOwner { return this.#owner; }
  get state(): TerminalState { return this.#state; }
  get key(): string | undefined { return this.#key; }

  hostTerminal(write: HostTerminalWrite): void {
    this.#write = write;
    if (this.#state === "open") openTerminals.add(this);
  }

  select(outcome: unknown): void {
    if (this.#state === "open") this.#selected = outcome;
  }

  claim(by: TerminalOwner | "host"): boolean {
    if (this.#refusal(by)) return false;
    this.#take();
    return true;
  }

  #refusal(by: TerminalOwner | "host"): TerminalClaimError | undefined {
    let refused: TerminalClaimError | undefined;
    if (auditClosed) refused = new TerminalClaimError(`terminal row of ${this.tool} refused: the audit sink is closed`, "closed-sink");
    else if (this.#state !== "open") refused = new TerminalClaimError(`terminal row of ${this.tool} claimed twice`, "already-claimed");
    else if (by !== "host" && by !== this.#owner) refused = new TerminalClaimError(`terminal row of ${this.tool} claimed by ${by}, owned by ${this.#owner}`, "already-claimed");
    if (refused) {
      log.error("%s", refused.message);
      // Only an attempt left without its row is an audit loss; a late claim after the host wrote it is the fence working.
      if (this.#state === "open") recordToolInvocationAuditFailure(refused);
      return refused;
    }
    return undefined;
  }

  #take(): void {
    this.#state = "enqueued";
    openTerminals.delete(this);
    this.#releaseAbort?.();
    if (suspendedTerminals.get(suspensionKey(this)) === this) suspendedTerminals.delete(suspensionKey(this));
  }

  commit<T>(enqueue: (row: TerminalRowWriter) => Promise<T>): Promise<T | undefined> {
    return this.#commitAs(this.#owner, enqueue);
  }

  #commitAs<T>(by: TerminalOwner | "host", enqueue: (row: TerminalRowWriter) => Promise<T>): Promise<T | undefined> {
    if (this.#refusal(by)) return Promise.resolve(undefined);
    const row: TerminalRowWriter = ({ logger, entry, denied }) => {
      if (this.#refusal(by)) return Promise.resolve();
      this.#take();
      const append = logger ? appendTerminalRow(logger, entry) : Promise.resolve();
      this.#track(append);
      return (async () => {
        if (entry.decision === "deny" && denied) await denied("PermissionDenied");
        await append;
      })();
    };
    let written: Promise<T>;
    try {
      written = enqueue(row);
    } catch (error) {
      written = Promise.reject(error);
    }
    void written.then(undefined, (error: unknown) => {
      if (this.#state !== "open") return;
      if (by === "host") {
        // The host's own writer failed first; nothing is left to write the row.
        log.error("host terminal row of %s failed before it was enqueued: %s", this.tool, errorMessage(error));
        recordToolInvocationAuditFailure(error);
        return;
      }
      log.error("terminal row of %s failed before it was enqueued: %s", this.tool, errorMessage(error));
      recordToolInvocationAuditFailure(error);
      this.#integrityFailure = true;
      // The host's own refusal: a selected answer whose record just failed would fail the host's row the same way.
      this.#selected = undefined;
      void this.endByHost("error", `the terminal row failed its integrity check: ${errorMessage(error)}`)?.catch(() => {});
    });
    return written;
  }

  #track(append: Promise<unknown>): void {
    enqueuedTerminals.add(this);
    const settled = append.finally(() => { enqueuedTerminals.delete(this); }).then(
      () => { this.#state = this.#integrityFailure ? "failed" : "committed"; },
      (error: unknown) => {
        this.#state = "failed";
        log.error("terminal row of %s failed: %s", this.tool, errorMessage(error));
        recordToolInvocationAuditFailure(error);
      },
    );
    commits.add(settled);
    void settled.then(() => { commits.delete(settled); });
  }

  /** The host ends the attempt; false when it already has its row or no host writer. */
  endByHost(cause: HostTerminalCause, detail: string): Promise<unknown> | undefined {
    const write = this.#write;
    if (this.#state !== "open" || write === undefined) return undefined;
    const selected = this.#selected;
    return this.#commitAs("host", (row) => write(cause, detail, selected, row));
  }

  /** The invocation returned a rationale card: the card owns the row until its sealed start, and a stop or quit ends it. */
  suspend(toolUseId: string): void {
    if (this.#state !== "open") return;
    this.#owner = "rationale";
    this.#key = toolUseId;
    suspendedTerminals.set(toolUseId, this);
    const onAbort = (): void => {
      void this.endByHost(isHostExitAbort(this.signal.reason) ? "host-shutdown" : "user-abort", "rationale card stopped")
        ?.catch(() => {});
    };
    this.signal.addEventListener("abort", onAbort, { once: true });
    this.#releaseAbort = () => {
      this.signal.removeEventListener("abort", onAbort);
      this.#releaseAbort = undefined;
    };
    if (this.signal.aborted) onAbort();
  }

  /** The sealed start takes the attempt back from the rationale card. */
  adopt(): void {
    this.#releaseAbort?.();
    suspendedTerminals.delete(suspensionKey(this));
    this.#owner = "invocation";
  }

  nextAttempt(): InvocationTerminal {
    if (this.#state === "open") throw new TerminalClaimError(`attempt ${this.attempt} of ${this.tool} has no terminal row yet`, "already-claimed");
    return new TerminalLedger(this.tool, this.attempt + 1, this.signal);
  }
}

function suspensionKey(ledger: TerminalLedger): string {
  return ledger.key ?? "";
}

export type ToolInvocationAdmission = {
  signal: AbortSignal;
  terminal: InvocationTerminal;
  /** The invocation returned a rationale card for this tool use; the card holds its row. */
  suspend(toolUseId: string): void;
  /** Ends the admission. An unclaimed, unsuspended attempt gets the host's row, with `failure` as its cause when one is given. */
  settle(failure?: unknown): void;
};

export function admitToolInvocation(tool: string, parent?: AbortSignal, resumeOf?: string): ToolInvocationAdmission {
  const signal = AbortSignal.any(parent ? [shutdown.signal, parent] : [shutdown.signal]);
  const held = resumeOf === undefined ? undefined : suspendedTerminals.get(resumeOf);
  let ledger = held ?? new TerminalLedger(tool, 1, signal);
  if (held) held.adopt();
  if (auditClosed) {
    // Its denial can no longer be written, so refuse it and fail the shutdown.
    log.error("tool invocation admitted after audit close: %s", tool);
    recordToolInvocationAuditFailure(new Error(`tool invocation admitted after audit close: ${tool}`));
    return { signal, terminal: ledger, suspend() {}, settle() {} };
  }
  let resolve!: () => void;
  const completion = new Promise<void>((done) => { resolve = done; });
  pending.add(completion);
  let suspended = false;
  const terminal: InvocationTerminal = {
    get attempt() { return ledger.attempt; },
    get owner() { return ledger.owner; },
    get state() { return ledger.state; },
    hostTerminal: (write) => { ledger.hostTerminal(write); },
    select: (outcome) => { ledger.select(outcome); },
    claim: (by) => ledger.claim(by),
    commit: (enqueue) => ledger.commit(enqueue),
    nextAttempt: () => {
      ledger = ledger.nextAttempt() as TerminalLedger;
      return terminal;
    },
  };
  return {
    signal,
    terminal,
    suspend(toolUseId) {
      suspended = true;
      ledger.suspend(toolUseId);
    },
    settle(failure) {
      if (!suspended) {
        const ended = ledger.endByHost("error", failure === undefined
          ? "the invocation ended without a terminal record"
          : `the invocation failed: ${errorMessage(failure)}`);
        void ended?.catch(() => {});
      }
      pending.delete(completion);
      resolve();
    },
  };
}

/** Forced shutdown: before the sink closes, the host enqueues the terminal row of every admitted attempt that has none. */
function commitParkedHostTerminals(): void {
  for (const ledger of [...openTerminals]) void ledger.endByHost("host-shutdown", "host-shutdown")?.catch(() => {});
}

/** Bounded exit commit: the host's rows are enqueued, the sink closes after draining every enqueued append, and the deadline caps the wait. */
export async function drainToolInvocationAuditForExit(
  close: () => Promise<void>,
  deadlineMs: number,
): Promise<"committed" | "timed-out" | "failed"> {
  commitParkedHostTerminals();
  auditClosed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), deadlineMs); });
  try {
    const committed = (async () => {
      await Promise.allSettled([...commits]);
      await close();
      return shutdownFailure ? "failed" as const : "committed" as const;
    })().catch(() => "failed" as const);
    return await Promise.race([committed, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The tools whose terminal row is still unclaimed or still committing, for the record of a missed exit deadline. */
export function unsettledTerminalTools(): { open: string[]; enqueued: string[] } {
  return { open: [...openTerminals].map((ledger) => ledger.tool), enqueued: [...enqueuedTerminals].map((ledger) => ledger.tool) };
}

/** Admission unless the audit is closed; a closed refusal has no row left to write, so it fails nothing. */
/** Commits through the admission's terminal, or a standalone one for a call run without an admission. */
export function commitTerminalRow<T>(
  terminal: InvocationTerminal | undefined,
  tool: string,
  enqueue: (row: TerminalRowWriter) => Promise<T>,
): Promise<T | undefined> {
  return (terminal ?? new TerminalLedger(tool, 1, shutdown.signal)).commit(enqueue);
}

export function admitToolInvocationWhileAuditOpen(tool: string, parent?: AbortSignal, resumeOf?: string): ToolInvocationAdmission | undefined {
  return auditClosed ? undefined : admitToolInvocation(tool, parent, resumeOf);
}

/** Runs `claim` at the seal (now, if already sealed) so queued work is admitted while the audit is open. */
export function claimAtToolInvocationSeal(claim: () => void): () => void {
  if (shutdown.signal.aborted) {
    claim();
    return () => {};
  }
  sealClaims.add(claim);
  return () => { sealClaims.delete(claim); };
}

/** True once the seal aborted admission; a caller refusing work then has no denial to record. */
export function toolInvocationsSealed(): boolean {
  return shutdown.signal.aborted;
}

export function trackToolInvocationSettlement(settlement: Promise<unknown>): void {
  pending.add(settlement);
  void settlement.then(
    () => { pending.delete(settlement); },
    (error: unknown) => {
      recordToolInvocationAuditFailure(error);
      pending.delete(settlement);
    },
  );
}

/** An invocation's allow or deny outcome; a directory grant and a plugin operation's row are records beside it. */
function isTerminalRow(entry: PermissionAuditEntryInput): boolean {
  return (entry.decision === "allow" || entry.decision === "deny") && "toolUseId" in entry && entry.toolUseId !== undefined
    && !("directory" in entry && entry.directory !== undefined) && !("pluginOperation" in entry && entry.pluginOperation !== undefined);
}

/** Records beside an invocation's outcome (asks, grants, plugin operations, mode changes); a terminal row is refused. */
export async function appendToolInvocationAudit(
  logger: Pick<AuditLogger, "appendPermissionAuditEntry">,
  entry: PermissionAuditEntryInput,
): ReturnType<AuditLogger["appendPermissionAuditEntry"]> {
  if (isTerminalRow(entry)) {
    const error = new Error(`terminal row of ${"tool" in entry ? entry.tool : entry.decision} must be written through its invocation's ledger`);
    recordToolInvocationAuditFailure(error);
    throw error;
  }
  return appendTerminalRow(logger, entry);
}

async function appendTerminalRow(
  logger: Pick<AuditLogger, "appendPermissionAuditEntry">,
  entry: PermissionAuditEntryInput,
): ReturnType<AuditLogger["appendPermissionAuditEntry"]> {
  const append = logger.appendPermissionAuditEntry(entry);
  try {
    return await append;
  } catch (error) {
    recordToolInvocationAuditFailure(error);
    throw error;
  }
}
/**
 * Work the ceiling detached is not joined: a settlement before the seal commits its row, and the seal writes its
 * host-shutdown row instead and refuses the late commit.
 */
export function trackDetachedToolInvocation(
  settlement: Promise<unknown>,
  commitSettled: () => Promise<unknown>,
  commitHostShutdown: () => Promise<unknown>,
): void {
  const entry = {};
  detached.set(entry, commitHostShutdown);
  void settlement.then(
    () => { if (detached.delete(entry)) commitDetached(commitSettled); },
    (error: unknown) => {
      if (detached.delete(entry)) recordToolInvocationAuditFailure(error);
    },
  );
  // After the seal the interruption's indeterminate row is already written, so this entry ends with a second
  // indeterminate row, the host-shutdown deny, as its terminal record.
  if (shutdown.signal.aborted) closeDetachedToolInvocations();
}

function commitDetached(commit: () => Promise<unknown>): void {
  let written: Promise<unknown>;
  try {
    written = commit();
  } catch (error) {
    written = Promise.reject(error);
  }
  trackToolInvocationSettlement(written.catch((error: unknown) => {
    log.error("detached tool invocation audit failed: %s", errorMessage(error));
    throw error;
  }));
}

function closeDetachedToolInvocations(): void {
  const commits = [...detached.values()];
  detached.clear();
  for (const commit of commits) commitDetached(commit);
}

export function recordToolInvocationAuditFailure(error: unknown): void {
  if (shutdownStarted) shutdownFailure ??= { error };
}

export function toolInvocationShutdownStarted(): boolean {
  return shutdownStarted;
}

export function beginToolInvocationAuditShutdown(): void {
  shutdownStarted = true;
}

/**
 * Claims run synchronously, so an abort refusal queues its row before this returns. A claimed tool that awaits first
 * (a deny firing a lifecycle hook) can meet an audit closed in the same tick. A permission row it then appends fails
 * and is recorded; only closeToolInvocationAudit turns that into a failed shutdown.
 */
export function sealToolInvocations(): void {
  beginToolInvocationAuditShutdown();
  shutdown.abort(new HostExitAbortError());
  const claims = [...sealClaims];
  sealClaims.clear();
  for (const claim of claims) {
    try { claim(); } catch (error) { recordToolInvocationAuditFailure(error); }
  }
  closeDetachedToolInvocations();
}

/** Join admitted work, then close audit admission in the same step that observes the set empty. */
export function closeToolInvocationAudit(close: () => Promise<void>): Promise<number> {
  closing ??= (async () => {
    let count = 0;
    while (pending.size > 0 || commits.size > 0) {
      const batch = [...pending];
      count += batch.length;
      await Promise.allSettled([...batch, ...commits]);
    }
    auditClosed = true;
    await close();
    // Failures recorded while close was pending still fail this shutdown.
    if (shutdownFailure) throw new Error("shutdown invocation audit failed", { cause: shutdownFailure.error });
    return count;
  })();
  return closing;
}

export function pendingToolInvocationCount(): number {
  return pending.size + detached.size;
}

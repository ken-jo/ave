import { logPermissionEvent, permissionLogId } from "../lib/permission-log.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { type AuditDenyKind, type PermissionAuditEntryInput } from "../audit/audit-schema.js";
import { createLogger } from "../lib/logger.js";
import { answeredApprovalProvenance, isAnsweredApprovalDenial, type ApprovalDecision } from "../permissions/approval-gate.js";
import { errorMessage } from "../shared/error-message.js";
import { HostExitAbortError, isHostExitAbort } from "../shared/host-exit-abort.js";
import { abortSupersedesApprovalDecision, approvalFailureOutcome, isSettledRefusal, refusal } from "./pipeline/approval-outcome.js";
import type { PermissionCheckResult } from "../permissions/permission-manager.js";

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
let admissionClosed = false;
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
/** The lifecycle event only the ledger emits, once, after an invocation's permission-denial row is enqueued. */
export type TerminalLifecycleEvent = "PermissionDenied";
/**
 * What a deny row ends: a permission denial (a rule, a person, a hook, a host policy, an integrity failure), or a
 * cancellation (a user abort, a host shutdown, a deadline drain) that no permission decided. The writer of each deny row
 * names it; the ledger reads nothing else to decide whether the row is a denial.
 */
export type TerminalDenyKind = AuditDenyKind;
type DenyEntry = Extract<PermissionAuditEntryInput, { decision: "deny" }>;

/** A permission denial the ledger committed; only the ledger mints one, so only its lifecycle can fire PermissionDenied. */
class LedgerDenial {
  readonly event: TerminalLifecycleEvent = "PermissionDenied";
  // A private field makes the type nominal: no object built outside the ledger is a TerminalDenial.
  readonly #reason: string;
  constructor(reason: string) { this.#reason = reason; }
  get reason(): string { return this.#reason; }
}
export type TerminalDenial = LedgerDenial;

/**
 * How an attempt reports its denial. The ledger fires it once for every deny row of kind `denied` it commits, from any
 * writer; a cancellation fires nothing, and a governed tool's lease and proof cannot include effect-capable hooks, so a
 * governed attempt's rows fire nothing.
 */
export type TerminalDenialLifecycle = {
  governed(): boolean;
  fire(denial: TerminalDenial): Promise<unknown>;
};
type TerminalRow = {
  reason?: string;
  humanAnswered?: boolean;
  fields?: Readonly<Record<string, string | number | boolean | undefined>>;
} & ({ entry: DenyEntry; kind: TerminalDenyKind } | { entry: Exclude<PermissionAuditEntryInput, { decision: "deny" }>; kind?: never });
/**
 * Writes the attempt's terminal row; only the ledger hands one out. The call claims the attempt and enqueues the row
 * synchronously, so a writer that throws first leaves the attempt open. A refused claim writes and fires nothing.
 */
export type TerminalRowWriter = (row: TerminalRow) => Promise<void>;
/** A ledger writer together with the kind its deny row records, for a writer that builds the entry itself. */
export type KindedTerminalRowWriter = { row: TerminalRowWriter; kind: TerminalDenyKind };
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
  readonly denyKind: TerminalDenyKind | undefined;
  readonly settledRationaleRefusal: PermissionCheckResult | undefined;
  /** The host's writer, which ends the attempt when a forced quit, a held card's abort or an invocation failure finds it
   * unclaimed, and the attempt's denial lifecycle. */
  hostTerminal(write: HostTerminalWrite, lifecycle: TerminalDenialLifecycle): void;
  /** Adds a cancellation source when an approval wait supplies its signal. */
  bindAbortSignal(signal?: AbortSignal): AbortSignal;
  /** Records a human outcome accepted before the next yield, so a host write in that window keeps it. */
  select(outcome: unknown): void;
  selectRationaleDenial(decision: ApprovalDecision, reason: string): void;
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
  #lifecycle: TerminalDenialLifecycle | undefined;
  #selected: unknown;
  #settledRationaleDecision: ApprovalDecision | undefined;
  #settledRationaleRefusal: PermissionCheckResult | undefined;
  #releaseAbort: (() => void) | undefined;
  #key: string | undefined;
  #integrityFailure = false;
  #signal: AbortSignal;
  #denyKind: TerminalDenyKind | undefined;

  constructor(readonly tool: string, readonly attempt: number, signal: AbortSignal, lifecycle?: TerminalDenialLifecycle) {
    this.#signal = signal;
    this.#lifecycle = lifecycle;
  }

  get owner(): TerminalOwner { return this.#owner; }
  get state(): TerminalState { return this.#state; }
  get denyKind(): TerminalDenyKind | undefined { return this.#denyKind; }
  get settledRationaleRefusal(): PermissionCheckResult | undefined { return this.#settledRationaleRefusal; }
  get key(): string | undefined { return this.#key; }

  bindAbortSignal(signal?: AbortSignal): AbortSignal {
    if (signal !== undefined && signal !== this.#signal) this.#signal = AbortSignal.any([this.#signal, signal]);
    return this.#signal;
  }

  hostTerminal(write: HostTerminalWrite, lifecycle: TerminalDenialLifecycle): void {
    this.#write = write;
    this.#lifecycle = lifecycle;
    if (this.#state === "open") openTerminals.add(this);
  }

  select(outcome: unknown): void {
    if (this.#state === "open") this.#selected = outcome;
  }

  selectRationaleDenial(decision: ApprovalDecision, reason: string): void {
    if (this.#state !== "open" || this.#owner !== "rationale" || this.#settledRationaleDecision !== undefined
      || !isSettledRefusal(decision) || abortSupersedesApprovalDecision(this.#signal, decision)) return;
    const permission = isAnsweredApprovalDenial(decision) ? refusal(reason, answeredApprovalProvenance(decision))
      : approvalFailureOutcome(decision, this.tool)?.permission;
    if (permission === undefined) return;
    this.#settledRationaleDecision = decision;
    this.#settledRationaleRefusal = permission;
    this.select(permission);
  }

  #refusal(by: TerminalOwner | "host"): TerminalClaimError | undefined {
    let refused: TerminalClaimError | undefined;
    if (admissionClosed) refused = new TerminalClaimError(`terminal row of ${this.tool} refused: shutdown closed admission`, "closed-sink");
    else if (this.#state !== "open") refused = new TerminalClaimError(`terminal row of ${this.tool} claimed twice`, "already-claimed");
    else if (by !== "host" && by !== this.#owner) refused = new TerminalClaimError(`terminal row of ${this.tool} claimed by ${by}, owned by ${this.#owner}`, "already-claimed");
    if (refused) {
      log.error("%s", refused.message);
      // Only an attempt left without its row is an audit loss; a late claim after the host wrote it is the fence working.
      if (this.#state === "open") recordToolInvocationFailure(refused);
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
    const row: TerminalRowWriter = (terminal) => {
      // The type requires a deny's kind; a row that reaches here without a valid one is refused before the claim, so the
      // attempt stays open and the host writes its one integrity denial.
      if (terminal.entry.decision === "deny" && terminal.kind !== "denied" && terminal.kind !== "cancelled") {
        const error = new Error(`deny row of ${this.tool} names no terminal kind`);
        recordToolInvocationFailure(error);
        throw error;
      }
      if (this.#refusal(by)) return Promise.resolve();
      const { reason } = terminal;
      const cancellation = terminal.kind === "denied" ? this.#abortCancellation(terminal.humanAnswered === true || terminal.entry.denyReasons.some(({ source }) => source === "approval-gate")) : undefined;
      const { entry } = terminal;
      const denyKind = cancellation === undefined ? terminal.kind : "cancelled";
      this.#take();
      this.#denyKind = denyKind;
      emitToolDecision(entry, { ...terminal.fields, terminalKind: denyKind, attempt: this.attempt });
      const lifecycle = this.#lifecycle;
      const completion = (async () => {
        if (entry.decision === "deny" && denyKind === "denied" && lifecycle !== undefined && !lifecycle.governed()) {
          await lifecycle.fire(new LedgerDenial(reason ?? entry.denyReasons[0]?.reason ?? ""));
        }
      })();
      this.#track(completion);
      return completion;
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
        recordToolInvocationFailure(error);
        return;
      }
      log.error("terminal row of %s failed before it was enqueued: %s", this.tool, errorMessage(error));
      recordToolInvocationFailure(error);
      this.#integrityFailure = true;
      // The host's own refusal: a selected answer whose record just failed would fail the host's row the same way.
      this.#selected = undefined;
      this.#settledRationaleDecision = undefined;
      this.#settledRationaleRefusal = undefined;
      void this.endByHost("error", `the terminal row failed its integrity check: ${errorMessage(error)}`)?.catch(() => {});
    });
    return written;
  }

  /**
   * A denial committed after the invocation's abort is that abort's cancellation, whichever writer or site committed it
   * (a hook the Stop cancelled, a step the abort made throw); only a settled approval refusal and the host's own integrity
   * refusal stay denials. Returns the cancellation's reason, or undefined when the row stays a denial.
   */
  #abortCancellation(settledApproval: boolean): string | undefined {
    if (!this.#signal.aborted || settledApproval || this.#integrityFailure) return undefined;
    return isHostExitAbort(this.#signal.reason) ? "host-shutdown" : "user aborted turn";
  }

  #track(append: Promise<unknown>): void {
    enqueuedTerminals.add(this);
    const settled = append.finally(() => { enqueuedTerminals.delete(this); }).then(
      () => { this.#state = this.#integrityFailure ? "failed" : "committed"; },
      (error: unknown) => {
        this.#state = "failed";
        log.error("terminal row of %s failed: %s", this.tool, errorMessage(error));
        recordToolInvocationFailure(error);
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
    const signal = this.#signal;
    const onAbort = (): void => {
      if (!abortSupersedesApprovalDecision(signal, this.#settledRationaleDecision)) return;
      void this.endByHost(isHostExitAbort(signal.reason) ? "host-shutdown" : "user-abort", "rationale card stopped")
        ?.catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#releaseAbort = () => {
      signal.removeEventListener("abort", onAbort);
      this.#releaseAbort = undefined;
    };
    if (signal.aborted) onAbort();
  }

  /** The sealed start takes the attempt back from the rationale card. */
  adopt(): void {
    this.#releaseAbort?.();
    suspendedTerminals.delete(suspensionKey(this));
    this.#owner = "invocation";
  }

  nextAttempt(): InvocationTerminal {
    if (this.#state === "open") throw new TerminalClaimError(`attempt ${this.attempt} of ${this.tool} has no terminal row yet`, "already-claimed");
    return new TerminalLedger(this.tool, this.attempt + 1, this.#signal, this.#lifecycle);
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
  const held = resumeOf === undefined ? undefined : suspendedTerminals.get(resumeOf);
  let ledger = held ?? new TerminalLedger(tool, 1, shutdown.signal);
  if (held) held.adopt();
  const signal = ledger.bindAbortSignal(parent);
  if (admissionClosed) {
    // Its denial can no longer be written, so refuse it and fail the shutdown.
    log.error("tool invocation admitted after shutdown closed admission: %s", tool);
    recordToolInvocationFailure(new Error(`tool invocation admitted after shutdown closed admission: ${tool}`));
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
    get denyKind() { return ledger.denyKind; },
    get settledRationaleRefusal() { return ledger.settledRationaleRefusal; },
    hostTerminal: (write, lifecycle) => { ledger.hostTerminal(write, lifecycle); },
    bindAbortSignal: (abortSignal) => ledger.bindAbortSignal(abortSignal),
    select: (outcome) => { ledger.select(outcome); },
    selectRationaleDenial: (decision, reason) => { ledger.selectRationaleDenial(decision, reason); },
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
export async function drainToolInvocationsForExit(
  deadlineMs: number,
): Promise<"committed" | "timed-out" | "failed"> {
  commitParkedHostTerminals();
  admissionClosed = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), deadlineMs); });
  try {
    const committed = (async () => {
      await Promise.allSettled([...commits]);

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

/** Commits through the admission's terminal; no call writes a terminal row outside an admission. */
export function commitTerminalRow<T>(
  terminal: InvocationTerminal,
  enqueue: (row: TerminalRowWriter) => Promise<T>,
): Promise<T | undefined> {
  return terminal.commit(enqueue);
}

/** Admission unless the audit is closed; a closed refusal has no row left to write, so it fails nothing. */
export function admitToolInvocationWhileOpen(tool: string, parent?: AbortSignal, resumeOf?: string): ToolInvocationAdmission | undefined {
  return admissionClosed ? undefined : admitToolInvocation(tool, parent, resumeOf);
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
      recordToolInvocationFailure(error);
      pending.delete(settlement);
    },
  );
}

/** An invocation's allow or deny outcome; a plugin operation's row is a record beside it, and a directory grant has its own writer. */
function isTerminalRow(entry: PermissionAuditEntryInput): boolean {
  return (entry.decision === "allow" || entry.decision === "deny") && "toolUseId" in entry && entry.toolUseId !== undefined
    && !("pluginOperation" in entry && entry.pluginOperation !== undefined);
}

function refuseSideRecord(message: string): never {
  const error = new Error(message);
  recordToolInvocationFailure(error);
  throw error;
}

function isPluginOperationRecord(entry: PermissionAuditEntryInput): boolean {
  return "pluginOperation" in entry && entry.pluginOperation !== undefined;
}

/**
 * Records beside an invocation's outcome (asks, plugin operations, mode changes); a terminal row is refused, and so is
 * any deny that is not a plugin operation's record, with or without a tool-use id.
 */
export async function appendToolInvocationAudit(
  _logger: Pick<AuditLogger, "appendPermissionAuditEntry">,
  entry: PermissionAuditEntryInput,
): Promise<void> {
  if (isTerminalRow(entry)) refuseSideRecord(`terminal row of ${"tool" in entry ? entry.tool : entry.decision} must be written through its invocation's ledger`);
  if (entry.decision === "deny" && !isPluginOperationRecord(entry)) refuseSideRecord(`deny row of ${entry.tool} is no plugin operation record`);
  emitToolDecision(entry);
}

/** The quit's refusal of a permission mode change: a deny that belongs to no invocation, so it carries no tool-use id. */
export type ModeChangeRefusal = Extract<PermissionAuditEntryInput, { decision: "deny" }> & { category: "meta"; toolUseId?: never; pluginOperation?: never };

export async function appendModeChangeRefusal(
  _logger: Pick<AuditLogger, "appendPermissionAuditEntry">,
  entry: ModeChangeRefusal,
): Promise<void> {
  if (entry.decision !== "deny" || "toolUseId" in entry || isPluginOperationRecord(entry)) {
    refuseSideRecord(`mode change refusal of ${entry.tool} must belong to no invocation`);
  }
  emitToolDecision(entry);
}

/** A directory grant: the allow beside an invocation's outcome naming the folder and exactly one lifetime or policy rule. */
export type DirectoryGrantRecord = Extract<PermissionAuditEntryInput, { decision: "allow" }> & { directory: string; directoryAllowed: true };

export async function appendDirectoryGrantRecord(
  _logger: Pick<AuditLogger, "appendPermissionAuditEntry">,
  entry: DirectoryGrantRecord,
): Promise<void> {
  if (entry.decision !== "allow" || entry.directoryAllowed !== true || typeof entry.directory !== "string"
    || (entry.grantLifetime === undefined) === (entry.policyRule === undefined)) {
    refuseSideRecord(`directory grant of ${entry.tool} must name its folder and exactly one lifetime or policy rule`);
  }
  emitToolDecision(entry);
}

export function emitToolDecision(
  entry: PermissionAuditEntryInput,
  fields: Readonly<Record<string, string | number | boolean | undefined>> = {},
): void {
  if (!("tool" in entry)) return;
  logPermissionEvent(entry.pluginOperation ? "plugin_operation_decision" : "permission_decision", {
    ...fields,
    tool: permissionLogId(entry.tool),
    source: entry.source,
    category: entry.category,
    decision: entry.decision,
    toolUseId: permissionLogId(entry.toolUseId),
    operation: permissionLogId(entry.pluginOperation?.operation) ?? fields.operation,
    pluginId: permissionLogId(entry.pluginOperation?.pluginId),
    operationOutcome: entry.pluginOperation?.outcome,
    trustOrigin: entry.trustOrigin,
    sandboxRoute: entry.executionRoute?.route ?? entry.executionPlan?.substrate,
    reviewerRisk: entry.decision === "allow" ? entry.reviewer?.level : undefined,
    answerTrustOrigin: entry.decision === "deny" ? entry.answerTrustOrigin : undefined,
  });
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
      if (detached.delete(entry)) recordToolInvocationFailure(error);
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

export function recordToolInvocationFailure(error: unknown): void {
  if (shutdownStarted) shutdownFailure ??= { error };
}

export function toolInvocationShutdownStarted(): boolean {
  return shutdownStarted;
}

export function beginToolInvocationShutdown(): void {
  shutdownStarted = true;
}

/**
 * Claims run synchronously, so an abort refusal queues its row before this returns. A claimed tool that awaits first
 * (a deny firing a lifecycle hook) can meet an audit closed in the same tick. A permission row it then appends fails
 * and is recorded; only closeToolInvocations turns that into a failed shutdown.
 */
export function sealToolInvocations(): void {
  beginToolInvocationShutdown();
  shutdown.abort(new HostExitAbortError());
  const claims = [...sealClaims];
  sealClaims.clear();
  for (const claim of claims) {
    try { claim(); } catch (error) { recordToolInvocationFailure(error); }
  }
  closeDetachedToolInvocations();
}

/** Join admitted work, then close audit admission in the same step that observes the set empty. */
export function closeToolInvocations(): Promise<number> {
  closing ??= (async () => {
    let count = 0;
    while (pending.size > 0 || commits.size > 0) {
      const batch = [...pending];
      count += batch.length;
      await Promise.allSettled([...batch, ...commits]);
    }
    admissionClosed = true;

    // Failures recorded while close was pending still fail this shutdown.
    if (shutdownFailure) throw new Error("shutdown invocation drain failed", { cause: shutdownFailure.error });
    return count;
  })();
  return closing;
}

export function pendingToolInvocationCount(): number {
  return pending.size + detached.size;
}

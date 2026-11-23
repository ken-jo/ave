import type { AuditLogger } from "../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../audit/audit-schema.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { HostExitAbortError } from "../shared/host-exit-abort.js";

const log = createLogger("invocation-ledger");
const shutdown = new AbortController();
const pending = new Set<Promise<unknown>>();
const detached = new Map<object, () => Promise<unknown>>();
const sealClaims = new Set<() => void>();
const hostTerminals = new Map<object, () => void>();
let closing: Promise<number> | undefined;
let auditClosed = false;
let shutdownStarted = false;
let shutdownFailure: { error: unknown } | undefined;

/** Exactly one of the invocation and the host writes an admitted invocation's terminal row. */
export interface InvocationTerminal {
  /** Registers the host's synchronous terminal row, written only if a forced shutdown finds the invocation still parked. */
  hostTerminal(write: () => void): void;
  /** False once the host wrote the terminal row: the invocation then writes nothing. */
  claimTerminal(): boolean;
}

export function admitToolInvocation(tool: string, parent?: AbortSignal): InvocationTerminal & {
  signal: AbortSignal;
  settle(): void;
} {
  const signal = AbortSignal.any(parent ? [shutdown.signal, parent] : [shutdown.signal]);
  if (auditClosed) {
    // Its denial can no longer be written, so refuse it and fail the shutdown.
    log.error("tool invocation admitted after audit close: %s", tool);
    recordToolInvocationAuditFailure(new Error(`tool invocation admitted after audit close: ${tool}`));
    return { signal, settle() {}, hostTerminal() {}, claimTerminal: () => true };
  }
  let resolve!: () => void;
  const completion = new Promise<void>((done) => { resolve = done; });
  pending.add(completion);
  const token = {};
  let terminal: "open" | "invocation" | "host" = "open";
  return {
    signal,
    settle() {
      hostTerminals.delete(token);
      pending.delete(completion);
      resolve();
    },
    hostTerminal(write) {
      if (terminal !== "open") return;
      hostTerminals.set(token, () => {
        if (terminal !== "open") return;
        terminal = "host";
        write();
      });
    },
    claimTerminal() {
      if (terminal === "host") return false;
      terminal = "invocation";
      hostTerminals.delete(token);
      return true;
    },
  };
}

/** Forced shutdown: before the sink closes, the host writes the terminal row of every admitted invocation that has not. */
export function commitParkedHostTerminals(): void {
  const writes = [...hostTerminals.values()];
  hostTerminals.clear();
  for (const write of writes) {
    try { write(); } catch (error) { recordToolInvocationAuditFailure(error); }
  }
}

/** Admission unless the audit is closed; a closed refusal has no row left to write, so it fails nothing. */
export function admitToolInvocationWhileAuditOpen(tool: string, parent?: AbortSignal): ReturnType<typeof admitToolInvocation> | undefined {
  return auditClosed ? undefined : admitToolInvocation(tool, parent);
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

export async function appendToolInvocationAudit(
  logger: Pick<AuditLogger, "appendPermissionAuditEntry">,
  entry: PermissionAuditEntryInput,
): ReturnType<AuditLogger["appendPermissionAuditEntry"]> {
  try {
    return await logger.appendPermissionAuditEntry(entry);
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
    while (pending.size > 0) {
      const batch = [...pending];
      count += batch.length;
      await Promise.allSettled(batch);
    }
    auditClosed = true;
    await close();
    // Failures recorded while close was pending still fail this shutdown.
    if (shutdownFailure) throw new Error("shutdown invocation audit failed", { cause: shutdownFailure.error });
    return count;
  })();
  return closing;
}

export function markToolInvocationAuditClosed(): void {
  auditClosed = true;
}

export function pendingToolInvocationCount(): number {
  return pending.size + detached.size;
}

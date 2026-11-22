import type { AuditLogger } from "../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../audit/audit-schema.js";
import { createLogger } from "../lib/logger.js";
import { HostExitAbortError } from "../shared/host-exit-abort.js";

const log = createLogger("invocation-ledger");
const shutdown = new AbortController();
const pending = new Set<Promise<unknown>>();
const detached = new Map<object, () => Promise<unknown>>();
const sealClaims = new Set<() => void>();
let closing: Promise<number> | undefined;
let auditClosed = false;
let shutdownStarted = false;
let shutdownFailure: { error: unknown } | undefined;

export function admitToolInvocation(tool: string, parent?: AbortSignal): {
  signal: AbortSignal;
  settle(): void;
} {
  const signal = AbortSignal.any(parent ? [shutdown.signal, parent] : [shutdown.signal]);
  if (auditClosed) {
    // Its denial can no longer be written, so refuse it and fail the shutdown.
    log.error("tool invocation admitted after audit close: %s", tool);
    recordToolInvocationAuditFailure(new Error(`tool invocation admitted after audit close: ${tool}`));
    return { signal, settle() {} };
  }
  let resolve!: () => void;
  const completion = new Promise<void>((done) => { resolve = done; });
  pending.add(completion);
  return {
    signal,
    settle() {
      pending.delete(completion);
      resolve();
    },
  };
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
    log.error("detached tool invocation audit failed: %s", error instanceof Error ? error.message : String(error));
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

/** `startQueued: false` drops the claims for a caller that closes the audit in the same tick; their tools meet the closed gate. */
export function sealToolInvocations({ startQueued = true }: { startQueued?: boolean } = {}): void {
  beginToolInvocationAuditShutdown();
  shutdown.abort(new HostExitAbortError());
  const claims = startQueued ? [...sealClaims] : [];
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

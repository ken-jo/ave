import type { AuditLogger } from "../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../audit/audit-schema.js";
import { createLogger } from "../lib/logger.js";
import { HostExitAbortError } from "../shared/host-exit-abort.js";

const log = createLogger("invocation-ledger");
const shutdown = new AbortController();
const pending = new Set<Promise<unknown>>();
let join: Promise<number> | undefined;
let auditClosed = false;
let shutdownStarted = false;
let shutdownFailure: { error: unknown } | undefined;

export function admitToolInvocation(tool: string, parent?: AbortSignal): {
  signal: AbortSignal;
  settle(): void;
} {
  if (auditClosed) log.error("tool invocation admitted after audit close: %s", tool);
  let resolve!: () => void;
  const completion = new Promise<void>((done) => { resolve = done; });
  pending.add(completion);
  return {
    signal: AbortSignal.any(parent ? [shutdown.signal, parent] : [shutdown.signal]),
    settle() {
      pending.delete(completion);
      resolve();
    },
  };
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

export function recordToolInvocationAuditFailure(error: unknown): void {
  if (shutdownStarted) shutdownFailure ??= { error };
}

export function beginToolInvocationAuditShutdown(): void {
  shutdownStarted = true;
}

export function sealToolInvocations(): void {
  beginToolInvocationAuditShutdown();
  shutdown.abort(new HostExitAbortError());
}

export function joinToolInvocations(): Promise<number> {
  join ??= (async () => {
    let count = 0;
    while (pending.size > 0) {
      const batch = [...pending];
      count += batch.length;
      await Promise.allSettled(batch);
    }
    if (shutdownFailure) throw new Error("shutdown invocation audit failed", { cause: shutdownFailure.error });
    return count;
  })();
  return join;
}

export function markToolInvocationAuditClosed(): void {
  auditClosed = true;
}

export function pendingToolInvocationCount(): number {
  return pending.size;
}

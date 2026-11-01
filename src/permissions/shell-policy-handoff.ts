import { createSerialQueue } from "../lib/with-file-lock.js";

const shellPolicyQueue = createSerialQueue();

// Reject async callbacks: validation and execution must share one event-loop turn.
export type ShellPolicyHandoff<T> = () => T & (T extends PromiseLike<unknown> ? never : unknown);

// All persisted shell policy writers in this host share the execution queue.
export function withShellPolicyMutation<T>(mutation: () => Promise<T>): Promise<T> {
  return shellPolicyQueue(mutation);
}

// Final validation and the grant run synchronously. In-memory rule, mode and settings setters cannot interleave this callback on the host's event loop.
// Asynchronous preparation (such as a fresh owner-identity probe) finishes before the caller joins the queue, so it never holds every other policy writer;
// the handoff must repeat its synchronous revocation fence because the queue wait follows that preparation.
export async function withShellPolicyHandoff<T>(handoff: ShellPolicyHandoff<T>, prepare?: () => Promise<void>): Promise<T> {
  await prepare?.();
  return shellPolicyQueue(async () => handoff());
}

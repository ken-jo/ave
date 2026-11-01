import { createSerialQueue } from "../lib/with-file-lock.js";

const shellPolicyQueue = createSerialQueue();

// Reject async callbacks: validation and execution must share one event-loop turn.
export type ShellPolicyHandoff<T> = () => T & (T extends PromiseLike<unknown> ? never : unknown);

// All persisted shell policy writers in this host share the execution queue.
export function withShellPolicyMutation<T>(mutation: () => Promise<T>): Promise<T> {
  return shellPolicyQueue(mutation);
}

// Final validation and the grant run synchronously. In-memory rule, mode and settings setters cannot interleave this callback on the host's event loop.
export function withShellPolicyHandoff<T>(handoff: ShellPolicyHandoff<T>, prepare?: () => Promise<void>): Promise<T> {
  return shellPolicyQueue(async () => { await prepare?.(); return handoff(); });
}

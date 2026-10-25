// Tracks effective origin through process-local async frames; independent IPC messages establish their own origin.
// Foreground origin does not grant app-only reachability or prove browser user activation.
import { AsyncLocalStorage } from "node:async_hooks";

// Trusted UI may carry verified browser activation; untrusted card calls always use governed execution.
// All consumers share this origin union rather than redefining it.
export type InvocationOrigin = "plugin" | "ui" | "mcp-app";

interface ChainFrame {
  /** Outermost (effective) origin observed in this chain. */
  effectiveOrigin: InvocationOrigin;
}

const storage = new AsyncLocalStorage<ChainFrame>();

// Least-trusted origin wins across ambient, parent, and current inputs: mcp-app > ui > plugin.
// Nested calls must never launder untrusted card origin into trusted panel authority.
export function runWithInvocationOrigin<T>(
  current: InvocationOrigin,
  parentOrigin: InvocationOrigin | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const inherited = storage.getStore()?.effectiveOrigin;
  const effective = resolveEffectiveOrigin(inherited, parentOrigin, current);
  return storage.run({ effectiveOrigin: effective }, fn);
}

function resolveEffectiveOrigin(
  inherited: InvocationOrigin | undefined,
  parentOrigin: InvocationOrigin | undefined,
  current: InvocationOrigin,
): InvocationOrigin {
  const chain = [inherited, parentOrigin, current];
  if (chain.includes("mcp-app")) return "mcp-app";
  if (chain.includes("ui")) return "ui";
  return "plugin";
}

/** Independent entry points have no ambient invocation origin. */
export function currentInvocationOrigin(): InvocationOrigin | undefined {
  return storage.getStore()?.effectiveOrigin;
}

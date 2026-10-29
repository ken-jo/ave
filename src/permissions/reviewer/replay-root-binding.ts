import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonicalStringify } from "../../shared/canonical-json.js";

const REPLAY_ROOT_BINDING_BRAND: unique symbol = Symbol("replay-root-binding");

/** Host-only invalidation token. It grants no execution or filesystem authority. */
export interface ReplayRootBinding {
  readonly [REPLAY_ROOT_BINDING_BRAND]: true;
}

const issuedBindings = new WeakSet<object>();
const bindingRoots = new WeakMap<object, { cwd: string; digest: string }>();

/** Never retain a cleartext root in persisted replay metadata. */
export function captureReplayRootDigest(cwd: string): string | undefined {
  try {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
    const lexicalRoot = resolve(cwd);
    const canonicalRoot = realpathSync(lexicalRoot);
    const facts = statSync(canonicalRoot, { bigint: true });
    if (!facts.isDirectory()) return undefined;
    return createHash("sha256").update(canonicalStringify({
      lexicalRoot, canonicalRoot, dev: facts.dev.toString(), ino: facts.ino.toString(),
    })).digest("hex");
  } catch {
    return undefined;
  }
}

/** Issue only for a directory that still matches the original invocation fingerprint. */
export function issueReplayRootBinding(cwd: string, expectedRootDigest: string): ReplayRootBinding | undefined {
  const digest = captureReplayRootDigest(cwd);
  if (digest === undefined || digest !== expectedRootDigest) return undefined;
  const binding: ReplayRootBinding = Object.freeze({ [REPLAY_ROOT_BINDING_BRAND]: true as const });
  issuedBindings.add(binding);
  bindingRoots.set(binding, { cwd, digest });
  return binding;
}

/** Recheck at the final handler boundary after every approval or other asynchronous wait. */
export function checkReplayRootBinding(binding: unknown): { valid: true } | { valid: false; reason: string } {
  if (binding === null || typeof binding !== "object" || !issuedBindings.has(binding)) {
    return { valid: false, reason: "Invalid replay root binding" };
  }
  const root = bindingRoots.get(binding);
  if (!root || captureReplayRootDigest(root.cwd) !== root.digest) {
    return { valid: false, reason: "Replay root changed before execution" };
  }
  return { valid: true };
}

/** Evaluate source-bound revocations synchronously at load; report pre-feed use so an inactive check is visible. */
import { createLogger } from "../../lib/logger.js";
import { findRevocation } from "../../marketplace/catalog/aggregate.js";
import type { PackageKind, Revocation } from "../../marketplace/catalog/types.js";

const log = createLogger("revocation-registry");

export interface RevocationRule extends Revocation {
  sourceId: string;
}

export type RevocationDecision =
  | { kind: "allow" }
  | {
      kind: "block";
      sourceId: string;
      action: Revocation["action"];
      reason: string;
    };

class RevocationRegistry {
  private rules = new Map<string, RevocationRule[]>();
  private readonly listeners = new Set<() => void>();
  private fed = false;
  private reportedUnfed = false;

  resetForTesting(): void {
    this.rules = new Map();
    this.fed = false;
    this.reportedUnfed = false;
  }

  /** Replace all rules and report whether dependents need reevaluation. */
  replace(rules: readonly RevocationRule[]): boolean {
    const next = new Map<string, RevocationRule[]>();
    for (const rule of rules) {
      const key = `${rule.kind}:${rule.name}`;
      next.set(key, [...(next.get(key) ?? []), { ...rule }]);
    }
    const changed = !this.fed || fingerprint(next) !== fingerprint(this.rules);
    this.rules = next;
    this.fed = true;
    // An unchanged rule set can still cover a newly installed version.
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { log.error({ error }, "revocation listener failed"); }
    }
    return changed;
  }

  onUpdated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  evaluate(kind: PackageKind, name: string, version: string): RevocationDecision {
    if (!this.fed) this.reportUnfed();
    const rules = this.rules.get(`${kind}:${name}`);
    if (!rules) return { kind: "allow" };
    const rule = findRevocation(kind, name, version, rules);
    return rule ? { kind: "block", sourceId: rule.sourceId, action: rule.action, reason: rule.reason } : { kind: "allow" };
  }

  private reportUnfed(): void {
    if (this.reportedUnfed) return;
    this.reportedUnfed = true;
    log.error(
      "revocation_unconfigured: evaluate() was called before revocations were fed from the "
        + "marketplace snapshots — nothing is revoked until they are",
    );
  }
}

function fingerprint(rules: ReadonlyMap<string, readonly RevocationRule[]>): string {
  return JSON.stringify([...rules.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The feed replaces this shared registry; package loads read it. */
export const revocationRegistry = new RevocationRegistry();

/**
 * Revocations of installed packages (design §10.4), answered synchronously
 * where the host loads a package: the plugin runtime's `markRevoked` and the
 * installed-content reload.
 *
 * Each source's `policy/revocations.json` travels in its snapshot. The feed
 * (`marketplace/app/revocations.ts`) hands this registry, for every installed
 * package bound to a source, that source's revocations of that package and
 * nothing else, so no source can revoke what another published. Boot feeds it
 * from the snapshots on disk before plugins load; the marketplace feeds it
 * again after each sync and each install or uninstall.
 *
 * Revocations come from snapshots the app already holds, so nothing here
 * depends on the network: offline, the last synced list keeps applying.
 *
 * `evaluate()` before the first feed allows — denying there would refuse every
 * installed package on a boot-ordering bug — but it reports itself once
 * through `log.error`, because a revocation check that silently became a
 * no-op is otherwise invisible.
 */
import { createLogger } from "../../lib/logger.js";
import { findRevocation } from "../../marketplace/catalog/aggregate.js";
import type { PackageKind, Revocation } from "../../marketplace/catalog/types.js";

const log = createLogger("revocation-registry");

/** One source's revocation of a package installed from that source. */
export interface RevocationRule extends Revocation {
  sourceId: string;
}

/** Caller-facing decision shape — discriminated union for exhaustive narrowing. */
export type RevocationDecision =
  | { kind: "allow" }
  | {
      kind: "block";
      sourceId: string;
      action: Revocation["action"];
      /** The source's own reason, as written in its revocations file. */
      reason: string;
    };

class RevocationRegistry {
  private rules = new Map<string, RevocationRule[]>();
  private readonly listeners = new Set<() => void>();
  private fed = false;
  /** Whether the pre-feed use has already been reported — reported once. */
  private reportedUnfed = false;

  /** Test-only — reset state between tests. */
  resetForTesting(): void {
    this.rules = new Map();
    this.fed = false;
    this.reportedUnfed = false;
  }

  /** Replace every rule. Returns whether the set changed, so a caller can re-apply what depends on it. */
  replace(rules: readonly RevocationRule[]): boolean {
    const next = new Map<string, RevocationRule[]>();
    for (const rule of rules) {
      const key = `${rule.kind}:${rule.name}`;
      next.set(key, [...(next.get(key) ?? []), { ...rule }]);
    }
    const changed = !this.fed || fingerprint(next) !== fingerprint(this.rules);
    this.rules = next;
    this.fed = true;
    // Even an unchanged feed can describe a newly installed package version.
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { log.error({ error }, "revocation listener failed"); }
    }
    return changed;
  }

  onUpdated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Whether an installed `version` of `(kind, name)` is revoked by the source it is bound to. */
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

/** Process-wide singleton. The revocation feed replaces its rules; package loads evaluate them. */
export const revocationRegistry = new RevocationRegistry();

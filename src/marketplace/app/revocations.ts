/**
 * The revocation feed (design §10.4): each installed package bound to a
 * source gets that source's revocations of it, and nothing from any other
 * source. The registry (`plugins/revocation/revocation-registry.ts`) answers
 * the load gates from these rules; the service acts on the `uninstall` ones.
 */
import { errorMessage } from "../../shared/error-message.js";
import type { RevocationRule } from "../../plugins/revocation/revocation-registry.js";
import type { PackageKind, Revocation } from "../catalog/types.js";

/** An installed package and the source it is bound to. */
export interface BoundInstall {
  kind: PackageKind;
  name: string;
  sourceId: string;
}

export interface RevocationFeed {
  rules: RevocationRule[];
  /** Sources whose snapshot could not be read: their packages get no rules until it can. */
  unreadable: Array<{ sourceId: string; message: string }>;
}

/**
 * `revocationsOf` answers a source's revocations at its pin (empty before its
 * first sync). A source whose snapshot cannot be read is reported, not
 * skipped silently: its revocations stop applying until it is repaired.
 */
export async function revocationFeed(
  installed: readonly BoundInstall[],
  revocationsOf: (sourceId: string) => Promise<readonly Revocation[]>,
): Promise<RevocationFeed> {
  const bySource = new Map<string, BoundInstall[]>();
  for (const item of installed) bySource.set(item.sourceId, [...(bySource.get(item.sourceId) ?? []), item]);
  const rules: RevocationRule[] = [];
  const unreadable: RevocationFeed["unreadable"] = [];
  for (const [sourceId, items] of bySource) {
    let revocations: readonly Revocation[];
    try {
      revocations = await revocationsOf(sourceId);
    } catch (error) {
      unreadable.push({ sourceId, message: errorMessage(error) });
      continue;
    }
    for (const revocation of revocations) {
      if (items.some((item) => item.kind === revocation.kind && item.name === revocation.name)) rules.push({ ...revocation, sourceId });
    }
  }
  return { rules, unreadable };
}

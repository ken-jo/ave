/** Defaults belong to the user after their first application; policy may add more. */
import type { PackageKey } from "../sources/policy.js";

export const DEFAULT_INSTALLS: readonly PackageKey[] = Object.freeze([
  Object.freeze({ kind: "plugin", name: "meeting", source: "ave" }),
  Object.freeze({ kind: "plugin", name: "local-indexer", source: "ave" }),
]);

export function packageKeyId(key: PackageKey): string {
  return `${key.kind}/${key.name}@${key.source}`;
}

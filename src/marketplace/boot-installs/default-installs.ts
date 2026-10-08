/**
 * The packages a fresh installation starts with (design §10.2). Changed only
 * by an app release; the machine's policy file may add more
 * (`marketplaces.defaultInstalls`). Each key is installed once and then
 * belongs to the user.
 */
import type { PackageKey } from "../sources/policy.js";

export const DEFAULT_INSTALLS: readonly PackageKey[] = Object.freeze([
  Object.freeze({ kind: "plugin", name: "meeting", source: "ave" }),
  Object.freeze({ kind: "plugin", name: "local-indexer", source: "ave" }),
]);

export function packageKeyId(key: PackageKey): string {
  return `${key.kind}/${key.name}@${key.source}`;
}

import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import type { SourceSnapshot } from "../sources/snapshot.js";
import type { Revocation } from "./types.js";

/** Evaluate against the running host, never the app that built the snapshot. */
export function effectiveRevocations(snapshot: SourceSnapshot, appVersion: string): Revocation[] {
  return [...snapshot.revocations, ...(snapshot.conditionalRevocations ?? []).filter(
    (entry) => appVersionSatisfiesMin(appVersion, entry.appVersions),
  )];
}

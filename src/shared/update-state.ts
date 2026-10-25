/** Share the update state union across main, preload, and renderer so new variants reach every boundary. */

export type UpdateState =
  /** No known update — default; never re-emits after first sync. */
  | { kind: "idle" }
  /** Feed reports a newer version. User must click badge to start download. */
  | { kind: "available"; version: string }
  /** Download in flight. Badge shows percent. Click is a no-op. */
  | { kind: "downloading"; version: string; percent: number }
  /** Local zip ready. Click → quitAndInstall. */
  | { kind: "downloaded"; version: string };

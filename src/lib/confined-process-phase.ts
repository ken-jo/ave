/** Never recursively delete trees writable by live confined processes; rename to host-only tombstones and remove next boot. Bind mounts remain writable after rename, and the started phase is irreversible. */
let confinedProcessesMayRun = false;

export function noteConfinedProcessesMayRun(): void {
  confinedProcessesMayRun = true;
}

export function confinedProcessesMayBeRunning(): boolean {
  return confinedProcessesMayRun;
}

export function assertNoConfinedProcessMayRun(what: string): void {
  if (confinedProcessesMayRun) {
    throw new Error(
      `[confined-process-phase] refusing to delete ${what} recursively: confined processes may already be running, `
        + "and one could still write inside it; rename it into a tombstone for the next boot instead",
    );
  }
}

export function _resetConfinedProcessPhaseForTests(): void {
  confinedProcessesMayRun = false;
}

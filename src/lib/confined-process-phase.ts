/**
 * Whether a confined process (plugin child, worker, bundled MCP server or
 * hook, sandboxed shell command) may be running in this app process yet.
 *
 * WHY THE HOST CARES. Plugin trees hold directories a confined process may
 * write: a plugin's `data/`, `sockets/`, a worker's `run/<id>/`, an agent
 * plugin's data directory. A host-side recursive delete of such a tree while
 * that process runs is the classic `rm -rf` race: the process swaps a
 * subdirectory for a link to an outside directory between the delete's lstat
 * and its descent, and the host deletes outside files. Renaming the tree away
 * first is not enough on Linux: bubblewrap grants a writable directory with
 * `--bind`, which holds the directory itself, not its path, so a renamed tree
 * stays writable by the child that was bound to it.
 *
 * So such a tree is deleted for real only before any confined process has
 * started — at boot, before plugins start, when nothing from this process can
 * be bound to it, and the previous process's children died with it
 * (`--die-with-parent` on Linux; Seatbelt rules name paths that are gone). At
 * runtime the tree is renamed into a host-only tombstone and the next boot
 * deletes it.
 *
 * The phase is one-way. It begins at the first sandbox wrap or at plugin
 * start, whichever comes first; nothing ends it.
 */
let confinedProcessesMayRun = false;

export function noteConfinedProcessesMayRun(): void {
  confinedProcessesMayRun = true;
}

export function confinedProcessesMayBeRunning(): boolean {
  return confinedProcessesMayRun;
}

/** Fail clearly when a recursive delete that needs no live writer comes too late. */
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

/**
 * Refuse a push whose commits share no history with the remote's default
 * branch.
 *
 * The repository was re-created on 2026-10-17 from a rewritten history, so a
 * clone made before that date still holds the old commits. A new branch pushed
 * from such a clone is not a non-fast-forward (the remote has no ref of that
 * name), so the server accepts it and the old history's objects land in the
 * new repository. Every legitimate branch is cut from the remote's history, so
 * "no merge-base with the remote default branch" is the signal.
 *
 * Kept out of run-local-checks.mjs because that module runs its checks at
 * import; this one takes its git runner as an argument so it can be exercised
 * directly.
 */

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const NULL_OBJECT_ID = /^0+$/;

/**
 * Parse `git ls-remote --symref -- <remote> HEAD`. Returns the default branch
 * ref and its tip, `{ empty: true }` for a remote that has no HEAD yet (a fresh
 * repository), or null for any other shape.
 */
export function parseRemoteDefaultHead(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length === 0) return { empty: true };
  let ref = null;
  let sha = null;
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 2 || fields[1] !== "HEAD") return null;
    const [value] = fields;
    if (value.startsWith("ref: ")) {
      if (ref !== null) return null;
      ref = value.slice("ref: ".length);
      continue;
    }
    if (!OBJECT_ID.test(value) || sha !== null) return null;
    sha = value.toLowerCase();
  }
  if (ref === null || !ref.startsWith("refs/heads/") || ref === "refs/heads/" || sha === null) return null;
  return { ref, sha };
}

function resolveLocalTrackingTip(remoteName, git) {
  if (typeof remoteName !== "string" || remoteName === "" || /[\0\r\n\s]/.test(remoteName)) return null;
  for (const name of ["HEAD", "main"]) {
    const ref = `refs/remotes/${remoteName}/${name}`;
    const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = (result.stdout ?? "").trim().toLowerCase();
    if (result.status === 0 && OBJECT_ID.test(sha)) return { ref, sha };
  }
  return null;
}

function hasCommit(git, sha) {
  return git(["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/**
 * Decide whether the pushed commits share history with the remote's default
 * branch.
 *
 * `git(args)` and `fetchGit(args)` run git in the repository and return
 * `{ status, stdout, stderr }`; fetchGit is the same runner with the longer
 * timeout a fetch needs. Returns `{ kind, message }`:
 *   - "skip": the default branch is unknown (no push remote, a remote with no
 *     HEAD yet, or a listing that failed with no local tracking ref), or
 *     nothing but deletions is pushed;
 *   - "ok": every pushed commit has a merge-base with the default branch tip;
 *   - "refuse": a pushed commit has none, or the check could not be completed.
 */
export function checkSharedHistory({ updates, remoteName, remoteLocation, git, fetchGit }) {
  const pushed = updates.filter((update) => !NULL_OBJECT_ID.test(update.localSha));
  if (pushed.length === 0) return { kind: "skip", message: "the push only deletes refs" };

  const usableLocation = typeof remoteLocation === "string" && remoteLocation !== "" &&
    !/[\0\r\n]/.test(remoteLocation);
  let base = null;
  let source = null;
  if (usableLocation) {
    const listing = git(["ls-remote", "--symref", "--", remoteLocation, "HEAD"]);
    const head = listing.status === 0 ? parseRemoteDefaultHead(listing.stdout ?? "") : null;
    if (head?.empty) {
      return { kind: "skip", message: "the remote has no default branch yet (a fresh repository)" };
    }
    if (head) {
      base = head;
      source = "remote";
    }
  }
  if (!base) {
    base = resolveLocalTrackingTip(remoteName, git);
    source = "tracking";
  }
  if (!base) {
    return {
      kind: "skip",
      message: usableLocation
        ? `the remote's default branch could not be listed and there is no local ${remoteName || "remote"}/HEAD or ${remoteName || "remote"}/main`
        : "no push remote was given, so its default branch is unknown",
    };
  }

  if (!hasCommit(git, base.sha)) {
    // Only the live tip of a listed remote can be missing; a tracking ref
    // always points at a local commit.
    console.log(`[checks] fetching ${base.ref} (${base.sha.slice(0, 12)}) to compare history with the push`);
    const fetched = fetchGit([
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remoteLocation, base.ref,
    ]);
    if (!hasCommit(git, base.sha)) {
      const detail = fetched.status === 0
        ? "the fetch succeeded but the tip is still absent (the branch moved after ls-remote)"
        : `git fetch exited ${fetched.status ?? "abnormally"}: ${(fetched.stderr ?? "").split(/\r?\n/).at(-1) || "no error output"}`;
      return {
        kind: "refuse",
        message: [
          `[PRE_PUSH_SHARED_HISTORY_UNVERIFIED] refusing push: the remote's ${base.ref} tip ${base.sha.slice(0, 12)} is not available locally to compare history with (${detail}).`,
          `Run \`git fetch ${remoteName || "<remote>"}\` and push again.`,
        ].join("\n"),
      };
    }
  }

  const unrelated = [];
  for (const update of pushed) {
    const mergeBase = git(["merge-base", update.localSha, base.sha]);
    if (mergeBase.status === 0) continue;
    if (mergeBase.status === 1) {
      unrelated.push(`  ${update.remoteRef} (${update.localSha.slice(0, 12)})`);
      continue;
    }
    return {
      kind: "refuse",
      message: `[PRE_PUSH_SHARED_HISTORY_UNVERIFIED] refusing push: git merge-base ${update.localSha.slice(0, 12)} ${base.sha.slice(0, 12)} exited ${mergeBase.status ?? "abnormally"}: ${(mergeBase.stderr ?? "").trim() || "no error output"}`,
    };
  }
  const where = source === "remote" ? `the remote's ${base.ref}` : base.ref;
  if (unrelated.length > 0) {
    return {
      kind: "refuse",
      message: [
        `[PRE_PUSH_UNRELATED_HISTORY] refusing push: these updates share no history with ${where} (${base.sha.slice(0, 12)}):`,
        ...unrelated,
        "This checkout holds a different history from the remote, for example a clone made before the repository was re-created on 2026-10-17.",
        "Pushing it would upload that history's objects. Clone the repository again and re-apply your commits there (git format-patch, then git am).",
      ].join("\n"),
    };
  }
  return {
    kind: "ok",
    message: `every pushed commit shares history with ${where} (${base.sha.slice(0, 12)})`,
  };
}

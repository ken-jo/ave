/**
 * Parsing of git's pre-push ref-update list, and the base a new branch's
 * update is compared against.
 *
 * Split out of run-local-checks.mjs so it can be tested directly: that module
 * runs its checks at import, so importing it to exercise a pure function is
 * not possible. Sits beside the other pre-push-*.mjs policy modules.
 */
import { readFileSync } from "node:fs";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const INTEGRATION_BRANCH_PREFIX = "refs/heads/integration/";

/**
 * `integration/<category>` branches collect sub-branch PRs and reach the
 * default branch through one category PR whose CI runs everything. They are
 * not branch-protected; they advance through reviewed PR merges and
 * lead-run merges of main, so a direct push to one is the exceptional case
 * and is treated like a push to the default branch: full checks.
 */
export function isIntegrationBranchRef(ref) {
  return typeof ref === "string" &&
    ref.startsWith(INTEGRATION_BRANCH_PREFIX) &&
    ref.length > INTEGRATION_BRANCH_PREFIX.length;
}

/**
 * Parse `git ls-remote --symref -- <remote> HEAD refs/heads/*`. Returns the
 * remote's default branch ref and its branch heads, or null for any output
 * that is not exactly that shape: a base derived from a misread listing would
 * not be conservative.
 */
export function parseRemoteHeads(text) {
  if (typeof text !== "string") return null;
  let defaultRef = null;
  const heads = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields.length !== 2) return null;
    const [value, name] = fields;
    if (value.startsWith("ref: ")) {
      if (name !== "HEAD" || defaultRef !== null) return null;
      defaultRef = value.slice("ref: ".length);
      continue;
    }
    if (!OBJECT_ID.test(value)) return null;
    if (name === "HEAD") continue;
    if (!name.startsWith("refs/heads/") || name === "refs/heads/" || heads.has(name)) return null;
    heads.set(name, value.toLowerCase());
  }
  if (!defaultRef?.startsWith("refs/heads/") || !heads.has(defaultRef)) return null;
  return { defaultRef, heads };
}

/**
 * The remote heads a new branch may be measured from: the default branch and
 * every `integration/*` branch. The trust basis differs between the two:
 * the default branch is protected and moves only through PRs with green CI.
 * Integration branches are unprotected and CI does not run on PRs into
 * them; their tips advance through reviewed PR merges and lead-run merges of
 * main, every push behind those ran this hook (AGENTS.md forbids bypassing
 * it), and the category->main PR's full CI is the backstop before anything
 * reaches main. Feature branches are not candidates: nothing reviews what
 * lands on them. Default branch first, then by name, so the choice between
 * equally close bases is deterministic.
 */
export function selectBaseCandidates(remoteHeads) {
  const { defaultRef, heads } = remoteHeads;
  return [...heads]
    .filter(([ref]) => ref === defaultRef || isIntegrationBranchRef(ref))
    .map(([ref, sha]) => ({ ref, sha }))
    .sort((a, b) => {
      if (a.ref === defaultRef) return -1;
      if (b.ref === defaultRef) return 1;
      return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
    });
}

/** Candidates whose live tip commit is not in the local object store. */
export function findMissingCandidateTips(candidates, git) {
  return candidates.filter((candidate) => git(["cat-file", "-e", `${candidate.sha}^{commit}`]).status !== 0);
}

/**
 * Pick the merge-base of `localSha` with a candidate's live tip that leaves the
 * fewest commits in base..local. Only the tip's commit object has to be
 * present locally; the local tracking ref may be stale, because the live tip
 * comes from the remote itself. Returns { ref, sha, count } or null when no
 * present candidate shares history with the pushed commit.
 *
 * `git(args)` runs git in the repository and returns { status, stdout }.
 */
export function chooseNewBranchBase(localSha, candidates, git) {
  let best = null;
  for (const candidate of candidates) {
    if (git(["cat-file", "-e", `${candidate.sha}^{commit}`]).status !== 0) continue;
    const mergeBase = git(["merge-base", localSha, candidate.sha]);
    const base = (mergeBase.stdout ?? "").trim().toLowerCase();
    if (mergeBase.status !== 0 || !OBJECT_ID.test(base)) continue;
    const counted = git(["rev-list", "--count", `${base}..${localSha}`]);
    const count = Number((counted.stdout ?? "").trim());
    if (counted.status !== 0 || !Number.isSafeInteger(count) || count < 0) continue;
    if (best === null || count < best.count) best = { ref: candidate.ref, sha: base, count };
  }
  return best;
}

/**
 * Read git's ref-update list from stdin.
 *
 * Reports whether the read SUCCEEDED separately from what it produced. "git
 * sent an empty list" and "we could not read git's list" both look like an
 * empty string and must not be treated alike — see parsePrePushUpdates.
 */
export function readPrePushInput() {
  // A TTY on stdin means this was not invoked by git as a pre-push hook, so
  // there is no ref-update list to read — not an empty one.
  if (process.stdin.isTTY) return { readable: false, text: "" };
  try {
    return { readable: true, text: readFileSync(0, "utf-8") };
  } catch {
    return { readable: false, text: "" };
  }
}
/**
 * `complete` means every ref update git reported was understood, so a caller
 * enforcing branch policy is deciding on the real set.
 *
 * An input that could not be read is NOT complete — the caller must refuse. An
 * input that was read and is empty IS complete: git had no ref updates to
 * send, so the push changes no ref and cannot violate a branch policy.
 *
 * Conflating those two refused every re-run of an already-landed push with a
 * parse error. That reads as a failed push while the branch is in fact on the
 * remote at the right commit, which is a confusing way to learn there was
 * nothing left to do.
 */
export function parsePrePushUpdates({ readable, text }) {
  if (!readable) return { updates: [], complete: false };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const updates = [];
  let complete = true;

  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      complete = false;
      continue;
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    const validObjectIds = [localSha, remoteSha].every((sha) =>
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)
    );
    if (!localRef || !remoteRef || !validObjectIds) {
      complete = false;
      continue;
    }
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }

  return { updates, complete: complete && updates.length === lines.length };
}

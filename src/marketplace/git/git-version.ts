/**
 * `git --version` parsing and the minimum usable version (design §9.1).
 *
 * 2.38.1 is the first release where partial clone with `blob:none`,
 * `rev-list --missing=print`, protocol v2 and `protocol.file.allow` all
 * behave the way the invocation contract (§9.3) relies on.
 */
export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  /** The version as printed, e.g. `2.39.5 (Apple Git-154)` or `2.45.1.windows.1`. */
  text: string;
}

const MIN_GIT_VERSION: Readonly<GitVersion> = Object.freeze({
  major: 2,
  minor: 38,
  patch: 1,
  text: "2.38.1",
});

export function parseGitVersion(output: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?(.*)$/mu.exec(output.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? "0"),
    text: `${match[1]}.${match[2]}${match[3] === undefined ? "" : `.${match[3]}`}${match[4] ?? ""}`.trim(),
  };
}

function compareGitVersion(a: GitVersion, b: GitVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function meetsMinimumGitVersion(version: GitVersion): boolean {
  return compareGitVersion(version, MIN_GIT_VERSION) >= 0;
}

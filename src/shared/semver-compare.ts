/**
 * Shared semver comparator — single source of truth for version-precedence
 * comparisons across the host (tool registry "pick latest", plugin
 * minAppVersion gate, …).
 *
 * Returns `a < b ? -1 : a > b ? 1 : 0`.
 *
 * Implements semver pre-release precedence correctly: the numeric core
 * (`major.minor.patch`) is compared first, then a version *with* a pre-release
 * tag ranks BELOW the same core without one (`1.0.0-beta` < `1.0.0`), and two
 * pre-releases compare identifier-by-identifier (numeric identifiers compared
 * numerically and ranked below alphanumeric ones; a larger identifier set wins
 * when all earlier identifiers are equal). Build metadata (`+…`) is ignored.
 * Non-numeric *core* segments fall back to lexical compare. Good enough for
 * picking "latest" and for `>=` gates without pulling in the `semver` package.
 */
/** Loose semver core — `major.minor.patch` prefix, pre-release/build suffix allowed. */
export const SEMVER_CORE_PATTERN = /^\d+\.\d+\.\d+/;

export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { core: string[]; pre: string[] } => {
    const noBuild = v.split("+", 1)[0] ?? v;
    const dash = noBuild.indexOf("-");
    const coreStr = dash === -1 ? noBuild : noBuild.slice(0, dash);
    const preStr = dash === -1 ? "" : noBuild.slice(dash + 1);
    return { core: coreStr.split("."), pre: preStr === "" ? [] : preStr.split(".") };
  };
  const pa = parse(a);
  const pb = parse(b);

  // 1. Numeric core (pad the shorter side with "0").
  const coreLen = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < coreLen; i++) {
    const sa = pa.core[i] ?? "0";
    const sb = pb.core[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    const bothNum = !Number.isNaN(na) && !Number.isNaN(nb);
    if (bothNum) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }

  // 2. Equal core: a release outranks its own pre-release.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  // 3. Both pre-release: compare dot-separated identifiers.
  const preLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < preLen; i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === undefined) return -1; // fewer identifiers → lower precedence
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    const aNum = /^\d+$/.test(ia);
    const bNum = /^\d+$/.test(ib);
    if (aNum && bNum) return Number(ia) < Number(ib) ? -1 : 1;
    if (aNum) return -1; // numeric identifiers rank below alphanumeric
    if (bNum) return 1;
    return ia < ib ? -1 : 1; // lexical ASCII
  }
  return 0;
}

/**
 * A complete SemVer 2.0 version: no leading zeros in numeric parts, a
 * pre-release of dot-separated non-empty identifiers, build metadata likewise.
 * Bounded so a hand-edited file cannot hand the comparator an unbounded string.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

export function isSemver(value: string): boolean {
  return value.length <= 128 && SEMVER_RE.test(value);
}

/** A stable `major.minor.patch` core, pre-release or build suffix allowed after it. */
const STABLE_CORE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/;

/**
 * Plugin↔app minimum-version gate. Returns `true` when the running app version
 * satisfies the plugin's declared `minAppVersion` (i.e. `appVersion >= min`).
 *
 * Fail-closed: if either input is missing/unparseable (e.g. the app version
 * resolver returned the `"unknown"` sentinel), this returns `false` so an
 * incompatible plugin is blocked rather than silently allowed. Callers treat a
 * `false` result as "needs newer app".
 */
export function appVersionSatisfiesMin(appVersion: string, minAppVersion: string): boolean {
  if (!appVersion || !minAppVersion) return false;
  // The app version is the running build's package.json version. If it is the
  // `"unknown"` fallback sentinel (or otherwise not a recognizable semver
  // core), fail closed — we cannot prove compatibility.
  if (!STABLE_CORE.test(appVersion)) return false;
  return compareSemver(appVersion, minAppVersion) >= 0;
}

/** A stable release and nothing else: `X.Y.Z`, no leading zeros, no suffix. */
const STABLE_RELEASE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Whether `version` is at least two minor releases behind `running`: a higher
 * running major, or the same major with a minor at least two ahead. Patch and
 * the stored version's pre-release are not compared.
 *
 * Callers drop data on `true`, so the running version must be a stable
 * release: a pre-release build has not shipped the version it names, and the
 * resolver's `"unknown"` sentinel or any malformed string must keep
 * everything. The stored version must be a complete SemVer version.
 */
export function isTwoMinorReleasesBehind(version: string, running: string): boolean {
  const stored = isSemver(version) ? STABLE_CORE.exec(version) : null;
  const current = STABLE_RELEASE.exec(running);
  if (!stored || !current) return false;
  const storedMajor = Number(stored[1]);
  const currentMajor = Number(current[1]);
  if (currentMajor !== storedMajor) return currentMajor > storedMajor;
  return Number(current[2]) - Number(stored[2]) >= 2;
}

/** Compare numeric core before prerelease identifiers; releases outrank prereleases and build metadata is ignored. Non-numeric core segments compare lexically. */
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

  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const preLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < preLen; i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    const aNum = /^\d+$/.test(ia);
    const bNum = /^\d+$/.test(ib);
    if (aNum && bNum) return Number(ia) < Number(ib) ? -1 : 1;
    if (aNum) return -1; // numeric identifiers rank below alphanumeric
    if (bNum) return 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

/** Complete SemVer 2.0 syntax, bounded against untrusted file input. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

export function isSemver(value: string): boolean {
  return value.length <= 128 && SEMVER_RE.test(value);
}

const STABLE_CORE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/;

/** Fail closed when either version is missing or unparseable; compatibility must be proven. */
export function appVersionSatisfiesMin(appVersion: string, minAppVersion: string): boolean {
  if (!appVersion || !minAppVersion) return false;
  if (!STABLE_CORE.test(appVersion)) return false;
  return compareSemver(appVersion, minAppVersion) >= 0;
}

const STABLE_RELEASE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Data-dropping callers require a stable running release and complete stored SemVer; prerelease or unknown running versions must retain data. */
export function isTwoMinorReleasesBehind(version: string, running: string): boolean {
  const stored = isSemver(version) ? STABLE_CORE.exec(version) : null;
  const current = STABLE_RELEASE.exec(running);
  if (!stored || !current) return false;
  const storedMajor = Number(stored[1]);
  const currentMajor = Number(current[1]);
  if (currentMajor !== storedMajor) return currentMajor > storedMajor;
  return Number(current[2]) - Number(stored[2]) >= 2;
}

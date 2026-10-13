import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

/**
 * electron-builder names the Windows executable `<build.productName>.exe`, so
 * the selection reads the same field instead of repeating the product name.
 */
const PRODUCT_NAME = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).build?.productName;
if (typeof PRODUCT_NAME !== "string" || PRODUCT_NAME.length === 0) {
  throw new Error("package.json build.productName is required to locate the packaged executable");
}
const WINDOWS_EXECUTABLE_NAME = `${PRODUCT_NAME}.exe`;

export function linuxExecutablePreferenceSuffixes(arch, separator) {
  const names = ["Ave", "ave"];
  return [
    ...names.map((name) => `${separator}linux-${arch}-unpacked${separator}${name}`),
    ...names.map((name) => `${separator}linux-unpacked${separator}${name}`),
  ];
}

export function pickBestByExactSuffix(paths, preferredSuffixes) {
  const rank = (path) => {
    const index = preferredSuffixes.findIndex((suffix) => path.endsWith(suffix));
    return index === -1 ? preferredSuffixes.length : index;
  };
  return [...paths].sort((a, b) =>
    rank(a) - rank(b) || a.length - b.length || a.localeCompare(b)
  )[0] ?? null;
}

function walkFiles(dir, depth = 0, maxDepth = 7) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function canExecute(file) {
  if (process.platform === "win32") return true;
  try {
    return (statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function pickBest(paths, preferredNeedles) {
  return [...paths].sort((a, b) => {
    const aScore = preferredNeedles.reduce((score, needle, idx) => score + (a.includes(needle) ? 100 - idx : 0), 0);
    const bScore = preferredNeedles.reduce((score, needle, idx) => score + (b.includes(needle) ? 100 - idx : 0), 0);
    return bScore - aScore || a.length - b.length || a.localeCompare(b);
  })[0] ?? null;
}

/**
 * The unpacked executable electron-builder produced for `target` (`mac`,
 * `linux` or `win`) under `releaseDir`, or `null` when there is none. Shared by
 * every script that launches the packaged build, so they all run the same
 * binary.
 */
export function findPackagedExecutable(target, releaseDir) {
  if (!existsSync(releaseDir)) {
    throw new Error(`release directory not found: ${releaseDir}`);
  }

  const files = walkFiles(releaseDir);
  if (target === "mac") {
    const matches = files.filter((file) =>
      file.endsWith(`${sep}Contents${sep}MacOS${sep}Ave`) &&
      file.includes(`.app${sep}`) &&
      canExecute(file)
    );
    return pickBest(matches, [`mac-arm64${sep}`, `${sep}Ave.app${sep}`]);
  }

  if (target === "linux") {
    const executableNames = new Set(["Ave", "ave"]);
    const matches = files.filter((file) =>
      file.split(sep).some((part) => part === "linux-unpacked" || /^linux-.+-unpacked$/u.test(part)) &&
      executableNames.has(basename(file)) &&
      canExecute(file)
    );
    return pickBestByExactSuffix(
      matches,
      linuxExecutablePreferenceSuffixes(process.arch, sep),
    );
  }

  const matches = files.filter((file) =>
    file.includes(`win-unpacked${sep}`) &&
    basename(file).toLowerCase() === WINDOWS_EXECUTABLE_NAME.toLowerCase()
  );
  return pickBest(matches, [`win-unpacked${sep}${WINDOWS_EXECUTABLE_NAME}`]);
}

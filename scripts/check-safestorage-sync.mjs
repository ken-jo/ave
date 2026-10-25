/**
 * check-safestorage-sync.mjs — no synchronous safeStorage call may meet Electron 46
 *
 * WHY THIS GATE EXISTS. Electron 45 deprecates the synchronous safeStorage methods
 * (`isEncryptionAvailable`, `encryptString`, `decryptString`), and Electron 46
 * removes them with Chromium's synchronous OSCrypt backend. On 45 they still work
 * and warn once, and what they encrypt stays readable through the async methods
 * (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`), so
 * the move to the async API is its own change rather than part of the 45 bump.
 *
 * What must not happen is a bump to 46 that leaves a synchronous call behind: the
 * call sites are the audit HMAC key store, the desktop secret encryption adapter and
 * the live smoke scripts, and on 46 each would fail at runtime, not at build time.
 * So this gate fails while the installed Electron major is 46 or later and any such
 * call remains in `src/` or `scripts/`, and the failure lists every site to move.
 * Below 46 it only reports how many sites are left.
 */
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import process from "node:process";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const ROOT = process.cwd();
/** The first Electron major without the synchronous methods. */
export const SYNC_SAFE_STORAGE_REMOVED_IN = 46;
/** A call of a synchronous method on `safeStorage`, also through a member (`this.safeStorage`). */
const SYNC_CALL = /\bsafeStorage\s*\.\s*(isEncryptionAvailable|encryptString|decryptString)\s*\(/g;
const SCAN_DIRS = ["src", "scripts"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", ".claude", ".worktrees"]);
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"];

/** The major of the Electron installed under `root`; an absent or malformed one is the failure. */
export function installedElectronMajor(root = ROOT) {
  let version;
  try {
    version = JSON.parse(readFileSync(`${root}/node_modules/electron/package.json`, "utf-8")).version;
  } catch (error) {
    return { error: `cannot read the installed electron package: ${error instanceof Error ? error.message : String(error)}` };
  }
  const major = /^(\d+)\./.exec(String(version))?.[1];
  if (major === undefined) return { error: `the installed electron version "${version}" has no major` };
  return { major: Number(major) };
}

export function collectSyncSafeStorageCalls(root = ROOT) {
  const calls = [];
  for (const dir of SCAN_DIRS) {
    for (const path of walkSourceFiles(`${root}/${dir}`, {
      skipDirs: SKIP_DIRS,
      extensions: EXTENSIONS,
      tolerateUnreadableDirs: true,
    })) {
      const text = readFileSync(path, "utf-8");
      if (!text.includes("safeStorage")) continue;
      for (const [index, line] of text.split("\n").entries()) {
        for (const match of line.matchAll(SYNC_CALL)) {
          calls.push({ rel: relative(root, path).split(sep).join("/"), line: index + 1, method: match[1] });
        }
      }
    }
  }
  return calls;
}

/** `electronMajor` overrides the installed one (tests). */
export function checkSyncSafeStorage(root = ROOT, options = {}) {
  const installed = options.electronMajor === undefined ? installedElectronMajor(root) : { major: options.electronMajor };
  if (installed.error) return { ok: false, problems: [installed.error], calls: [] };
  const calls = collectSyncSafeStorageCalls(root);
  const problems = [];
  if (installed.major >= SYNC_SAFE_STORAGE_REMOVED_IN && calls.length > 0) {
    problems.push(
      `Electron ${installed.major} has no synchronous safeStorage methods, and ${calls.length} call(s) remain. ` +
        "Move each site below to isAsyncEncryptionAvailable / encryptStringAsync / decryptStringAsync " +
        "(data encrypted by encryptString stays readable by decryptStringAsync).",
    );
  }
  return { ok: problems.length === 0, problems, calls, major: installed.major };
}

export function runSyncSafeStorageCli(options = {}) {
  const root = options.root ?? ROOT;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const result = checkSyncSafeStorage(root, options);
  if (result.ok) {
    stdout(
      `[safestorage-sync] OK — Electron ${result.major}; ${result.calls.length} synchronous call(s) ` +
        `left to move before Electron ${SYNC_SAFE_STORAGE_REMOVED_IN}`,
    );
    return 0;
  }
  for (const problem of result.problems) stderr(`[safestorage-sync] ${problem}`);
  for (const call of result.calls) stderr(`  ${call.rel}:${call.line}  (safeStorage.${call.method})`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runSyncSafeStorageCli();
}

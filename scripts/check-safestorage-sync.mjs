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
 * So this gate fails while the installed Electron major is 46 or later and any
 * synchronous member is still reached in `src/` or `scripts/`, and the failure lists
 * every site to move. Below 46 it only reports how many sites are left.
 *
 * WHAT IT READS. Whole files, so a member access split across lines counts. A sync
 * member is reached by `safeStorage.name`, `safeStorage?.name` or
 * `safeStorage["name"]` (also through a member, `this.safeStorage.name`), with any
 * whitespace between the parts, or by destructuring it out of `safeStorage`. A
 * reference is enough: passing `safeStorage.encryptString` along calls it later.
 *
 * A file that imports `safeStorage` from "electron" and binds it to another name
 * (`import { safeStorage as s }`, `const s = safeStorage`, `{ store: safeStorage }`,
 * an argument, a `{ safeStorage }` shorthand) would hide every later call from the
 * scan, so that fails on any Electron version. Hand the adapter in
 * `src/main/desktop-secret-encryption.ts` around instead.
 */
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import process from "node:process";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const ROOT = process.cwd();
/** The first Electron major without the synchronous methods. */
export const SYNC_SAFE_STORAGE_REMOVED_IN = 46;
const SYNC_NAMES = "isEncryptionAvailable|encryptString|decryptString";
/** `safeStorage.name` / `safeStorage?.name`, whitespace and newlines allowed; `\b` keeps `…Async` out. */
const SYNC_MEMBER = new RegExp(`\\bsafeStorage\\s*(?:\\?\\.|\\.)\\s*(${SYNC_NAMES})\\b`, "g");
/** `safeStorage["name"]` / `safeStorage?.["name"]`. */
const SYNC_BRACKET = new RegExp(`\\bsafeStorage\\s*(?:\\?\\.\\s*)?\\[\\s*(["'\`])(${SYNC_NAMES})\\1\\s*\\]`, "g");
/** `{ … } = safeStorage` (also `= this.safeStorage`), the pattern's body in group 1. */
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:[\w$]+\s*(?:\?\.|\.)\s*)*safeStorage\b(?!\s*(?:\?\.|\.|\[))/g;
const SYNC_NAME = new RegExp(`\\b(${SYNC_NAMES})\\b`, "g");
/** A file that takes `safeStorage` from Electron. */
const ELECTRON_IMPORT = /\bfrom\s*["']electron(?:\/main)?["']|\brequire\s*\(\s*["']electron(?:\/main)?["']\s*\)/;
/** The import and require statements themselves, removed before looking for aliases. */
const IMPORT_STATEMENTS = [
  /\bimport\s+[^;]*?\bfrom\s*["'][^"']+["']/g,
  /\b(?:const|let|var)\s*\{[^{}]*\}\s*=\s*require\s*\(\s*["'][^"']+["']\s*\)/g,
];
/** Renaming at the import: `safeStorage as s`, `{ safeStorage: s } = require(…)`. */
const IMPORT_ALIAS = [
  /\bimport\s+[^;]*?\bsafeStorage\s+as\s+[\w$]+[^;]*?\bfrom\s*["']electron(?:\/main)?["']/g,
  /\{[^{}]*\bsafeStorage\s*:\s*[\w${}]+[^{}]*\}\s*=\s*require\s*\(\s*["']electron(?:\/main)?["']\s*\)/g,
];
/** `safeStorage` as a value: assigned, an object value, an argument, a shorthand property. */
const VALUE_USE = [
  /(?<![=!<>])=(?![=>])\s*(?:[\w$]+\s*\.\s*)?safeStorage\b(?!\s*(?:\?\.|\.|\[|[\w$]))/g,
  /:\s*(?:[\w$]+\s*\.\s*)?safeStorage\s*[,}\n]/g,
  /[(,]\s*safeStorage\s*[,)]/g,
  /[{,]\s*safeStorage\s*[,}]/g,
];
const SCAN_DIRS = ["src", "scripts"];
/** This gate names every form it looks for, so it does not read itself. */
const SELF = "scripts/check-safestorage-sync.mjs";
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

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

/** Same length, so indexes (and line numbers) still point into the original text. */
function blank(text, patterns) {
  let out = text;
  for (const pattern of patterns) out = out.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
  return out;
}

/** Every reach of a sync member (`kind` "call" or "destructure") and every alias in one file's text. */
export function scanSafeStorageText(text) {
  const sites = [];
  const aliases = [];
  if (!text.includes("safeStorage")) return { sites, aliases };
  for (const pattern of [SYNC_MEMBER, SYNC_BRACKET]) {
    for (const match of text.matchAll(pattern)) {
      sites.push({ line: lineAt(text, match.index), method: match.at(-1), kind: "call" });
    }
  }
  for (const match of text.matchAll(DESTRUCTURE)) {
    for (const name of match[1].matchAll(SYNC_NAME)) {
      sites.push({ line: lineAt(text, match.index), method: name[1], kind: "destructure" });
    }
  }
  if (ELECTRON_IMPORT.test(text)) {
    for (const pattern of IMPORT_ALIAS) {
      for (const match of text.matchAll(pattern)) aliases.push({ line: lineAt(text, match.index) });
    }
    const code = blank(text, IMPORT_STATEMENTS);
    for (const pattern of VALUE_USE) {
      for (const match of code.matchAll(pattern)) aliases.push({ line: lineAt(code, match.index) });
    }
  }
  sites.sort((a, b) => a.line - b.line);
  aliases.sort((a, b) => a.line - b.line);
  return { sites, aliases };
}

export function collectSyncSafeStorageCalls(root = ROOT) {
  const calls = [];
  const aliases = [];
  for (const dir of SCAN_DIRS) {
    for (const path of walkSourceFiles(`${root}/${dir}`, {
      skipDirs: SKIP_DIRS,
      extensions: EXTENSIONS,
      tolerateUnreadableDirs: true,
    })) {
      const rel = relative(root, path).split(sep).join("/");
      if (rel === SELF) continue;
      const found = scanSafeStorageText(readFileSync(path, "utf-8"));
      for (const site of found.sites) calls.push({ rel, ...site });
      for (const alias of found.aliases) aliases.push({ rel, ...alias });
    }
  }
  return { calls, aliases };
}

/** `electronMajor` overrides the installed one (tests). */
export function checkSyncSafeStorage(root = ROOT, options = {}) {
  const installed = options.electronMajor === undefined ? installedElectronMajor(root) : { major: options.electronMajor };
  if (installed.error) return { ok: false, problems: [installed.error], calls: [], aliases: [] };
  const { calls, aliases } = collectSyncSafeStorageCalls(root);
  const problems = [];
  if (aliases.length > 0) {
    problems.push(
      `${aliases.length} place(s) bind Electron's safeStorage to another name, which hides its calls from this gate. ` +
        "Use the adapter in src/main/desktop-secret-encryption.ts instead.",
    );
  }
  if (installed.major >= SYNC_SAFE_STORAGE_REMOVED_IN && calls.length > 0) {
    problems.push(
      `Electron ${installed.major} has no synchronous safeStorage methods, and ${calls.length} use(s) remain. ` +
        "Move each site below to isAsyncEncryptionAvailable / encryptStringAsync / decryptStringAsync " +
        "(data encrypted by encryptString stays readable by decryptStringAsync).",
    );
  }
  return { ok: problems.length === 0, problems, calls, aliases, major: installed.major };
}

export function runSyncSafeStorageCli(options = {}) {
  const root = options.root ?? ROOT;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const result = checkSyncSafeStorage(root, options);
  if (result.ok) {
    stdout(
      `[safestorage-sync] OK — Electron ${result.major}; ${result.calls.length} synchronous use(s) ` +
        `left to move before Electron ${SYNC_SAFE_STORAGE_REMOVED_IN}`,
    );
    return 0;
  }
  for (const problem of result.problems) stderr(`[safestorage-sync] ${problem}`);
  for (const alias of result.aliases) stderr(`  ${alias.rel}:${alias.line}  (binds safeStorage to another name)`);
  if (result.major >= SYNC_SAFE_STORAGE_REMOVED_IN) {
    for (const call of result.calls) {
      stderr(`  ${call.rel}:${call.line}  (${call.kind === "destructure" ? "destructures " : ""}safeStorage.${call.method})`);
    }
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runSyncSafeStorageCli();
}

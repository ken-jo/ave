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
 * WHO MAY TOUCH IT. Only the files in SAFE_STORAGE_OWNERS may name `safeStorage` in
 * a file that also loads Electron (`from "electron"`, `require("electron")`,
 * `import("electron")`); everyone else uses the adapter in
 * `src/main/desktop-secret-encryption.ts`. Any other such file fails on every
 * Electron version: once the object is renamed, re-exported or passed around, no
 * pattern can follow it to its calls, so an allowlist is the only rule that holds.
 * Test files are exempt from that rule, because their `vi.mock("electron", …)` and
 * `mockedElectron.safeStorage` are mocks, not uses; their sync-member references
 * still count toward the migration. Exporting `safeStorage`, or re-exporting it
 * (or all of Electron) from "electron", fails everywhere, owners and test files
 * included.
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
/** A file that loads Electron. */
const ELECTRON_REF = /\bfrom\s*["']electron(?:\/[\w-]+)?["']|\b(?:require|import)\s*\(\s*["']electron(?:\/[\w-]+)?["']\s*\)/;
/** `export { safeStorage … } from "electron"` and `export * from "electron"`. */
const ELECTRON_REEXPORT = /\bexport\s+(?:type\s+)?(?:\{[^{}]*\bsafeStorage\b[^{}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*["']electron(?:\/[\w-]+)?["']/g;
/** `export { safeStorage }` / `export default safeStorage`: an owner handing the object out. */
const SAFE_STORAGE_EXPORT = /\bexport\s+(?:default\s+safeStorage\b(?!\s*(?:\?\.|\.|\[))|(?:type\s+)?\{[^{}]*\bsafeStorage\b[^{}]*\}(?!\s*from\b))/g;
const SAFE_STORAGE_IDENTIFIER = /\bsafeStorage\b/;
/** The only files that may name `safeStorage` beside Electron. */
export const SAFE_STORAGE_OWNERS = Object.freeze([
  "src/main/desktop-secret-encryption.ts",
  "scripts/smoke-live-app.mjs",
  "scripts/smoke-live-model.mjs",
]);
/** A vitest file: `__tests__/`, `*.test.*` or `*.spec.*`. */
export function isTestFile(rel) {
  return /(?:^|\/)__tests__\//.test(rel) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel);
}
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

/**
 * Every reach of a sync member (`kind` "call" or "destructure") in one file's text,
 * and every `aliases` entry: a re-export, or (outside the owners and test files) a
 * use of `safeStorage` beside Electron.
 */
export function scanSafeStorageText(text, rel = "") {
  const sites = [];
  const aliases = [];
  if (!text.includes("safeStorage") && !text.includes("electron")) return { sites, aliases };
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
  for (const match of text.matchAll(ELECTRON_REEXPORT)) {
    aliases.push({ line: lineAt(text, match.index), reason: "re-exports Electron's safeStorage" });
  }
  for (const match of text.matchAll(SAFE_STORAGE_EXPORT)) {
    aliases.push({ line: lineAt(text, match.index), reason: "exports Electron's safeStorage" });
  }
  if (!SAFE_STORAGE_OWNERS.includes(rel) && !isTestFile(rel) && ELECTRON_REF.test(text)) {
    const use = SAFE_STORAGE_IDENTIFIER.exec(text);
    if (use) aliases.push({ line: lineAt(text, use.index), reason: "names safeStorage beside Electron outside the owners" });
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
      const found = scanSafeStorageText(readFileSync(path, "utf-8"), rel);
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
      `${aliases.length} place(s) reach Electron's safeStorage outside ${SAFE_STORAGE_OWNERS.join(", ")}, ` +
        "where this gate cannot follow its calls. Use the adapter in src/main/desktop-secret-encryption.ts instead.",
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
  for (const alias of result.aliases) stderr(`  ${alias.rel}:${alias.line}  (${alias.reason})`);
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

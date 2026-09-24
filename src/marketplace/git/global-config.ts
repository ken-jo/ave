/**
 * The generated `GIT_CONFIG_GLOBAL` file (design §9.3).
 *
 * Marketplace git calls never read the user's own configuration: a
 * `url.*.insteadOf`, `http.extraHeader`, `http.sslVerify=false`,
 * `core.sshCommand` or alias there could redirect a fetch, leak a header or
 * run a program. Credential helpers are the exception worth keeping, so the
 * OS keychain and `gh auth git-credential` still answer for their hosts.
 *
 * The file is built from the system and global levels in the order git reads
 * them (system first), because Apple's and Homebrew's git configure the
 * keychain helper at the system level and `GIT_CONFIG_NOSYSTEM=1` would
 * otherwise drop it. Only these keys are copied:
 *
 *   credential.helper, credential.<url>.<key>, http.sslcainfo, http.sslbackend
 */
import { execFile } from "node:child_process";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";

export interface GitConfigEntry {
  key: string;
  /** `null` for a valueless key (`[credential] useHttpPath`), which git reads as boolean true. */
  value: string | null;
}

const COPIED_TOP_LEVEL_KEYS = new Set(["credential.helper", "http.sslcainfo", "http.sslbackend"]);

/**
 * Keep only the keys above. Section and variable names arrive lowercased from
 * `git config --list`; a subsection (the URL in `credential.<url>.helper`)
 * keeps its case. A valueless helper is copied as the empty value that resets
 * the helper list, since git refuses a helper without a value.
 */
export function selectCopiedEntries(entries: readonly GitConfigEntry[]): GitConfigEntry[] {
  return entries
    .filter(({ key }) => {
      if (COPIED_TOP_LEVEL_KEYS.has(key)) return true;
      if (!key.startsWith("credential.")) return false;
      const rest = key.slice("credential.".length);
      const lastDot = rest.lastIndexOf(".");
      return lastDot > 0 && /^[a-z][a-z0-9-]*$/u.test(rest.slice(lastDot + 1));
    })
    .map((entry) => (entry.value === null && entry.key.endsWith(".helper") ? { key: entry.key, value: "" } : entry));
}

/** Parse `git config --null --list`: `key\nvalue\0` records; a valueless key has no `\n`. */
export function parseNullConfigList(output: string): GitConfigEntry[] {
  const entries: GitConfigEntry[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const newline = record.indexOf("\n");
    entries.push(newline < 0 ? { key: record, value: null } : { key: record.slice(0, newline), value: record.slice(newline + 1) });
  }
  return entries;
}

function runConfig(gitPath: string, args: string[], env: Record<string, string>): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(gitPath, args, { env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout) }),
    );
  });
}

/**
 * Read the entries the generated file keeps. A level that does not exist or
 * cannot be read contributes nothing: an unreadable user config must not stop
 * the marketplace, it only means no credential helper answers.
 */
export async function readCopiedCredentialConfig(gitPath: string): Promise<GitConfigEntry[]> {
  const env = buildSafeChildEnv({ LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
  if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  const entries: GitConfigEntry[] = [];
  for (const level of ["--system", "--global"]) {
    const result = await runConfig(gitPath, ["config", level, "--null", "--list"], env);
    if (result.ok) entries.push(...parseNullConfigList(result.stdout));
  }
  return selectCopiedEntries(entries);
}

/**
 * Write the generated config to `outputPath` (replacing it atomically), one
 * section block per entry so git reads the entries back in the order they
 * were copied. Order matters: git collects `credential.helper` and
 * `credential.<url>.helper` in file order and an empty value resets the list,
 * while `git config --add` would file a value under an earlier section of the
 * same name. Values are quoted and escaped the way git reads them back.
 */
export async function writeGeneratedGlobalConfig(outputPath: string, entries: readonly GitConfigEntry[]): Promise<void> {
  await writeFileAtomicAtPath(outputPath, entries.map(formatConfigEntry).join(""));
}

function formatConfigEntry({ key, value }: GitConfigEntry): string {
  const firstDot = key.indexOf(".");
  const lastDot = key.lastIndexOf(".");
  if (firstDot <= 0 || lastDot === key.length - 1) throw new Error(`git config key has no section and variable: ${key}`);
  const section = key.slice(0, firstDot);
  const variable = key.slice(lastDot + 1);
  const header = lastDot === firstDot ? `[${section}]` : `[${section} "${escapeSubsection(key.slice(firstDot + 1, lastDot))}"]`;
  return value === null ? `${header}\n\t${variable}\n` : `${header}\n\t${variable} = "${escapeValue(value)}"\n`;
}

function escapeSubsection(subsection: string): string {
  if (/[\n\0]/u.test(subsection)) throw new Error("git config subsection holds a newline or NUL");
  return subsection.replace(/[\\"]/gu, (char) => `\\${char}`);
}

const VALUE_ESCAPES: Record<string, string> = { "\\": "\\\\", "\"": "\\\"", "\n": "\\n", "\t": "\\t", "\b": "\\b" };

function escapeValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- git config values carry no other control characters
  if (/[\0-\x07\x0b-\x1f\x7f]/u.test(value)) throw new Error("git config value holds a control character git cannot store");
  return value.replace(/[\\"\n\t\b]/gu, (char) => VALUE_ESCAPES[char] ?? char);
}

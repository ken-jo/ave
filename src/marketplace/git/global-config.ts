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
import { readFile, rm, writeFile } from "node:fs/promises";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";

export interface GitConfigEntry {
  key: string;
  value: string;
}

const COPIED_TOP_LEVEL_KEYS = new Set(["credential.helper", "http.sslcainfo", "http.sslbackend"]);

/**
 * Keep only the keys above. Section and variable names arrive lowercased from
 * `git config --list`; a subsection (the URL in `credential.<url>.helper`)
 * keeps its case.
 */
export function selectCopiedEntries(entries: readonly GitConfigEntry[]): GitConfigEntry[] {
  return entries.filter(({ key }) => {
    if (COPIED_TOP_LEVEL_KEYS.has(key)) return true;
    if (!key.startsWith("credential.")) return false;
    const rest = key.slice("credential.".length);
    const lastDot = rest.lastIndexOf(".");
    return lastDot > 0 && /^[a-z][a-z0-9-]*$/u.test(rest.slice(lastDot + 1));
  });
}

/** Parse `git config --null --list`: `key\nvalue\0` records; a valueless key has no `\n`. */
export function parseNullConfigList(output: string): GitConfigEntry[] {
  const entries: GitConfigEntry[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const newline = record.indexOf("\n");
    entries.push(newline < 0 ? { key: record, value: "" } : { key: record.slice(0, newline), value: record.slice(newline + 1) });
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
 * Write the generated config to `outputPath` (replacing it atomically). git
 * itself writes the entries, so values with quotes, `#`, `;` or backslashes
 * are escaped the way git reads them back.
 */
export async function writeGeneratedGlobalConfig(
  gitPath: string,
  outputPath: string,
  entries: readonly GitConfigEntry[],
): Promise<void> {
  const staging = `${outputPath}.${process.pid}.tmp`;
  await writeFile(staging, "", { mode: 0o600 });
  try {
    const env = buildSafeChildEnv({ LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
    for (const entry of entries) {
      const result = await runConfig(gitPath, ["config", "--file", staging, "--add", entry.key, entry.value], env);
      if (!result.ok) throw new Error(`git config --file could not store ${entry.key}`);
    }
    await writeFileAtomicAtPath(outputPath, await readFile(staging));
  } finally {
    await rm(staging, { force: true });
  }
}

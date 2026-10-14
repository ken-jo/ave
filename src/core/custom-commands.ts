/**
 * Custom slash commands — markdown files a person keeps as reusable prompts.
 *
 * `<project>/.ave/commands/<name>.md` and `<ave home>/commands/<name>.md`
 * each define `/<name>`. The body is the prompt; `$ARGUMENTS` (and `{args}`,
 * the placeholder package prompts use) is replaced with whatever followed the
 * command. Frontmatter `description` labels it in the slash picker and
 * `argument-hint` describes its arguments.
 *
 * Precedence: built-in commands are decided by the caller before this module
 * is asked; between the two directories the project wins, because it is the
 * narrower scope. Reading is confined to each directory: a symlink whose
 * realpath leaves it is skipped, as is anything that is not a regular file or
 * exceeds the size cap. Both directories are read-only here; nothing creates
 * them.
 */
import { open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import type { CustomCommandEntry, CustomCommandScope } from "../shared/custom-command.js";
import { parseFrontmatterBlock, unquoteFrontmatterValue } from "../main/skill-store.js";

/** A command file larger than this is not read. */
export const CUSTOM_COMMAND_MAX_BYTES = 32 * 1024;

/** File basenames that define a command; anything else in the directory is ignored. */
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

interface CustomCommandDefinition extends CustomCommandEntry {
  body: string;
}

function commandDirectories(projectRoot: string | undefined): Array<{ scope: CustomCommandScope; dir: string }> {
  return [
    ...(projectRoot ? [{ scope: "project" as const, dir: join(projectRoot, ".ave", "commands") }] : []),
    { scope: "user" as const, dir: join(aveHome(), "commands") },
  ];
}

async function readConfined(dir: string, name: string): Promise<string | null> {
  let canonicalDir: string;
  let canonicalFile: string;
  try {
    canonicalDir = await realpath(dir);
    canonicalFile = await realpath(join(dir, `${name}.md`));
  } catch {
    return null;
  }
  if (!canonicalFile.startsWith(`${canonicalDir}${sep}`)) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canonicalFile, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > CUSTOM_COMMAND_MAX_BYTES) return null;
    return (await handle.readFile("utf8")).replace(/\r\n/g, "\n");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function parseDefinition(name: string, scope: CustomCommandScope, raw: string): CustomCommandDefinition | null {
  const { fields, body } = parseFrontmatterBlock(raw);
  const trimmed = body.trim();
  if (!trimmed) return null;
  const description = unquoteFrontmatterValue(fields.get("description") ?? "");
  const argumentHint = unquoteFrontmatterValue(fields.get("argument-hint") ?? fields.get("argumentHint") ?? "");
  return {
    name,
    scope,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    body: trimmed,
  };
}

async function commandNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -".md".length))
      .filter((name) => COMMAND_NAME.test(name));
  } catch {
    return [];
  }
}

/** Every custom command visible from `projectRoot`, project entries first, sorted by name within each scope. */
export async function listCustomCommands(projectRoot: string | undefined): Promise<CustomCommandEntry[]> {
  const seen = new Set<string>();
  const entries: CustomCommandEntry[] = [];
  for (const { scope, dir } of commandDirectories(projectRoot)) {
    for (const name of (await commandNames(dir)).sort()) {
      if (seen.has(name)) continue;
      const raw = await readConfined(dir, name);
      const definition = raw === null ? null : parseDefinition(name, scope, raw);
      if (!definition) continue;
      seen.add(name);
      const { body: _body, ...entry } = definition;
      entries.push(entry);
    }
  }
  return entries;
}

/** The command `/<name>` resolves to, or `null` when no readable file defines it. */
export async function loadCustomCommand(
  name: string,
  projectRoot: string | undefined,
): Promise<CustomCommandDefinition | null> {
  if (!COMMAND_NAME.test(name)) return null;
  for (const { scope, dir } of commandDirectories(projectRoot)) {
    const raw = await readConfined(dir, name);
    const definition = raw === null ? null : parseDefinition(name, scope, raw);
    if (definition) return definition;
  }
  return null;
}

/**
 * Insert the arguments into a command body. Both `$ARGUMENTS` and `{args}`
 * are placeholders. A body with neither still receives non-empty arguments,
 * appended on their own line, so what the person typed is never dropped.
 */
export function expandCustomCommand(body: string, args: string): string {
  const hasPlaceholder = body.includes("$ARGUMENTS") || body.includes("{args}");
  if (!hasPlaceholder) return args ? `${body}\n\nARGUMENTS: ${args}` : body;
  return body.replaceAll("$ARGUMENTS", () => args).replaceAll("{args}", () => args);
}

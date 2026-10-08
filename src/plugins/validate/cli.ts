/**
 * `ave-plugin-validate <plugin dir>` — validate a plugin without the app
 * (`docs/design/plugin-hostapi-protocol.md` §9.7 P2, §10.2).
 *
 * The entry the plugin repositories bundle as
 * `tools/vendor/ave-plugin-validate.js`, beside the reference runtime bundled
 * as `ave-plugin-child-main.js`, which this locates next to itself. In this
 * repository `bun run plugin:validate <dir>` runs it from source.
 *
 *   --child-entry <path>      the reference runtime's entry (default: the
 *                             sibling `ave-plugin-child-main.js`)
 *   --child-exec-arg <arg>    prepended to the child's `node` invocation;
 *                             repeatable. A spawned child inherits none of
 *                             this process's Node flags, so source mode names
 *                             its loader here.
 *   --tool-args <file.json>   `{ "<tool>": { …arguments } }` for tools whose
 *                             input requires arguments
 *   --fast                    cap every protocol bound at 1 s
 *
 * stdout carries the report and nothing else: one JSON object per row. The
 * summary, and the child's own stderr, go to stderr. Exit 0 when every row
 * passed or was not exercised, 1 when one failed, 2 for a usage error.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorMessage } from "../../shared/error-message.js";
import { reportExitCode, reportLines, reportSummary } from "./report.js";
import { validatePluginDirectory, type ToolArguments } from "./validate-plugin.js";

const USAGE =
  "usage: ave-plugin-validate <plugin dir> [--child-entry <path>] " +
  "[--child-exec-arg <arg>]... [--tool-args <file.json>] [--fast]";

class UsageError extends Error {}

function readToolArguments(path: string): ToolArguments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new UsageError(`--tool-args ${path}: ${errorMessage(error)}`);
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(parsed) || !Object.values(parsed).every(isObject)) {
    throw new UsageError(`--tool-args ${path}: expected { "<tool name>": { …arguments } }`);
  }
  return parsed as ToolArguments;
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        "child-entry": { type: "string" },
        "child-exec-arg": { type: "string", multiple: true },
        "tool-args": { type: "string" },
        fast: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(`${errorMessage(error)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new UsageError(USAGE);
  const pluginDir = resolve(positionals[0]!);
  if (!existsSync(pluginDir)) throw new UsageError(`${pluginDir}: no such directory`);
  const childEntry = resolve(
    values["child-entry"] ?? fileURLToPath(new URL("./ave-plugin-child-main.js", import.meta.url)),
  );
  if (!existsSync(childEntry)) {
    throw new UsageError(`the reference runtime ${childEntry} is missing; pass --child-entry <path>`);
  }
  const rows = await validatePluginDirectory(pluginDir, {
    childEntry,
    childExecArgs: values["child-exec-arg"] ?? [],
    fast: values.fast ?? false,
    toolArgs: values["tool-args"] === undefined ? {} : readToolArguments(values["tool-args"]),
    onChildStderr: (chunk) => void process.stderr.write(chunk),
  });
  process.stdout.write(reportLines(rows));
  process.stderr.write(reportSummary(pluginDir, rows));
  return reportExitCode(rows);
}

main(process.argv.slice(2)).then(
  (code) => {
    // Not `process.exit`: stdout may be a pipe, and exiting now could cut the
    // report short. Nothing the run leaves behind keeps the process alive — a
    // child that outlived its termination was let go by the finalizer.
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof UsageError ? error.message : errorMessage(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);

/** Validate a plugin directory without the app; exit 0 for no failures, 1 for failed checks and 2 for usage errors. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorMessage } from "../../shared/error-message.js";
import { isRecord } from "../../shared/is-record.js";
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
  if (!isRecord(parsed) || !Object.values(parsed).every(isRecord)) {
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
    // Set exitCode rather than exit so piped report bytes can drain.
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof UsageError ? error.message : errorMessage(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);

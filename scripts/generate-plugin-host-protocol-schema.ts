/**
 * Write the plugin host protocol schema, or check the committed copy.
 *
 *   node --import tsx scripts/generate-plugin-host-protocol-schema.ts          write it
 *   node --import tsx scripts/generate-plugin-host-protocol-schema.ts --check  fail if it differs
 *
 * The generator is `scripts/lib/plugin-host-protocol-schema.ts`. This file is
 * only its command line, and it runs unconditionally: an "am I the entry
 * module" guard would compare two spellings of one path — argv keeps a
 * symlink, a junction, a `subst` drive or a short name that `import.meta.url`
 * has already resolved — and a mismatch would skip the check and exit 0, a
 * gate that passes by not running.
 *
 * Every run prints exactly one outcome line. Only `wrote …` and `… matches its
 * sources` exit 0.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_PROTOCOL_SCHEMA_LABEL as LABEL,
  generateHostProtocolSchema,
} from "./lib/plugin-host-protocol-schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Do what `args` asks, and return the outcome line; every other outcome throws. */
function run(args: readonly string[]): string {
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !check) {
    throw new Error(`unexpected arguments '${args.join(" ")}'; the only option is --check`);
  }
  const { path, text } = generateHostProtocolSchema();
  const target = join(ROOT, path);
  if (!check) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf-8");
    return `wrote ${path}`;
  }
  let committed: string;
  try {
    committed = readFileSync(target, "utf-8");
  } catch {
    throw new Error(`${path} is missing; run bun run generate:plugin-host-protocol-schema`);
  }
  // A copy saved with CRLF is the same schema; the blob is LF (.gitattributes).
  if (committed.replace(/\r\n/g, "\n") !== text) {
    throw new Error(
      `${path} differs from what the sources generate. Run `
        + "`bun run generate:plugin-host-protocol-schema` and commit the result; the diff is the protocol change.",
    );
  }
  return `${path} matches its sources`;
}

try {
  console.log(`${LABEL} ${run(process.argv.slice(2))}`);
} catch (error) {
  // One line, not a stack: this is a gate's verdict, read in a build log.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith(LABEL) ? message : `${LABEL} ${message}`);
  process.exitCode = 1;
}

/**
 * Write the plugin host protocol TS client, or check the committed copy.
 *
 *   node --import tsx scripts/generate-plugin-host-protocol-client.ts          write it
 *   node --import tsx scripts/generate-plugin-host-protocol-client.ts --check  fail if it differs or does not compile
 *
 * The generator is `scripts/lib/plugin-host-protocol-client.ts`. This file is
 * only its command line, and it runs unconditionally for the same reason the
 * schema's does (`generate-plugin-host-protocol-schema.ts`): an "am I the
 * entry module" guard compares two spellings of one path, and a mismatch would
 * skip the check and exit 0.
 *
 * `--check` compares bytes, then compiles in two separate programs, because
 * one invocation cannot serve both: `tsc` refuses file operands beside the
 * root `tsconfig.json` (TS5112), and the host modules the type equalities
 * import need the repository's `lib` and `skipLibCheck`, which an isolated
 * invocation discards.
 *
 *  1. standalone — the client alone, with no ambient type, no DOM and no Node,
 *     and with no file in the program besides it and the compiler's `lib`, so
 *     it passes only if the client really stands alone;
 *  2. host equality — `scripts/lib/plugin-host-protocol-client-assertions.ts`
 *     under the repository's own options, which fails when the client's unions
 *     and the host's constants disagree by a member.
 *
 * Every run prints exactly one outcome line. Only `wrote …` and `… matches its
 * schema …` exit 0.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_PROTOCOL_CLIENT_LABEL as LABEL,
  HOST_PROTOCOL_CLIENT_PROGRAMS,
  compileHostProtocolClientProgram,
  generateHostProtocolClient,
} from "./lib/plugin-host-protocol-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Do what `args` asks, and return the outcome line; every other outcome throws. */
async function run(args: readonly string[]): Promise<string> {
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !check) {
    throw new Error(`unexpected arguments '${args.join(" ")}'; the only option is --check`);
  }
  const { path, text } = await generateHostProtocolClient();
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
    throw new Error(`${path} is missing; run bun run generate:plugin-host-protocol-client`);
  }
  // A copy saved with CRLF is the same client; the blob is LF (.gitattributes).
  if (committed.replace(/\r\n/g, "\n") !== text) {
    throw new Error(
      `${path} differs from what the schema generates. Run `
        + "`bun run generate:plugin-host-protocol-client` and commit the result.",
    );
  }
  for (const [project, alone] of [
    [HOST_PROTOCOL_CLIENT_PROGRAMS.standalone, true],
    [HOST_PROTOCOL_CLIENT_PROGRAMS.hostEquality, false],
  ] as const) {
    const { ok, output } = compileHostProtocolClientProgram(project, { alone, node: process.execPath });
    if (!ok) throw new Error(`tsc -p ${project} failed: ${output.replace(/\r?\n/g, " | ")}`);
  }
  return `${path} matches its schema and compiles standalone and against the host`;
}

try {
  console.log(`${LABEL} ${await run(process.argv.slice(2))}`);
} catch (error) {
  // One line, not a stack: this is a gate's verdict, read in a build log.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith(LABEL) ? message : `${LABEL} ${message}`);
  process.exitCode = 1;
}

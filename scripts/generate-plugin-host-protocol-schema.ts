// Run unconditionally: path spelling differences must not let an entry-module guard skip verification.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_PROTOCOL_SCHEMA_LABEL as LABEL,
  generateHostProtocolSchema,
} from "./lib/plugin-host-protocol-schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  // Accept CRLF working copies; committed blobs remain LF.
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
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith(LABEL) ? message : `${LABEL} ${message}`);
  process.exitCode = 1;
}

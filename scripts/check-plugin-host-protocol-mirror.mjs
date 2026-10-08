import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProtocolMirror } from "./lib/plugin-host-protocol-mirror.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (process.argv.length !== 2) throw new Error("unexpected arguments");
  console.log(`[plugin-host-protocol-mirror] ${checkProtocolMirror(root)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

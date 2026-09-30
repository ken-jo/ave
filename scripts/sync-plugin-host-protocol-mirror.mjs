import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutGitContext } from "./lib/git-process-environment.mjs";
import { publishProtocolMirror, syncProtocolMirror } from "./lib/plugin-host-protocol-mirror.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
try {
  if (args.length === 2 && args[0] === "--publish") {
    const alias = publishProtocolMirror(root, args[1]);
    console.log(`[plugin-host-protocol-mirror] published ${args[1]}; ${alias}`);
  } else if (args.length === 0) {
    const generatedFrom = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8", env: withoutGitContext(),
    }).trim();
    syncProtocolMirror(root, generatedFrom);
    console.log(`[plugin-host-protocol-mirror] refreshed candidate from ${generatedFrom}`);
  } else {
    throw new Error("usage: node scripts/sync-plugin-host-protocol-mirror.mjs [--publish <protocol>/<version>]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

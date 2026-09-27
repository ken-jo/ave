import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutGitContext } from "./lib/git-process-environment.mjs";
import { syncProtocolMirror } from "./lib/plugin-host-protocol-mirror.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const generatedFrom = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8", env: withoutGitContext(),
  }).trim();
  syncProtocolMirror(root, generatedFrom);
  console.log(`[plugin-host-protocol-mirror] refreshed candidate from ${generatedFrom}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

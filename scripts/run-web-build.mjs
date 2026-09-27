import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = resolve(root, "web");
const guard = pathToFileURL(resolve(root, "scripts/lib/document-consumer-guard.mjs")).href;
const next = resolve(web, "node_modules/next/dist/bin/next");
const result = spawnSync(process.execPath, [next, "build"], {
  cwd: web,
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${guard}`].filter(Boolean).join(" "),
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

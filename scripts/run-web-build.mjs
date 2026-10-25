import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { guardedNodeOptions } from "./lib/document-consumer-node-options.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = resolve(root, "web");
const next = resolve(web, "node_modules/next/dist/bin/next");
const result = spawnSync(process.execPath, [next, "build", "--webpack"], {
  cwd: web,
  env: {
    ...process.env,
    NODE_OPTIONS: guardedNodeOptions(process.env.NODE_OPTIONS),
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

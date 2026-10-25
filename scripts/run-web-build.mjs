import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { guardedNodeOptions } from "./lib/document-consumer-node-options.mjs";
import { checkExport, finishNotFound } from "./lib/web-export.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = resolve(root, "web");
const next = resolve(web, "node_modules/next/dist/bin/next");
// The site's own SITE_ORIGIN is the one source; the link graph is checked against it.
const siteOrigin = /^export const SITE_ORIGIN = "([^"]+)";$/m.exec(readFileSync(resolve(web, "lib/i18n.ts"), "utf8"))?.[1];
if (!siteOrigin) throw new Error('web/lib/i18n.ts must declare the origin exactly as `export const SITE_ORIGIN = "…";`');
const result = spawnSync(process.execPath, [next, "build", "--webpack"], {
  cwd: web,
  env: {
    ...process.env,
    NODE_OPTIONS: guardedNodeOptions(process.env.NODE_OPTIONS),
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  // Move the not-found pages to the 404.html files the host serves, then check the export as a link graph.
  const out = resolve(web, "out");
  finishNotFound(out);
  const problems = checkExport(out, { origin: siteOrigin });
  if (problems.length) {
    console.error(`web export: ${problems.length} link-graph problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log("web export: 404 pages written, link graph clean");
  }
}

#!/usr/bin/env node
// Invoke directly with --grep to filter or --skip-build to reuse dist/.
// Dependencies must already be installed.

import { runCommand } from "./hooks/spawn-command.mjs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const configPath = resolve(repoRoot, "test/screenshots/playwright.config.ts");
const mainEntry = resolve(repoRoot, "dist/src/main/main.js");

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const passthroughArgs = args.filter((a) => a !== "--skip-build");

function run(cmd, cmdArgs, opts = {}) {
  runCommand(cmd, cmdArgs, { cwd: repoRoot, label: "capture-screenshots", ...opts });
}

if (!skipBuild || !existsSync(mainEntry)) {
  console.log("[capture-screenshots] building app (dist/src/main/main.js missing or --skip-build not set)");
  run("bun", ["run", "build"]);
} else {
  console.log("[capture-screenshots] --skip-build set and dist/src/main/main.js exists — reusing existing build");
}

console.log("[capture-screenshots] running Playwright capture harness");
run("bunx", ["playwright", "test", "--config", configPath, ...passthroughArgs]);

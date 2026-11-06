#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function findEmulatedViewports(root) {
  return walkSourceFiles(root).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/\bsetViewportSize\b/gu)].map((match) =>
      `${relative(root, file)}:${source.slice(0, match.index).split("\n").length}`,
    );
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findEmulatedViewports(resolve(REPO_ROOT, "test"));
  if (violations.length) {
    console.error(`Emulated viewports are forbidden in test/; use setWindowSize(app, width, height):\n${violations.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Test window-size check passed");
  }
}

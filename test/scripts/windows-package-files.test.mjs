import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getConfig } = require("app-builder-lib/out/util/config/config.js");
const { getMainFileMatchers, getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher.js");
const { AppFileWalker } = require("app-builder-lib/out/util/AppFileWalker.js");
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("Windows app file selection stays within the shared package inputs", async () => {
  const config = await getConfig(root);
  const destination = join(root, "release", "win-unpacked");
  const packager = { projectDir: root, buildResourcesDir: "build", config, debugLogger: { isEnabled: false } };
  const expand = (value) => value.replace(/\$\{arch\}/g, "x64");
  const matchers = getMainFileMatchers(root, destination, expand, config.win, { info: packager }, join(root, "release"), false);
  const walkers = matchers.map((matcher) => new AppFileWalker(matcher, packager));
  const file = { isDirectory: () => false };

  const candidates = ["dist/src/main/main.js", "package.json", "src/main.ts", "THIRD-PARTY-NOTICES.md"];
  const selected = candidates.filter((path) => walkers.some((walker) => walker.filter(join(root, path), file)));
  assert.deepEqual(selected, ["dist/src/main/main.js", "package.json"]);
});

test("Windows dependency selection keeps only the target memory runtime", async () => {
  const config = await getConfig(root);
  const destination = join(root, "release", "win-unpacked");
  const packager = { config, debugLogger: { isEnabled: false } };
  const expand = (value) => value.replace(/\$\{arch\}/g, "x64");
  const filter = getNodeModuleFileMatcher(root, destination, expand, config.win, packager).createFilter();
  const directory = { isDirectory: () => true };
  const runtime = join(root, "node_modules", "onnxruntime-node", "bin", "napi-v6");

  assert.equal(filter(join(runtime, "win32", "x64"), directory), true);
  assert.equal(filter(join(runtime, "win32", "arm64"), directory), false);
  assert.equal(filter(join(runtime, "darwin", "x64"), directory), false);
  assert.equal(filter(join(runtime, "linux", "x64"), directory), false);
});

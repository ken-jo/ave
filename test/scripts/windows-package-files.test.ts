import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { getConfig } = require("app-builder-lib/out/util/config/config.js");
const { getMainFileMatchers, getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher.js");
const { AppFileWalker } = require("app-builder-lib/out/util/AppFileWalker.js");
const root = resolve(import.meta.dirname, "../..");
const outputDirectory = join(root, "release");
const destination = join(outputDirectory, "win-unpacked");
const expand = (value: string) => value.replace(/\$\{arch\}/g, "x64");

describe("Windows package file selection", () => {
  it("keeps app files within the shared package inputs", async () => {
    const config = await getConfig(root);
    const packager = { projectDir: root, buildResourcesDir: "build", config, debugLogger: { isEnabled: false } };
    const matchers: FileMatcher[] = getMainFileMatchers(
      root,
      destination,
      expand,
      config.win,
      { info: packager },
      outputDirectory,
      false,
    );
    const walkers = matchers.map((matcher) => new AppFileWalker(matcher, packager));
    const file = { isDirectory: () => false };

    const candidates = ["dist/src/main/main.js", "package.json", "src/main.ts", "THIRD-PARTY-NOTICES.md"];
    const selected = candidates.filter((path) => walkers.some((walker) => walker.filter(join(root, path), file)));
    expect(selected).toStrictEqual(["dist/src/main/main.js", "package.json"]);
  });

  it("keeps only the target memory runtime in dependencies", async () => {
    const config = await getConfig(root);
    const packager = { config, debugLogger: { isEnabled: false } };
    const filter = getNodeModuleFileMatcher(root, destination, expand, config.win, packager).createFilter();
    const directory = { isDirectory: () => true };
    const runtime = join(root, "node_modules", "onnxruntime-node", "bin", "napi-v6");

    expect(filter(join(runtime, "win32", "x64"), directory)).toBe(true);
    expect(filter(join(runtime, "win32", "arm64"), directory)).toBe(false);
    expect(filter(join(runtime, "darwin", "x64"), directory)).toBe(false);
    expect(filter(join(runtime, "linux", "x64"), directory)).toBe(false);
  });
});

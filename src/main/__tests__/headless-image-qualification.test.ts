import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildImagePreparationEntry } from "../../__tests__/support/image-preparation-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { childBundleDir, repositoryRoot } from "../../plugins/isolation/__tests__/child-entry-bundle.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

it.skipIf(process.platform === "win32")("qualifies the staged decoder in the headless runtime probe", async () => {
  const directory = childBundleDir("headless-image-qualification");
  const root = join(directory, "artifact");
  try {
    await buildImagePreparationEntry("headless-image-qualification");
    const entry = join(root, "dist/src/main/image-preparation-child.js");
    const addons = join(root, "node_modules");
    await mkdir(dirname(entry), { recursive: true });
    await mkdir(addons);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ave", type: "module" }));
    await writeFile(entry, `import ${JSON.stringify(pathToFileURL(join(directory, "image-preparation-child.js")).href)};\n`);
    // Stub the unrelated probes while exercising the actual decoder and the image assertions.
    await writeFile(join(addons, "better-sqlite3.js"), "module.exports = class { prepare() { return { get: () => ({ value: 42 }) }; } close() {} };");
    await writeFile(join(addons, "node-pty.js"), "module.exports = { spawn: () => ({ onData: fn => fn('runtime-ok'), onExit: fn => fn({ exitCode: 0 }) }) };");
    await writeFile(join(addons, "sharp.js"), `module.exports = require(${JSON.stringify(join(repositoryRoot(), "node_modules/sharp"))});`);
    const library = join(addons, "@img", `sharp-libvips-${process.platform}-${process.arch}`);
    await mkdir(library, { recursive: true });
    await writeFile(join(library, "package.json"), JSON.stringify({ exports: { "./binary": "./after-image-qualification.cjs" } }));

    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    const result = spawnSync(node, [join(repositoryRoot(), "scripts/headless-runtime-smoke.mjs"), root], {
      encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.imagePreparationMs, env,
    });
    // The inventory lookup runs only after every image qualification assertion succeeds.
    expect(result.stderr).toMatch(/Cannot find module .*after-image-qualification\.cjs/);
  } finally {
    await cleanupTmpDir(directory);
  }
});

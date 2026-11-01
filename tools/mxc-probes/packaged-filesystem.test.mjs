import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { withOrdinaryFilesystem } from "./packaged-filesystem.mjs";
import { finalizePackagedObservation } from "./packaged-protocol.mjs";

const require = createRequire(import.meta.url);

test("ordinary filesystem scope restores its previous state after rejection", async () => {
  const owned = Object.hasOwn(process, "noAsar"), original = process.noAsar;
  try {
    for (const previous of [undefined, false, true]) {
      if (previous === undefined) delete process.noAsar;
      else process.noAsar = previous;
      await assert.rejects(withOrdinaryFilesystem(async () => {
        assert.equal(process.noAsar, true);
        throw new Error("copy failed");
      }), /copy failed/);
      assert.equal(process.noAsar, previous);
      assert.equal(Object.hasOwn(process, "noAsar"), previous !== undefined);
    }
  } finally {
    if (owned) process.noAsar = original;
    else delete process.noAsar;
  }
});

test("copies and measures a real archive as bytes before restoring entry loading", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ave-packaged-archive-")));
  try {
    const app = path.join(root, "app"), input = path.join(root, "input");
    await mkdir(path.join(app, "resources"), { recursive: true });
    await mkdir(input);
    await writeFile(path.join(input, "entry.cjs"), "module.exports = 'loaded-from-archive';\n");
    await writeFile(path.join(app, "ordinary.txt"), "ordinary bytes");
    const archive = path.join(app, "resources", "app.asar");
    await require("@electron/asar").createPackage(input, archive);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.ELECTRON_NO_ASAR;
    const child = spawnSync(require("electron"), ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { lstat, readFile } from 'node:fs/promises';
      import path from 'node:path';
      const root = process.argv[1];
      const { assertOrdinaryTree, copyPackagedTree, withOrdinaryFilesystem } = await import(process.argv[2]);
      const { retainedTreeSize, finalizePackagedObservation } = await import(process.argv[3]);
      const original = path.join(root, 'app', 'resources', 'app.asar');
      assert.equal((await lstat(original)).isDirectory(), true, 'real archive shim must be active');
      const previous = process.noAsar;
      await assertOrdinaryTree(path.join(root, 'app'));
      assert.equal(process.noAsar, previous);
      const copied = path.join(root, 'copy');
      await copyPackagedTree(path.join(root, 'app'), copied);
      assert.equal(process.noAsar, previous);
      const target = path.join(copied, 'resources', 'app.asar');
      const bytes = await withOrdinaryFilesystem(async () => {
        assert.equal((await lstat(target)).isFile(), true);
        const [sourceBytes, copiedBytes] = await Promise.all([readFile(original), readFile(target)]);
        assert.deepEqual(copiedBytes, sourceBytes);
        return copiedBytes.length;
      });
      assert.equal(await retainedTreeSize(copied), bytes + Buffer.byteLength('ordinary bytes'));
      assert.equal(process.noAsar, previous);
      const require = createRequire(import.meta.url);
      assert.equal(require(path.join(target, 'entry.cjs')), 'loaded-from-archive');
      const result = await finalizePackagedObservation({ observations: [], spawned: false }, copied, false);
      assert.equal(result.retainedTempRemovalSafe, true);
      assert.equal(result.tempSizeBytes, await retainedTreeSize(copied));
      assert.equal(process.noAsar, previous);
      // Exercise the real recursive removal under ordinary filesystem semantics.
      const removed = await finalizePackagedObservation({ spawned: true, observations: Array.from({ length: 8 }, () => ({ passed: true })),
        processCleanup: [{ cleanupDeathVerified: true }], unverifiedProcesses: [] }, copied, true);
      assert.equal(removed.tempRemoved, true);
      assert.equal(process.noAsar, previous);
      assert.equal(require(path.join(original, 'entry.cjs')), 'loaded-from-archive');
      console.log(JSON.stringify({ archiveCopiedAsFile: true, entryLoaded: true, sourceIntact: true, rawSizeVerified: true, rawRemovalVerified: true }));
    `, root, new URL("./packaged-filesystem.mjs", import.meta.url).href, new URL("./packaged-protocol.mjs", import.meta.url).href], {
      env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { archiveCopiedAsFile: true, entryLoaded: true, sourceIntact: true, rawSizeVerified: true, rawRemovalVerified: true });
    assert.ok((await readFile(archive)).length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retained deletion status distinguishes no launch from uncertain process death", async () => {
  const root = path.resolve(tmpdir(), "packaged-observation-unit");
  const io = { remove: async () => {}, write: async () => {}, measure: async () => 0 };
  const observation = (fields) => finalizePackagedObservation({ observations: [], ...fields }, root, false, io);
  assert.equal((await observation({ spawned: false })).retainedTempRemovalSafe, true);
  for (const fields of [{}, { spawned: true }, { spawned: true, processCleanup: [], unverifiedProcesses: [] }]) {
    const result = await observation(fields);
    assert.equal(result.spawned, true);
    assert.equal(result.retainedTempRemovalSafe, false);
  }
  const evidence = { spawned: true, observations: [], processCleanup: [{ cleanupDeathVerified: true }], unverifiedProcesses: [] };
  assert.equal((await finalizePackagedObservation(evidence, root, true, io)).retainedTempRemovalSafe, true);
  for (const partial of [
    { processCleanup: [{ cleanupDeathVerified: false }] },
    { unverifiedProcesses: [{ role: "container" }] },
    { processCleanup: [{ cleanupDeathVerified: true, cleanupError: "unconfirmed" }] },
  ]) assert.equal((await finalizePackagedObservation({ ...evidence, ...partial }, root, true, io)).retainedTempRemovalSafe, false);
});

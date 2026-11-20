import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { afterQueuedCallbacks, deferred } from "./support/deferred.js";
import { cleanupAfterClosing } from "./support/fixture-cleanup.js";
import { cleanupTmpDir } from "./support/tmp-dir-teardown.js";

it("removes fixture directories only after every close settles and surfaces a close error", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-fixture-cleanup-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const failure = new Error("close failed");
  const release = deferred<void>();
  const closeSecond = vi.fn(() => release.promise);
  const removeRepo = vi.fn(() => cleanupTmpDir(repo));
  const cleanup = cleanupAfterClosing(
    [() => { throw failure; }, closeSecond],
    [removeRepo, () => cleanupTmpDir(root)],
  );
  const observed = cleanup.catch(() => undefined);
  try {
    await afterQueuedCallbacks();
    expect(closeSecond).toHaveBeenCalledOnce();
    expect(removeRepo).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(true);

    release.resolve();
    await expect(cleanup).rejects.toBe(failure);
    expect(removeRepo).toHaveBeenCalledOnce();
    expect(existsSync(root)).toBe(false);
  } finally {
    release.resolve();
    await observed;
    await cleanupTmpDir(root);
  }
});

it("surfaces close and cleanup errors after attempting all remaining cleanup", async () => {
  const closeError = new Error("close failed");
  const cleanupError = new Error("repository removal failed");
  const reset = vi.fn();
  const removeRoot = vi.fn();
  const cleanup = cleanupAfterClosing(
    [async () => { throw closeError; }],
    [async () => { throw cleanupError; }, reset, removeRoot],
  );

  await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
  await expect(cleanup).rejects.toMatchObject({ errors: [closeError, cleanupError] });
  expect(reset).toHaveBeenCalledOnce();
  expect(removeRoot).toHaveBeenCalledOnce();
});

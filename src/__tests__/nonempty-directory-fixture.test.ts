import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retainDirectoryFixture } from "./support/nonempty-directory-fixture.js";
import { cleanupTmpDir } from "./support/tmp-dir-teardown.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ave-directory-control-")); });
afterEach(async () => { await cleanupTmpDir(directory); });

describe("shared directory fixture", () => {
  it("survives empty-directory cleanup until every concurrent holder releases it", async () => {
    const empty = join(directory, "empty");
    mkdirSync(empty);
    expect(() => rmdirSync(empty)).not.toThrow();
    const root = join(directory, "shared");
    const releaseFirst = retainDirectoryFixture(root);
    const releaseSecond = retainDirectoryFixture(root);
    expect(() => rmdirSync(root)).toThrow();
    await releaseFirst();
    expect(() => rmdirSync(root)).toThrow();
    await releaseSecond();
    expect(statSync(root).isDirectory()).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes only its own holder and preserves existing contents", async () => {
    mkdirSync(join(directory, "shared"));
    const root = join(directory, "shared");
    const existing = join(root, "existing.txt");
    writeFileSync(existing, "existing-fixture");
    const release = retainDirectoryFixture(root);
    await release();
    expect(readdirSync(root)).toEqual(["existing.txt"]);
    expect(readFileSync(existing, "utf8")).toBe("existing-fixture");
  });
});

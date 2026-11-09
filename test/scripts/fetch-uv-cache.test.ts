import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUvTargetByDir } from "../../scripts/uv-targets.mjs";

let root: string;
let archiveCache: string;
let env: NodeJS.ProcessEnv;
let loader: string;
let expectedCacheFile: string;
const target = getUvTargetByDir("linux-x64");
const content = "runtime fixture bytes";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uv-archive-"));
  archiveCache = join(root, "archive-cache");
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  for (const file of ["fetch-uv.mjs", "uv-targets.mjs", "lib/fetch-with-retry.mjs"]) {
    copyFileSync(resolve("scripts", file), join(root, "scripts", file));
  }
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "uv"), content);
  const archive = join(root, "fixture.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "uv"]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const targets = join(root, "scripts", "uv-targets.mjs");
  // Pin the independent fixture archive in this isolated copy, retaining real verification and extraction.
  const source = readFileSync(targets, "utf8");
  expect(source.split(target.archiveSha256)).toHaveLength(2);
  writeFileSync(targets, source.replace(target.archiveSha256, digest));
  const version = /const DEFAULT_VERSION = "([^"\n]+)"/.exec(readFileSync(join(root, "scripts", "fetch-uv.mjs"), "utf8"))?.[1];
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expectedCacheFile = `${version}-${digest}-${target.archive}`;
  loader = join(root, "fetch-fixture.mjs");
  writeFileSync(loader, `import { appendFileSync, readFileSync } from "node:fs";
globalThis.fetch = async () => {
  appendFileSync(process.env.FIXTURE_FETCH_LOG, "fetch\\n");
  return new Response(readFileSync(process.env.FIXTURE_ARCHIVE));
};\n`);
  env = { ...process.env, AVE_UV_DOWNLOAD_CACHE_DIR: archiveCache, FIXTURE_ARCHIVE: archive,
    FIXTURE_FETCH_LOG: join(root, "fetches") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fetchRuntime = () => spawnSync(process.execPath, ["--import", loader, join(root, "scripts", "fetch-uv.mjs"), "--target", "linux-x64"], { env, encoding: "utf8" });
const binary = () => join(root, "resources", "uv", "linux-x64", "uv");

describe("verified runtime archive reuse", () => {
  it("downloads on a miss, then restores only the archive into a fresh install with no fetch", () => {
    const cold = fetchRuntime();
    expect(cold.status, cold.stderr).toBe(0);
    expect(readFileSync(binary(), "utf8")).toBe(content);
    const saved = readdirSync(archiveCache);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toBe(expectedCacheFile);
    rmSync(join(root, "resources"), { recursive: true });
    rmSync(env.FIXTURE_ARCHIVE!);
    const warm = fetchRuntime();
    expect(warm.status, warm.stderr).toBe(0);
    expect(warm.stdout).toContain("Reused verified archive");
    expect(readFileSync(binary(), "utf8")).toBe(content);
    expect(readFileSync(env.FIXTURE_FETCH_LOG!, "utf8")).toBe("fetch\n");
  });
  it("rejects corrupted cached bytes before extraction", () => {
    expect(fetchRuntime().status).toBe(0);
    rmSync(join(root, "resources"), { recursive: true });
    writeFileSync(join(archiveCache, readdirSync(archiveCache)[0]!), "corrupt");
    const result = fetchRuntime();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("SHA256");
    expect(existsSync(binary())).toBe(false);
    expect(readFileSync(env.FIXTURE_FETCH_LOG!, "utf8")).toBe("fetch\n");
  });
  it("does not save a downloaded archive that fails the pin", () => {
    writeFileSync(env.FIXTURE_ARCHIVE!, "corrupt");
    expect(fetchRuntime().status).not.toBe(0);
    expect(existsSync(archiveCache)).toBe(false);
    expect(existsSync(binary())).toBe(false);
  });
  it("keeps local installs working without an archive cache setting", () => {
    delete env.AVE_UV_DOWNLOAD_CACHE_DIR;
    const result = fetchRuntime();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(binary(), "utf8")).toBe(content);
    expect(existsSync(archiveCache)).toBe(false);
  });
});

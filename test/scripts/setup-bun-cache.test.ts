import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(".github/actions/setup-bun/windows-archive.sh");
const asset = "bun-windows-x64";
const payload = "archive fixture";
const pinned = createHash("sha256").update(payload).digest("hex");
let root: string;
let env: NodeJS.ProcessEnv;
let outputs: string;
let versionFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-archive-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", `${asset}.zip`), payload);
  writeFileSync(join(root, "source", "SHASUMS256.txt"), `${pinned}  ${asset}.zip\n`);
  // This command records fetches and serves fixture bytes; hashing is real.
  const curl = join(root, "bin", "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
set -eu
printf 'fetch\\n' >> "$FIXTURE_ROOT/fetches"
while [ "$1" != --output ]; do shift; done
cp "$FIXTURE_ROOT/source/$(basename "$3")" "$2"
`);
  chmodSync(curl, 0o755);
  versionFile = join(root, "version");
  outputs = join(root, "outputs");
  writeFileSync(versionFile, "1.4.4\n");
  env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FIXTURE_ROOT: root,
    RUNNER_TEMP: root, RUNNER_ARCH: "X64", BUN_VERSION_FILE: versionFile,
    GITHUB_OUTPUT: outputs, VERSION: "1.4.4", ASSET: asset, PINNED: pinned, CACHE_HIT: "false" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = (mode: string) => spawnSync("bash", [script, mode], { env, encoding: "utf8" });

describe("runtime archive cache", () => {
  it.each(["X64", "ARM64"])("keys %s by version, asset and reviewed digest", (arch) => {
    env.RUNNER_ARCH = arch;
    expect(run("metadata").status).toBe(0);
    const written = Object.fromEntries(readFileSync(outputs, "utf8").trim().split("\n").map((s) => s.split("=")));
    expect(written.asset).toBe(arch === "X64" ? asset : "bun-windows-aarch64");
    expect(written.pinned).toMatch(/^[0-9a-f]{64}$/);
    expect(written.key).toBe(`bun-archive-v1-1.4.4-${written.asset}-${written.pinned}`);
  });
  it.each(["1.4.5", "latest", "1.4.4\ninvalid"])("refuses an unpinned version %s", (version) => {
    writeFileSync(versionFile, version);
    expect(run("metadata").status).not.toBe(0);
  });
  it("refuses an unsupported architecture", () => {
    env.RUNNER_ARCH = "unknown";
    expect(run("metadata").status).not.toBe(0);
  });
  it("fetches both files on a miss and rechecks a hit with no fetches", () => {
    const miss = run("verify");
    expect(miss.status, miss.stderr).toBe(0);
    expect(readFileSync(join(root, "fetches"), "utf8")).toBe("fetch\nfetch\n");
    env.CACHE_HIT = "true";
    rmSync(join(root, "source"), { recursive: true });
    const hit = run("verify");
    expect(hit.status, hit.stderr).toBe(0);
    expect(readFileSync(join(root, "fetches"), "utf8")).toBe("fetch\nfetch\n");
  });
  it.each(["false", "true"])("rejects corrupted archive bytes on cache-hit=%s", (hit) => {
    expect(run("verify").status).toBe(0);
    writeFileSync(join(root, hit === "true" ? "bun-download" : "source", `${asset}.zip`), "corrupt");
    env.CACHE_HIT = hit;
    const result = run("verify");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the pinned");
  });
  it.each(["wrong", "missing", "duplicate"])("rejects %s release checksums on a hit", (kind) => {
    expect(run("verify").status).toBe(0);
    const entry = `${pinned}  ${asset}.zip\n`;
    writeFileSync(join(root, "bun-download", "SHASUMS256.txt"), kind === "wrong" ? entry.replace(pinned, "0".repeat(64)) : kind === "missing" ? "" : entry + entry);
    env.CACHE_HIT = "true";
    expect(run("verify").status).not.toBe(0);
  });
  it("fails when a reported hit lacks its archive instead of fetching", () => {
    env.CACHE_HIT = "true";
    expect(run("verify").status).not.toBe(0);
  });
});

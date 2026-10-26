import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { writeFixtureFile as write } from "./gate-script-runner.js";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const REPO_ROOT = process.cwd();
const SCRIPT = resolve(REPO_ROOT, "scripts/check-generated-assets.mjs");
const MANIFEST = "build/generated-assets.json";
const nodeCommand = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const roots: string[] = [];

// Compare controlled fixture bytes instead of relying on a platform-skipped checkout check.
function forcedEnv(home: string): NodeJS.ProcessEnv {
  return { ...gitFixtureEnv(home), AVE_GENERATED_ASSETS_FORCE: "1" };
}

function run(root: string, env: NodeJS.ProcessEnv = forcedEnv(root)) {
  return spawnSync(nodeCommand, [SCRIPT, "--root", root], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env,
  });
}

function git(root: string, args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.email=guard@test.invalid",
      "-c",
      "user.name=guard",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf-8", env: forcedEnv(root) },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

function writeBytes(root: string, rel: string, contents: Buffer): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function commitIco(root: string, rel: string, contents: Buffer): void {
  writeBytes(root, rel, contents);
  git(root, ["add", rel]);
  git(root, ["commit", "--quiet", "-m", "seed image"]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xff_ff_ff_ff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xff_ff_ff_ff) >>> 0;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([header, typed, crc]);
}

/** One 4x4 RGBA scanline block: every row is filter byte 0 then `fill`. */
const PIXELS = Buffer.concat(
  Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0x40)])),
);
const OTHER_PIXELS = Buffer.concat(
  Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0x7f)])),
);

function icoWith(pixels: Buffer, level: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels, { level })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 4;
  entry[1] = 4;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

function writeManifest(root: string, paths: string[]): void {
  write(root, MANIFEST, `${JSON.stringify(paths, null, 2)}\n`);
}

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ave-generated-assets-"));
  roots.push(root);
  git(root, ["init", "--quiet"]);
  write(root, ".gitignore", "build/generated-assets.json\nbuild/icon.png\n");
  write(root, "build/installerIcon.ico", "committed-bytes");
  git(root, ["add", ".gitignore", "build/installerIcon.ico"]);
  git(root, ["commit", "--quiet", "-m", "seed"]);
  writeManifest(root, ["build/icon.png", "build/installerIcon.ico"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Retry transient Windows EPERM cleanup; leftover scratch files must not fail product assertions.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch {
    }
  }
});

describe("check-generated-assets", () => {
  it("passes when the committed asset equals the generator's output", () => {
    const root = createRepo();

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[generated-assets] OK");
  });

  it("fails and names the asset when the generated bytes diverge from the commit", () => {
    const root = createRepo();
    write(root, "build/installerIcon.ico", "regenerated-bytes");

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build/installerIcon.ico");
    expect(result.stderr).toContain("committed bytes differ from generator output");
    expect(result.stderr).toContain("[generated-assets] FAIL — 1 tracked generated asset(s)");
  });

  it("still fails once the divergent bytes are staged", () => {
    const root = createRepo();
    write(root, "build/installerIcon.ico", "regenerated-bytes");
    git(root, ["add", "build/installerIcon.ico"]);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build/installerIcon.ico");
  });

  it("accepts an asset re-encoded by a different deflate, pixels unchanged", () => {
    // Equivalent pixels may have different compressed bytes without making the tree dirty.
    const root = createRepo();
    commitIco(root, "build/installerIcon.ico", icoWith(PIXELS, 9));
    writeBytes(root, "build/installerIcon.ico", icoWith(PIXELS, 1));

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("different deflate encoding; not a divergence");
    expect(result.stdout).toContain("[generated-assets] OK");
  });

  it("still fails when the re-encoded asset draws something else", () => {
    const root = createRepo();
    commitIco(root, "build/installerIcon.ico", icoWith(PIXELS, 9));
    writeBytes(root, "build/installerIcon.ico", icoWith(OTHER_PIXELS, 1));

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("committed bytes differ from generator output");
  });

  it("ignores generated outputs that are not tracked", () => {
    const root = createRepo();
    write(root, "build/icon.png", "anything at all");

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[generated-assets] OK");
  });

  it("fails when the generator has not recorded a manifest", () => {
    const root = createRepo();
    rmSync(join(root, MANIFEST));

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bun run build:icons");
  });

  it("fails when the manifest is not a list of paths", () => {
    const root = createRepo();
    write(root, MANIFEST, `${JSON.stringify({ "build/icon.png": true })}\n`);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a list of paths");
  });

  it("reports on --root even when git names another repository in the environment", () => {
    // GIT_DIR overrides -C; isolate it to prove the fixture repository is checked.
    const root = createRepo();
    // Resolve worktree gitdir pointers without treating them as directories.
    const gitDir = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf-8",
      env: forcedEnv(root),
    }).stdout.trim();
    expect(gitDir).not.toBe("");

    // Force comparison rather than accepting a platform skip.
    const result = run(root, {
      ...process.env,
      GIT_DIR: gitDir,
      AVE_GENERATED_ASSETS_FORCE: "1",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[generated-assets] OK");
  });

  it("fails where there is no committed state to compare against", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-generated-assets-bare-"));
    roots.push(root);
    writeManifest(root, ["build/installerIcon.ico"]);

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot verify the Git work tree");
  });
});

function reencodePng(png: Buffer, level: number): Buffer {
  const chunks: Buffer[] = [png.subarray(0, 8)];
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat.push(body);
    else {
      if (type === "IEND" && idat.length > 0) chunks.push(pngChunk("IDAT", deflateSync(inflateSync(Buffer.concat(idat)), { level })));
      chunks.push(pngChunk(type, body));
    }
    offset += 12 + length;
  }
  return Buffer.concat(chunks);
}

describe("generate-ave-icons", () => {
  // Run the generator under a scratch root to avoid repository writes.
  function generatorRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ave-generate-icons-"));
    roots.push(root);
    for (const rel of ["scripts/generate-ave-icons.cjs", "scripts/lib/normalized-image.cjs", "src/shared/ave-logo.ts"]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(join(REPO_ROOT, rel), join(root, rel));
    }
    return root;
  }

  function generate(root: string): void {
    const result = spawnSync(nodeCommand, [join(root, "scripts/generate-ave-icons.cjs")], { cwd: root, encoding: "utf-8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }

  it("keeps an image whose bytes differ from its output only by deflate encoding", () => {
    // Pixel-identical outputs must leave the hook clean.
    const root = generatorRoot();
    generate(root);
    const icon = join(root, "build/icon.png");
    const generated = readFileSync(icon);
    const reencoded = reencodePng(generated, 1);
    expect(reencoded.equals(generated)).toBe(false);
    writeFileSync(icon, reencoded);

    generate(root);

    expect(readFileSync(icon).equals(reencoded)).toBe(true);
  }, 60_000);

  it("rewrites an image that draws something else", () => {
    const root = generatorRoot();
    generate(root);
    const icon = join(root, "build/icon.png");
    const generated = readFileSync(icon);
    writeFileSync(icon, icoWith(OTHER_PIXELS, 9).subarray(22));

    generate(root);

    expect(readFileSync(icon).equals(generated)).toBe(true);
  }, 60_000);
});

describe("generated-asset manifest", () => {
  it("records every asset the generator wrote", () => {
    const manifest: string[] = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST), "utf-8"));

    expect(manifest.length).toBeGreaterThan(0);
    for (const rel of manifest) {
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} is listed but was not written`).toBe(true);
    }
  });

  it("covers the tracked branding assets the installer reads from the tree", () => {
    const manifest: string[] = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST), "utf-8"));

    // The manifest must cover every tracked generated output.
    expect(manifest).toContain("build/installerIcon.ico");
    expect(manifest).toContain("build/installerHeaderIcon.ico");
    expect(manifest).toContain("build/icon.svg");
  });

  it("runs the guard in the build, after the generator that feeds it", () => {
    // Verify the guard is called by the build.
    const build: string = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
    ).scripts.build;

    const generate = build.indexOf("bun run build:icons");
    const check = build.indexOf("node scripts/check-generated-assets.mjs");

    expect(generate).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(generate);
  });

  it("leaves the repository's own tracked assets matching the generator", () => {
    // Check the real checkout without forcing the platform-specific comparison.
    const result = run(REPO_ROOT, gitFixtureEnv(REPO_ROOT));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UV_TARGETS } from "../../scripts/uv-targets.mjs";

describe("bundled runtime release pins", () => {
  it("uses the intended release tag for downloads", () => {
    const source = readFileSync(new URL("../../scripts/fetch-uv.mjs", import.meta.url), "utf8");
    expect(source).toContain('const DEFAULT_VERSION = "0.13.9";');
  });

  it.each([
    ["uv-aarch64-apple-darwin.tar.gz", "5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca"],
    ["uv-x86_64-pc-windows-msvc.zip", "edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb"],
    ["uv-x86_64-unknown-linux-gnu.tar.gz", "a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5"],
    ["uv-aarch64-unknown-linux-gnu.tar.gz", "0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d"],
  ])("pins the release archive digest for %s", (archive, digest) => {
    expect(UV_TARGETS.find((target) => target.archive === archive)?.archiveSha256).toBe(digest);
  });
});

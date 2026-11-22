import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
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

  it("verifies all pinned archives in the CI build job", () => {
    const ci = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const steps: Array<{ run?: string }> = ci.jobs.build.steps;
    expect(steps.some((step) => step.run === "node scripts/fetch-uv.mjs --verify-attestation")).toBe(true);
  });

  it("checks the attestation of each pinned target archive", async () => {
    const { verifyPinnedAttestations } = await import("../../scripts/lib/uv-archive-attestation.mjs");
    const loadArchive = vi.fn(async (target: (typeof UV_TARGETS)[number]) => Buffer.from(target.archive));
    const run = vi.fn((_file: string, args: string[]) => {
      const archivePath = args[2];
      expect(readFileSync(archivePath, "utf8")).toBe(basename(archivePath));
      return { status: 0 };
    });

    await verifyPinnedAttestations({ loadArchive, run });
    expect(loadArchive.mock.calls.map(([target]) => target)).toEqual(UV_TARGETS);
    expect(run.mock.calls.map(([file, args]) => [file, ...args.slice(0, 2), basename(args[2]), ...args.slice(3)]))
      .toEqual(UV_TARGETS.map((target) => ["gh", "attestation", "verify", target.archive, "--repo", "astral-sh/uv"]));
  });

  it.each([
    [{ status: 2 }, "Attestation verification failed"],
    [{ status: null, error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }) }, "gh CLI is required"],
  ])("reports a clear attestation error for %j", async (result, message) => {
    const { verifyPinnedAttestations } = await import("../../scripts/lib/uv-archive-attestation.mjs");
    const run = vi.fn(() => result);
    const loadArchive = vi.fn(async () => Buffer.from("archive"));
    await expect(verifyPinnedAttestations({ loadArchive, run })).rejects.toThrow(message);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

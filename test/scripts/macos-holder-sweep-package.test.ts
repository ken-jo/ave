// Packaging keeps the helper the main bundle pins: before-pack, after-pack and after-sign each refuse a different copy.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { machoImageDigest } from "../../scripts/lib/macho-image-digest.mjs";
import {
  assertPackagedMacosHolderSweep, assertSignedMacosHolderSweep, macosHolderSweepBundlePinDeclaration, packagedMacosHolderSweep,
  recordMacosHolderSweepPackageBuild,
} from "../../scripts/lib/macos-holder-sweep-package.mjs";
import { machoFixture } from "./fixtures/macho-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function packageFixture(pin: string) {
  const root = mkdtempSync(join(tmpdir(), "ave-holder-sweep-package-"));
  roots.push(root);
  const bundleDir = join(root, "dist", "src", "main");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "main.js"), `${macosHolderSweepBundlePinDeclaration(pin)}\nimport "x";\n`);
  const appOutDir = join(root, "out");
  const resources = join(appOutDir, "Ave.app", "Contents", "Resources");
  const helper = packagedMacosHolderSweep(resources, "arm64");
  mkdirSync(dirname(helper), { recursive: true });
  return { root, bundleDir, appOutDir, resources, helper };
}

const bytes = machoFixture();
const build = { binarySha256: createHash("sha256").update(bytes).digest("hex"), imageSha256: machoImageDigest(bytes) };

function codesign(team: string | undefined, runtime: boolean, verifies = true) {
  return ((_: string, args: readonly string[]) => args[0] === "--verify"
    ? { status: verifies ? 0 : 1 }
    : { status: 0, stdout: "", stderr: `CodeDirectory v=20500 size=1 flags=0x${runtime ? "10000(runtime" : "2(adhoc"})\nTeamIdentifier=${team ?? "not set"}\n` }) as never;
}

describe("macOS holder helper packaging", () => {
  it("refuses a before-pack build the main bundle does not pin", () => {
    const fixture = packageFixture("0".repeat(64));
    expect(() => recordMacosHolderSweepPackageBuild({ appOutDir: fixture.appOutDir, arch: "arm64", build, bundleDir: fixture.bundleDir }))
      .toThrow("does not pin");
  });

  it("requires the packaged copy byte for byte, ships the notices, and accepts a signature that keeps the image", () => {
    const fixture = packageFixture(build.imageSha256);
    recordMacosHolderSweepPackageBuild({ appOutDir: fixture.appOutDir, arch: "arm64", build, bundleDir: fixture.bundleDir });
    writeFileSync(fixture.helper, machoFixture({ code: Buffer.from("another-image-0123456789abc") }));
    expect(() => assertPackagedMacosHolderSweep(fixture.appOutDir, fixture.resources, "arm64")).toThrow("not the before-pack build");
    writeFileSync(fixture.helper, bytes);
    assertPackagedMacosHolderSweep(fixture.appOutDir, fixture.resources, "arm64");
    expect(readFileSync(join(fixture.resources, "licenses", "macos-holder-sweep", "README.txt"), "utf8")).toContain("Rust standard library");
    writeFileSync(fixture.helper, machoFixture({ signature: Buffer.alloc(300, 1) }));
    const app = join(fixture.appOutDir, "Ave.app");
    expect(() => assertSignedMacosHolderSweep(fixture.appOutDir, fixture.resources, app, "arm64", codesign(undefined, false))).not.toThrow();
    expect(() => assertSignedMacosHolderSweep(fixture.appOutDir, fixture.resources, app, "arm64", codesign(undefined, false, false))).toThrow("--verify");
    expect(() => assertSignedMacosHolderSweep(fixture.appOutDir, fixture.resources, app, "arm64", codesign("TEAM123456", false))).toThrow("hardened runtime");
    expect(() => assertSignedMacosHolderSweep(fixture.appOutDir, fixture.resources, app, "arm64", codesign("TEAM123456", true))).not.toThrow();
    writeFileSync(fixture.helper, machoFixture({ code: Buffer.from("signed-other-image-00000000") }));
    expect(() => assertSignedMacosHolderSweep(fixture.appOutDir, fixture.resources, app, "arm64", codesign(undefined, false))).toThrow("not the before-pack build");
  });
});

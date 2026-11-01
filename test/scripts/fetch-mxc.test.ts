import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };

// @ts-expect-error — plain .mjs build script without declarations
import { currentMxcArch, stageMxcLauncher, stageMxcSdkAddon } from "../../scripts/fetch-mxc.mjs";

const roots: string[] = [];
function projectRoot(license: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), "fetch-mxc-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "resources", "licenses", "mxc"), { recursive: true });
  const target = path.join(root, "resources", "licenses", "mxc", "LICENSE.md");
  if (license === null) cpSync(path.resolve("resources/licenses/mxc/LICENSE.md"), target);
  else writeFileSync(target, license);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fetch-mxc staging fails the Windows build instead of shipping an unverified launcher", () => {
  it("rejects a tarball whose sha512 is not the pinned integrity", async () => {
    const root = projectRoot(null);
    const tarball = path.join(root, "mxc.tgz");
    writeFileSync(tarball, "not the published tarball");
    await expect(stageMxcLauncher({ arch: "x64", tarball, projectRoot: root })).rejects.toThrow(/integrity mismatch/);
  });

  it("rejects a committed license that differs from the package's MIT text", async () => {
    const root = projectRoot("edited");
    await expect(stageMxcLauncher({ arch: "x64", tarball: path.join(root, "unused.tgz"), projectRoot: root }))
      .rejects.toThrow(/differs from the MIT license/);
  });
});

describe("fetch-mxc --current", () => {
  it("stages only on Windows, for a pinned host arch", () => {
    expect(currentMxcArch("win32", "x64")).toBe("x64");
    expect(currentMxcArch("win32", "arm64")).toBe("arm64");
    expect(currentMxcArch("darwin", "arm64")).toBeNull();
    expect(currentMxcArch("linux", "x64")).toBeNull();
    expect(() => currentMxcArch("win32", "ia32")).toThrow(/no pinned launcher for win32-ia32/);
  });
});


describe("target SDK addon staging", () => {
  it.each(["x64", "arm64"])("rejects an unpinned %s archive before extraction", async (arch) => {
    const root = projectRoot(null), tarball = path.join(root, "addon.tgz");
    writeFileSync(tarball, "not the published addon");
    await expect(stageMxcSdkAddon({ arch, tarball, projectRoot: root })).rejects.toThrow(/integrity mismatch/);
  });

  it("refuses an existing altered target instead of repairing it silently", async () => {
    const root = projectRoot(null);
    const target = path.join(root, "node_modules/@koromix/koffi-win32-x64");
    for (const relative of Object.keys(PINS.sdk.architectures.x64).filter((file) => file.startsWith("@koromix/koffi-win32-x64/"))) {
      const file = path.join(root, "node_modules", relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "tampered");
    }
    await expect(stageMxcSdkAddon({ arch: "x64", projectRoot: root })).rejects.toThrow(/hash mismatch/);
    expect(readFileSync(path.join(target, "package.json"), "utf8")).toBe("tampered");
  });
});

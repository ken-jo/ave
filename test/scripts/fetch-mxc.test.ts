import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, statSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };

// @ts-expect-error — plain .mjs build script without declarations
import { currentMxcTarget, stageMxcLauncher, stageMxcSdkAddon } from "../../scripts/fetch-mxc.mjs";

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
    await expect(stageMxcLauncher({ target: "win32-x64", tarball, projectRoot: root })).rejects.toThrow(/integrity mismatch/);
  });

  it("rejects a committed license that differs from the package's MIT text", async () => {
    const root = projectRoot("edited");
    await expect(stageMxcLauncher({ target: "win32-x64", tarball: path.join(root, "unused.tgz"), projectRoot: root }))
      .rejects.toThrow(/differs from the MIT license/);
  });
});

describe("fetch-mxc --current", () => {
  it("resolves the installed host to a supported target", () => {
    expect(currentMxcTarget("win32", "x64")).toBe("win32-x64");
    expect(currentMxcTarget("win32", "arm64")).toBe("win32-arm64");
    expect(currentMxcTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentMxcTarget("darwin", "x64")).toBeNull();
    expect(currentMxcTarget("linux", "x64")).toBe("linux-x64");
    expect(currentMxcTarget("linux", "arm64")).toBe("linux-arm64");
    expect(currentMxcTarget("freebsd", "arm64")).toBeNull();
    expect(() => currentMxcTarget("win32", "ia32")).toThrow(/no pinned launcher for win32-ia32/);
    expect(() => currentMxcTarget("linux", "arm")).toThrow(/no pinned launcher for linux-arm/);
  });

  it.each(Object.entries(PINS.targets))("stages the pinned %s member from the installed SDK", async (target, { launcher }) => {
    const root = projectRoot(null);
    const installed = path.join("node_modules", PINS.package, launcher.member);
    const source = path.join(root, installed);
    mkdirSync(path.dirname(source), { recursive: true });
    cpSync(installed, source);
    const [, arch] = target.split("-");
    const staged = path.join(root, "resources", "mxc", arch, path.basename(launcher.member));
    expect(await stageMxcLauncher({ target, projectRoot: root })).toBe(staged);
    expect(readFileSync(staged)).toEqual(readFileSync(installed));
    if (process.platform !== "win32" && !target.startsWith("win32-")) expect(statSync(staged).mode & 0o777).toBe(0o755);
    writeFileSync(source, "tampered");
    expect(await stageMxcLauncher({ target, projectRoot: root })).toBe(staged);
    writeFileSync(staged, "stale");
    await expect(stageMxcLauncher({ target, projectRoot: root })).rejects.toThrow(/sha256 mismatch/);
  });
});

describe("launcher archive staging", () => {
  it("stages every target from its exact pinned archive member", () => {
    const root = projectRoot(null);
    const launcherTargets = Object.entries(PINS.targets).map(([target, { launcher }]) => {
      const member = path.join(root, "package", launcher.member);
      mkdirSync(path.dirname(member), { recursive: true });
      writeFileSync(member, target);
      const sha256 = createHash("sha256").update(target).digest("hex");
      return [target, { launcher: { ...launcher, sha256 } }] as const;
    });
    const tarball = path.join(root, "sdk.tgz");
    execFileSync("tar", ["-czf", tarball, "package"], { cwd: root });
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(root, "src", "permissions"), { recursive: true });
    cpSync("scripts/fetch-mxc.mjs", path.join(root, "scripts", "fetch-mxc.mjs"));
    cpSync("scripts/lib/fetch-with-retry.mjs", path.join(root, "scripts", "lib", "fetch-with-retry.mjs"));
    const archiveSha512 = createHash("sha512").update(readFileSync(tarball)).digest("base64");
    writeFileSync(path.join(root, "src", "permissions", "mxc-launcher-pins.json"), JSON.stringify({
      ...PINS, tarballSha512Base64: archiveSha512, targets: Object.fromEntries(launcherTargets),
    }));
    for (const [target, { launcher }] of launcherTargets) {
      execFileSync(process.execPath, ["scripts/fetch-mxc.mjs", "--target", target, "--tarball", tarball], { cwd: root });
      const arch = path.basename(path.dirname(launcher.member));
      const staged = path.join(root, "resources", "mxc", arch, path.basename(launcher.member));
      expect(readFileSync(staged, "utf8")).toBe(target);
      if (process.platform !== "win32" && !target.startsWith("win32-")) expect(statSync(staged).mode & 0o777).toBe(0o755);
    }
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

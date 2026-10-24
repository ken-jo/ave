import { canCreateSymlinks } from "../../src/__tests__/support/symlink-capability.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtureModes = vi.hoisted(() => new Map<string, number>());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: string) => {
      const stats = actual.lstatSync(path);
      const mode = fixtureModes.get(path);
      // The extracted fixtures carry Linux modes even on a host without them.
      if (process.platform === "win32" && mode !== undefined) stats.mode = (Number(stats.mode) & ~0o777) | mode;
      return stats;
    },
  };
});
import {
  appImagePayloadOffset,
  auditLinuxRelease,
  auditTree,
  crossNodeGypRebuildArgs,
  parseElfHeader,
} from "../../scripts/lib/linux-package-arch.mjs";

const repoRoot = resolve(__dirname, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const EM = { x64: 62, arm64: 183 } as const;

/**
 * The audit labels each file by its host-relative path, which Windows spells
 * with `\`; the expectations below use the posix spelling of the Linux job.
 */
function posix(text: string): string {
  return text.split(sep).join("/");
}

/** A 64-byte ELF64 LE header: enough for the parser and for file(1). */
function elf(machine: number, type = 3): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  header.writeUInt16LE(type, 16);
  header.writeUInt16LE(machine, 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  return header;
}

const MACHO_ARM64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, ...Buffer.alloc(56)]);

/** file(1) stand-in that answers from the header the same way the real one does. */
function fakeFile(path: string): string {
  const header = parseElfHeader(readFileSync(path));
  if (!header) return "data";
  return header.machine === EM.x64 ? "ELF 64-bit LSB shared object, x86-64" : "ELF 64-bit LSB shared object, ARM aarch64";
}

function write(path: string, content: Buffer | string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
  fixtureModes.set(path, mode);
}

/** A linux-unpacked tree whose every native binary is `arch`. */
function unpackedApp(root: string, arch: keyof typeof EM): string {
  const app = join(root, arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`);
  write(join(app, "ave"), elf(EM[arch], 3), 0o755);
  write(join(app, "chrome_crashpad_handler"), elf(EM[arch], 3), 0o755);
  write(join(app, "libffmpeg.so"), elf(EM[arch], 3), 0o755);
  write(join(app, "resources/app.asar"), "asar");
  const modules = join(app, "resources/app.asar.unpacked/node_modules");
  write(join(modules, "node-pty/build/Release/pty.node"), elf(EM[arch]));
  write(join(modules, `better-sqlite3/prebuilds/linux-${arch}.node`), elf(EM[arch]));
  write(join(modules, `@vscode/ripgrep-linux-${arch}/bin/rg`), elf(EM[arch], 3), 0o755);
  write(join(modules, "node-pty/lib/index.js"), "module.exports = {};");
  write(join(app, `resources/uv/linux-${arch}/uv.gz`), gzipSync(elf(EM[arch], 2)));
  return app;
}

/**
 * The tree packed in fixtures/linux-appimage-payload.squashfs: an x64 app
 * whose node-pty addon is arm64. Rebuild it with
 * `mksquashfs <tree> linux-appimage-payload.squashfs -noappend -no-xattrs -all-root -mkfs-time 0 -all-time 0`.
 */
function appImagePayloadTree(root: string): void {
  write(join(root, "ave"), elf(EM.x64, 2), 0o755);
  write(join(root, "resources/app.asar"), "asar");
  write(join(root, "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node"), elf(EM.arm64));
  write(join(root, "resources/uv/linux-x64/uv.gz"), gzipSync(elf(EM.x64, 2)));
}

const APPIMAGE_PAYLOAD = readFileSync(join(__dirname, "fixtures/linux-appimage-payload.squashfs"));

/** A type-2 AppImage: runtime ELF whose section headers end at 128, then the squashfs. */
function appImage(machine: number, payload: Buffer = APPIMAGE_PAYLOAD): Buffer {
  const runtime = Buffer.alloc(128);
  elf(machine, 2).copy(runtime);
  runtime.writeBigUInt64LE(64n, 0x28); // e_shoff
  runtime.writeUInt16LE(64, 0x3a); // e_shentsize
  runtime.writeUInt16LE(1, 0x3c); // e_shnum
  return Buffer.concat([runtime, payload]);
}

/** exec stand-in: answers the deb/rpm metadata and "extracts" the AppImage payload tree. */
function installerExec(calls: string[][], unsquash: (args: string[]) => void = (args) => appImagePayloadTree(args[args.indexOf("-d") + 1])) {
  return ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "unsquashfs") { unsquash(args); return ""; }
    if (command === "dpkg-deb" && args[0] === "-f") return "amd64\n";
    if (command === "rpm") return "x86_64";
    return "";
  }) as unknown as typeof execFileSync;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "linux-arch-")); roots.push(root);
  return root;
}

describe("Linux package architecture audit", () => {
  it("reads the ELF class, byte order and machine", () => {
    expect(parseElfHeader(elf(EM.x64))).toEqual({ valid: true, elfClass: 64, littleEndian: true, machine: 62 });
    expect(parseElfHeader(elf(EM.arm64))?.machine).toBe(183);
    expect(parseElfHeader(MACHO_ARM64)).toBeNull();
    expect(parseElfHeader(Buffer.from("#!/bin/sh\n"))).toBeNull();
  });

  it("passes a tree whose every native binary is x64", () => {
    const root = tempRoot();
    unpackedApp(root, "x64");
    const { violations, checked } = auditLinuxRelease(root, "x64", { fileCommand: fakeFile });
    expect(violations.map(posix)).toEqual([]);
    // main binary, crashpad, libffmpeg, two addons, rg, and the inflated uv
    expect(checked).toHaveLength(7);
  });

  it("fails an arm64 native addon inside an x64 package", () => {
    const root = tempRoot();
    const app = unpackedApp(root, "x64");
    write(join(app, "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node"), elf(EM.arm64));
    const text = posix(auditLinuxRelease(root, "x64", { fileCommand: fakeFile }).violations.join("\n"));
    expect(text).toContain("node-pty/build/Release/pty.node: ELF is aarch64 (64-bit LE), expected x64");
    expect(text).toContain("pty.node: file(1) does not report x64");
  });

  it("fails an arm64 helper executable, an arm64 main binary and a non-ELF addon", () => {
    const root = tempRoot();
    const app = unpackedApp(root, "x64");
    write(join(app, "ave"), elf(EM.arm64), 0o755);
    write(join(app, "resources/app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp"), elf(EM.arm64, 2), 0o755);
    write(join(app, "resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"), MACHO_ARM64);
    const text = posix(auditLinuxRelease(root, "x64", { fileCommand: fakeFile }).violations.join("\n"));
    expect(text).toContain("linux-unpacked/ave: ELF is aarch64");
    expect(text).toContain("seccomp/arm64/apply-seccomp: ELF is aarch64");
    expect(text).toContain("prebuilds/darwin-arm64/pty.node: native addon is not a Linux ELF shared object");
  });

  it("inflates the bundled uv and fails a host-arch copy", () => {
    const root = tempRoot();
    const app = unpackedApp(root, "x64");
    write(join(app, "resources/uv/linux-x64/uv.gz"), gzipSync(elf(EM.arm64, 2)));
    const text = auditLinuxRelease(root, "x64", { fileCommand: fakeFile }).violations.join("\n");
    expect(text).toContain("uv.gz (inflated): ELF is aarch64");
  });

  it("fails the wrong uv target directory, a missing app root, no addons and stray unpacked output", () => {
    const root = tempRoot();
    const app = unpackedApp(root, "x64");
    rmSync(join(app, "resources/uv/linux-x64"), { recursive: true });
    write(join(app, "resources/uv/linux-arm64/uv.gz"), gzipSync(elf(EM.x64, 2)));
    mkdirSync(join(root, "linux-arm64-unpacked"));
    const stray = posix(auditLinuxRelease(root, "x64", { fileCommand: fakeFile }).violations.join("\n"));
    expect(stray).toContain("linux-arm64/uv.gz: uv runtime directory is not linux-x64");
    expect(stray).toContain("unexpected unpacked output for another arch: linux-arm64-unpacked");

    const bare = tempRoot();
    write(join(bare, "linux-unpacked/README"), "nothing native");
    const text = auditLinuxRelease(bare, "x64", { fileCommand: fakeFile }).violations.join("\n");
    expect(text).toContain("expected exactly one app root holding resources/app.asar, found 0");
    expect(text).toContain("no packaged .node native addon found");
  });

  it("requires an executable ELF main binary at the app root", () => {
    const root = tempRoot();
    const app = unpackedApp(root, "x64");
    for (const name of ["ave", "chrome_crashpad_handler"]) rmSync(join(app, name));
    expect(auditTree(app, "x64", { fileCommand: fakeFile }).violations.join("\n"))
      .toContain("no executable ELF main binary at the app root");
  });

  it.skipIf(!canCreateSymlinks())("never follows a symlink out of the tree", () => {
    const root = tempRoot();
    const app = unpackedApp(root, "x64");
    const outside = tempRoot();
    write(join(outside, "python3"), elf(EM.arm64, 2), 0o755);
    const before = auditLinuxRelease(root, "x64", { fileCommand: fakeFile });
    symlinkSync(join(outside, "python3"), join(app, "resources/app.asar.unpacked/node_modules/node-pty/python3"));
    const after = auditLinuxRelease(root, "x64", { fileCommand: fakeFile });
    expect(after).toEqual(before);
    expect(after.violations.map(posix)).toEqual([]);
  });

  it("checks the installers' declared arch and requires one of each", () => {
    const root = tempRoot();
    unpackedApp(root, "x64");
    write(join(root, "Ave-1.0.0-linux-x86_64.AppImage"), elf(EM.arm64, 2), 0o755);
    const calls: string[] = [];
    const exec = ((command: string, args: string[]) => {
      calls.push(`${command} ${args.join(" ")}`);
      return "";
    }) as unknown as typeof execFileSync;
    const text = auditLinuxRelease(root, "x64", { requireInstallers: true, fileCommand: fakeFile, exec }).violations.join("\n");
    expect(text).toContain("AppImage runtime is aarch64");
    expect(text).toContain("Ave-1.0.0-linux-x86_64.AppImage: no squashfs payload at the end of the runtime ELF (offset 0)");
    expect(text).toContain("expected exactly one deb installer, found 0");
    expect(text).toContain("expected exactly one rpm installer, found 0");
    expect(calls).toEqual([]);
  });

  it("finds the squashfs payload at the end of the AppImage runtime's section headers", () => {
    const image = appImage(EM.x64);
    const offset = appImagePayloadOffset(image.subarray(0, 64));
    expect(offset).toBe(128);
    expect(image.subarray(offset!, offset! + 4).toString("latin1")).toBe("hsqs");
    expect(appImagePayloadOffset(MACHO_ARM64)).toBeNull();
  });

  it("extracts the AppImage payload under RUNNER_TEMP and fails a foreign-arch ELF inside it", () => {
    const root = tempRoot();
    unpackedApp(root, "x64");
    const name = "Ave-1.0.0-linux-x86_64.AppImage";
    write(join(root, name), appImage(EM.x64), 0o755);
    write(join(root, "ave_1.0.0_amd64.deb"), "deb");
    write(join(root, "ave-1.0.0.x86_64.rpm"), "rpm");
    const runnerTemp = tempRoot();
    const previous = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = runnerTemp;
    const calls: string[][] = [];
    let text: string;
    try {
      text = auditLinuxRelease(root, "x64", { requireInstallers: true, fileCommand: fakeFile, exec: installerExec(calls) }).violations.join("\n");
    } finally {
      if (previous === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previous;
    }
    const unsquash = calls.find(([command]) => command === "unsquashfs");
    expect(unsquash).toBeDefined();
    const dest = unsquash![unsquash!.indexOf("-d") + 1];
    expect(unsquash).toEqual(["unsquashfs", "-no-progress", "-no-xattrs", "-o", "128", "-d", dest, join(root, name)]);
    expect(dest.startsWith(join(runnerTemp, "ave-installer-audit-"))).toBe(true);
    expect(existsSync(dirname(dest))).toBe(false);
    expect(posix(text)).toContain(`${name}/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node: ELF is aarch64 (64-bit LE), expected x64`);
    expect(text).not.toContain("AppImage runtime is");
  });

  it("fails clearly when unsquashfs is missing instead of skipping the AppImage payload", () => {
    const root = tempRoot();
    unpackedApp(root, "x64");
    write(join(root, "Ave-1.0.0-linux-x86_64.AppImage"), appImage(EM.x64), 0o755);
    const exec = installerExec([], () => { throw Object.assign(new Error("spawnSync unsquashfs ENOENT"), { code: "ENOENT" }); });
    expect(() => auditLinuxRelease(root, "x64", { requireInstallers: true, fileCommand: fakeFile, exec }))
      .toThrow("unsquashfs not found on PATH: auditing the AppImage payload of Ave-1.0.0-linux-x86_64.AppImage needs squashfs-tools");
  });

  it("keeps the cross node-gyp header cache under the workspace", () => {
    expect(crossNodeGypRebuildArgs("/ws/node_modules/node-gyp/bin/node-gyp.js", "x64", "/ws"))
      .toEqual(["/ws/node_modules/node-gyp/bin/node-gyp.js", "rebuild", "--arch=x64", `--devdir=${join("/ws", ".cache", "node-gyp")}`]);
  });

  it("agrees with the real file(1) on both architectures", () => {
    const root = tempRoot();
    write(join(root, "x64.node"), elf(EM.x64));
    write(join(root, "arm64.node"), elf(EM.arm64));
    const real = (path: string) => execFileSync("file", ["-b", path], { encoding: "utf8" }).trim();
    expect(real(join(root, "x64.node"))).toMatch(/\bx86-64\b/u);
    expect(real(join(root, "arm64.node"))).toMatch(/\bARM aarch64\b/u);
  });

  it("exits non-zero from the CLI on a mixed-arch package", () => {
    const root = tempRoot();
    const app = unpackedApp(root, "x64");
    write(join(app, "resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node"), elf(EM.arm64));
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, ["scripts/verify-linux-package-arch.mjs", "--release-dir", root, "--arch", "x64"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: string }).stderr);
    }
    expect(status).toBe(1);
    expect(posix(stderr)).toContain("better-sqlite3/prebuilds/linux-x64.node: ELF is aarch64");
    expect(stderr).toContain("the package is not pure x64");
  });
});

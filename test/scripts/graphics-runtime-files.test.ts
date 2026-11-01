import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { writeImageRuntimePackage } from "../../src/__tests__/support/image-runtime-package.js";
import { writeCanvasRuntimePackage, writePageRuntimeResources } from "../../src/__tests__/support/page-runtime-package.js";

const require = createRequire(import.meta.url);
const afterPack = require("../../scripts/electron-after-pack.cjs") as (
  context: Awaited<ReturnType<typeof createPackage>>["context"],
) => Promise<void>;
const { assertGraphicsRuntimeFiles } = require("../../scripts/lib/graphics-runtime-files.cjs") as {
  assertGraphicsRuntimeFiles(directory: string, platform: string): void;
};

const roots: string[] = [];
const RUNTIME_FILES = {
  linux: ["libvk_swiftshader.so", "libvulkan.so.1", "vk_swiftshader_icd.json"],
  darwin: ["libvk_swiftshader.dylib", "vk_swiftshader_icd.json"],
  win32: ["vk_swiftshader.dll", "vulkan-1.dll", "vk_swiftshader_icd.json", "dxcompiler.dll"],
};

function putFile(path: string, content: string | Buffer = "runtime asset") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function createPackage(platform: keyof typeof RUNTIME_FILES) {
  const root = mkdtempSync(join(tmpdir(), "graphics-package-"));
  roots.push(root);
  const contents = platform === "darwin" ? join(root, "Client.app", "Contents") : root;
  const resources = join(contents, platform === "darwin" ? "Resources" : "resources");
  const libraryDirectory = platform === "darwin"
    ? join(contents, "Frameworks", "Electron Framework.framework", "Versions", "A", "Libraries")
    : root;
  const modules = join(resources, "app.asar.unpacked", "node_modules");
  if (platform !== "win32") {
    putFile(join(modules, "@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar"));
  }
  const uv = Buffer.from("executable");
  const uvName = platform === "win32" ? "uv.exe" : "uv";
  putFile(join(resources, "uv", `${platform}-x64`, `${uvName}.gz`), gzipSync(uv));
  putFile(join(resources, "uv", `${platform}-x64`, "uv.meta.json"), JSON.stringify({
    binarySha256: createHash("sha256").update(uv).digest("hex"),
  }));
  putFile(join(resources, "licenses", "uv", "LICENSE-MIT"));
  if (platform !== "darwin") {
    const vendorPath = join(modules, "@anthropic-ai", "sandbox-runtime", "vendor",
      platform === "linux" ? "seccomp" : "srt-win", "x64",
      platform === "linux" ? "apply-seccomp" : "srt-win.exe");
    putFile(vendorPath);
    if (platform === "win32") {
      const runtimeRoot = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));
      putFile(vendorPath, readFileSync(join(runtimeRoot, "vendor", "srt-win", "x64", "srt-win.exe")));
    }
    chmodSync(vendorPath, 0o755);
  }
  for (const file of platform === "win32"
    ? ["pty.node", "conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe"]
    : platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"]) {
    putFile(join(modules, "node-pty", "prebuilds", `${platform}-x64`, file));
  }
  putFile(join(modules, "better-sqlite3", "prebuilds", `${platform}-x64.node`));
  writeImageRuntimePackage(modules, platform);
  writeCanvasRuntimePackage(modules, platform);
  writePageRuntimeResources(resources);
  const ripgrep = join(modules, "@vscode", `ripgrep-${platform}-x64`);
  putFile(join(ripgrep, "package.json"), JSON.stringify({ name: `@vscode/ripgrep-${platform}-x64` }));
  putFile(join(ripgrep, "bin", platform === "win32" ? "rg.exe" : "rg"));
  chmodSync(join(ripgrep, "bin", platform === "win32" ? "rg.exe" : "rg"), 0o755);
  for (const notice of ["README.txt", "COPYING", "LICENSE-MIT", "UNLICENSE", "PCRE2-LICENCE.txt", "VSCODE-RIPGREP-LICENSE"]) {
    putFile(join(resources, "licenses", "ripgrep", notice));
  }
  for (const file of RUNTIME_FILES[platform]) putFile(join(libraryDirectory, file), file);
  return {
    libraryDirectory,
    resources,
    modules,
    vendorDirectory: join(modules, "@anthropic-ai", "sandbox-runtime", "vendor"),
    context: {
      appOutDir: root,
      electronPlatformName: platform,
      arch: 1,
      packager: { appInfo: { productFilename: "Client" } },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged graphics runtime", () => {
  it("requires upstream archive verification when the locked runtime version changes", () => {
    const lock = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");
    const version = lock.match(/^\s*"electron": \["electron@([^"]+)"/m)?.[1];
    expect(version,
      "Re-verify graphics runtime files against the locked electron upstream release zips for every platform, then update the version guard and fixtures.",
    ).toBe("45.2.1");
  });

  it.each(["linux", "darwin", "win32"] as const)("retains rendering assets through %s packaging", async (platform) => {
    const { context, libraryDirectory } = await createPackage(platform);
    await afterPack(context);
    for (const file of RUNTIME_FILES[platform]) {
      expect(readFileSync(join(libraryDirectory, file), "utf8")).toBe(file);
    }
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, platform)).not.toThrow();
  });

  it.each(
    (["linux", "darwin", "win32"] as const).flatMap((platform) =>
      RUNTIME_FILES[platform].map((file) => ({ platform, file }))),
  )("rejects missing $platform/$file at package creation", async ({ platform, file }) => {
    const { context, libraryDirectory } = await createPackage(platform);
    const missing = join(libraryDirectory, file);
    rmSync(missing);
    await expect(afterPack(context)).rejects.toThrow(missing);
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, platform)).toThrow(missing);
  });

  it.each(["linux", "darwin"] as const)("requires the physical %s JVM proxy agent", async (platform) => {
    const { context, vendorDirectory } = await createPackage(platform);
    const jar = join(vendorDirectory, "java-proxy-agent", "srt-proxy-agent.jar");
    rmSync(jar);
    await expect(afterPack(context)).rejects.toThrow("packaged JVM proxy agent missing or invalid");
    putFile(jar, "");
    await expect(afterPack(context)).rejects.toThrow("packaged JVM proxy agent missing or invalid");
    rmSync(jar);
    mkdirSync(jar);
    await expect(afterPack(context)).rejects.toThrow("packaged JVM proxy agent missing or invalid");
  });

  it("rejects a mismatching win32 sandbox helper at package creation", async () => {
    const { context, vendorDirectory } = await createPackage("win32");
    const helper = join(vendorDirectory, "srt-win", "x64", "srt-win.exe");
    const bytes = readFileSync(helper);
    bytes[0x20] ^= 1;
    writeFileSync(helper, bytes);
    await expect(afterPack(context)).rejects.toThrow("srt-win-integrity-mismatch: x64");
  });

  it("rejects a missing PDF page renderer, its pdf.js data or notices at package creation", async () => {
    const { context, resources, modules } = await createPackage("linux");
    const binding = join(modules, "@napi-rs", "canvas-linux-x64-gnu", "skia.linux-x64-gnu.node");
    rmSync(binding);
    await expect(afterPack(context)).rejects.toThrow("packaged page renderer file missing or empty");
    putFile(binding, "native addon fixture");
    rmSync(join(resources, "licenses", "canvas", "THIRD-PARTY-NOTICES.txt"));
    await expect(afterPack(context)).rejects.toThrow("page renderer license notice missing");
    writePageRuntimeResources(resources);
    await expect(afterPack(context)).resolves.toBeUndefined();
  });

  it("rejects empty files and directories in place of runtime libraries", async () => {
    const { libraryDirectory } = await createPackage("linux");
    const library = join(libraryDirectory, "libvk_swiftshader.so");
    writeFileSync(library, "");
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, "linux")).toThrow(library);
    rmSync(library);
    mkdirSync(library);
    expect(() => assertGraphicsRuntimeFiles(libraryDirectory, "linux")).toThrow(library);
  });

  it.each(["unknown", "constructor", "__proto__"])("rejects unsupported target %s", (platform) => {
    expect(() => assertGraphicsRuntimeFiles(tmpdir(), platform)).toThrow("unsupported graphics runtime platform");
  });
});

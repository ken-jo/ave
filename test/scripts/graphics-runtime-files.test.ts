import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { writeImageRuntimePackage } from "../../src/__tests__/support/image-runtime-package.js";
import { writeCanvasRuntimePackage, writePageRuntimeResources } from "../../src/__tests__/support/page-runtime-package.js";
import { writeMxcRuntimePackage } from "../../src/__tests__/support/mxc-runtime-package.js";
import { upstreamSrtWinReceiptFixtures } from "../../src/__tests__/support/srt-win-build-receipts.js";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };

const SRT_WIN_BUILD_RECEIPTS = upstreamSrtWinReceiptFixtures();
const require = createRequire(import.meta.url);
const MEMORY_RUNTIME_NOTICES = require("../../scripts/lib/memory-runtime-notices.json") as readonly { noticeFile: string }[];
const BUNDLED_RENDERER_NOTICES = require("../../scripts/lib/bundled-renderer-notices.json") as readonly { packageName: string; noticeFile: string }[];
const { readUpstreamSrtWinInput } = require("../../scripts/lib/srt-win-integrity.cjs") as {
  readUpstreamSrtWinInput: (path: string, arch: string) => Buffer;
};
const PATH_KIND_HELPER = "fixture helper";
const PATH_KIND_SHA256 = createHash("sha256").update(PATH_KIND_HELPER).digest("hex");
const PATH_KIND_BUNDLE = `const __aveWindowsPathKindPin = "${PATH_KIND_SHA256}";\n`;
const packageHook = require("../../scripts/electron-after-pack.cjs") as (
  context: Awaited<ReturnType<typeof createPackage>>["context"],
) => Promise<void>;

function posixLauncher(platform: "darwin" | "linux", appOutDir: string) {
  const target = platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const { launcher } = PINS.targets[target];
  const resources = platform === "darwin" ? join(appOutDir, "Client.app", "Contents", "Resources") : join(appOutDir, "resources");
  return {
    installed: join("node_modules", PINS.package, launcher.member),
    packaged: join(resources, "mxc", basename(dirname(launcher.member)), basename(launcher.member)),
  };
}

async function afterPack(context: Awaited<ReturnType<typeof createPackage>>["context"], copy?: { mapping: "file" | "directory"; substitute: boolean }): Promise<void> {
  if (context.electronPlatformName !== "win32") {
    if (process.platform !== "win32") return packageHook(context);
    // Simulated POSIX packages on Windows need their POSIX file mode represented in the fixture.
    const { packaged } = posixLauncher(context.electronPlatformName, context.appOutDir);
    const fs = require("node:fs") as typeof import("node:fs");
    const lstat = fs.lstatSync;
    fs.lstatSync = ((file: Parameters<typeof lstat>[0], options: Parameters<typeof lstat>[1]) => {
      const entry = lstat(file, options);
      if (file === packaged && typeof entry?.mode === "number") entry.mode |= 0o111;
      return entry;
    }) as typeof lstat;
    syncBuiltinESMExports();
    try { return await packageHook(context); }
    finally {
      fs.lstatSync = lstat;
      syncBuiltinESMExports();
    }
  }
  // The real hook and all verifiers run against this owned unit payload. Only
  // the fixture's architecture-dependent pins are substituted, never checks.
  const script = `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { dirname, join } from 'node:path';
    import { registerHooks, createRequire } from 'node:module';
    const context = JSON.parse(process.argv[1]);
    const pins = readFileSync(process.argv[2], 'utf8');
    registerHooks({ load(url, options, nextLoad) {
      if (url.endsWith('/src/permissions/mxc-launcher-pins.json')) return {
        format: 'json', shortCircuit: true, source: pins,
      };
      return nextLoad(url, options);
    }});
    try {
      const require = createRequire(process.argv[3]);
      const verifier = require(process.argv[4]);
      const verify = verifier.assertSrtWinVendor;
      verifier.assertSrtWinVendor = (vendor, arches) => verify(vendor, arches, JSON.parse(process.env.AVE_TEST_SRT_RECEIPTS));
      // The before-pack record of the fixture's helper, as the packager process holds it for after-pack.
      const arch = { 1: 'x64', 3: 'arm64' }[context.arch];
      const build = { binarySha256: process.argv[6], imageSha256: process.argv[6] };
      const bundleDir = join(context.appOutDir, 'staging', 'dist', 'main');
      const bundle = process.argv[8];
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'main.js'), bundle);
      const bundleSha256 = { 'main.js': createHash('sha256').update(bundle).digest('hex') };
      const receiptPath = join(context.appOutDir, 'bundle-receipt.json');
      writeFileSync(receiptPath, JSON.stringify({ arch, imageSha256: build.imageSha256, bundleSha256 }));
      (await import(process.argv[5])).recordWindowsPathKindPackageBuild({
        appOutDir: context.appOutDir, arch, bundleDir, build, receiptPath,
      });
      const copy = JSON.parse(process.argv[7]);
      if (copy) {
        require('app-builder-lib');
        const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher');
        const { WinPackager } = require('app-builder-lib/out/winPackager');
        const options = require('../package.json').build.win;
        const expand = value => value.replaceAll('$' + '{arch}', arch);
        const mapping = options.extraResources.find(({ from }) => from.endsWith('/ave-path-kind.exe'));
        const source = join(context.appOutDir, 'staging', expand(mapping.from));
        const target = join(context.appOutDir, 'resources', expand(mapping.to));
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, copy.substitute ? 'substituted helper' : readFileSync(target));
        const packager = Object.assign(Object.create(WinPackager.prototype), {
          platformSpecificBuildOptions: options,
          signIf(file) { writeFileSync(file + '.signed', 'signer invoked'); writeFileSync(file, 'signed'); },
        });
        const matcher = copy.mapping === 'file'
          ? new FileMatcher(source, target, value => value)
          : new FileMatcher(dirname(source), dirname(target), value => value, ['ave-path-kind.exe']);
        await copyFiles([matcher], packager.createTransformerForExtraFiles(context));
      }
      await require(process.argv[3])(context);
      console.log(JSON.stringify({ passed: true }));
    } catch (error) {
      console.log(JSON.stringify({ name: error.name, message: error.message }));
      process.exitCode = 1;
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(context),
    join(context.appOutDir, "resources", "fixture-sdk-pins.json"), require.resolve("../../scripts/electron-after-pack.cjs"),
    require.resolve("../../scripts/lib/srt-win-integrity.cjs"),
    pathToFileURL(require.resolve("../../scripts/lib/windows-path-kind-package.mjs")).href, pathKindHelper(context), JSON.stringify(copy ?? null), PATH_KIND_BUNDLE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AVE_TEST_SRT_RECEIPTS: JSON.stringify(SRT_WIN_BUILD_RECEIPTS) }, encoding: "utf8",
  });
  if (result.error) throw result.error;
  const observation = JSON.parse(result.stdout);
  if (result.status !== 0) throw Object.assign(new Error(observation.message), { name: observation.name });
}
function pathKindHelper(context: Awaited<ReturnType<typeof createPackage>>["context"]): string {
  const helper = join(context.appOutDir, "resources", "windows-path-kind", context.arch === 3 ? "arm64" : "x64", "ave-path-kind.exe");
  putFile(helper, PATH_KIND_HELPER);
  return PATH_KIND_SHA256;
}
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
  const arch = platform === "darwin" ? "arm64" : "x64";
  const target = `${platform}-${arch}`;
  const embeddingRuntime = join(modules, "onnxruntime-node", "bin", "napi-v6", platform, arch);
  const runtimeLibraries = platform === "win32" ? ["onnxruntime.dll", "DirectML.dll", "dxcompiler.dll"]
    : [platform === "darwin" ? "libonnxruntime.1.dylib" : "libonnxruntime.so.1"];
  for (const file of ["onnxruntime_binding.node", ...runtimeLibraries]) putFile(join(embeddingRuntime, file));
  for (const { noticeFile } of MEMORY_RUNTIME_NOTICES) {
    const relative = join("licenses", "memory", noticeFile);
    putFile(join(resources, relative), readFileSync(join("resources", relative)));
  }
  if (platform !== "win32") {
    putFile(join(modules, "@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar"));
  }
  const uv = Buffer.from("executable");
  const uvName = platform === "win32" ? "uv.exe" : "uv";
  putFile(join(resources, "uv", target, `${uvName}.gz`), gzipSync(uv));
  putFile(join(resources, "uv", target, "uv.meta.json"), JSON.stringify({
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
      putFile(vendorPath, readUpstreamSrtWinInput(join(runtimeRoot, "vendor"), "x64"));
      putFile(join(dirname(vendorPath), "build-receipt.json"), JSON.stringify(SRT_WIN_BUILD_RECEIPTS.x64));
    }
    chmodSync(vendorPath, 0o755);
  }
  for (const file of platform === "win32"
    ? ["pty.node", "conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe"]
    : platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"]) {
    putFile(join(modules, "node-pty", "prebuilds", target, file));
  }
  putFile(join(modules, "better-sqlite3", "prebuilds", `${target}.node`));
  writeImageRuntimePackage(modules, platform, arch);
  writeCanvasRuntimePackage(modules, platform, arch);
  writePageRuntimeResources(resources, platform === "win32" ? { "dist/src/main/main.js": PATH_KIND_BUNDLE } : {});
  const ripgrep = join(modules, "@vscode", `ripgrep-${target}`);
  putFile(join(ripgrep, "package.json"), JSON.stringify({ name: `@vscode/ripgrep-${target}` }));
  putFile(join(ripgrep, "bin", platform === "win32" ? "rg.exe" : "rg"));
  chmodSync(join(ripgrep, "bin", platform === "win32" ? "rg.exe" : "rg"), 0o755);
  for (const notice of ["README.txt", "COPYING", "LICENSE-MIT", "UNLICENSE", "PCRE2-LICENCE.txt", "VSCODE-RIPGREP-LICENSE"]) {
    putFile(join(resources, "licenses", "ripgrep", notice));
  }
  for (const file of RUNTIME_FILES[platform]) putFile(join(libraryDirectory, file), file);
  if (platform === "win32") writeMxcRuntimePackage(resources, join(root, "Client.exe"));
  else {
    const { installed, packaged } = posixLauncher(platform, root);
    mkdirSync(dirname(packaged), { recursive: true });
    copyFileSync(installed, packaged);
    chmodSync(packaged, 0o755);
  }
  return {
    libraryDirectory,
    resources,
    modules,
    vendorDirectory: join(modules, "@anthropic-ai", "sandbox-runtime", "vendor"),
    context: {
      appOutDir: root,
      electronPlatformName: platform,
      arch: arch === "arm64" ? 3 : 1,
      packager: { appInfo: { productFilename: "Client" } },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged graphics runtime", () => {
  it("requires upstream archive verification when the locked runtime major changes", () => {
    const lock = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");
    const version = lock.match(/^\s*"electron": \["electron@([^"]+)"/m)?.[1];
    const major = Number(version?.split(".")[0]);
    expect(major,
      "Re-verify graphics runtime files against the locked electron upstream release zips for every platform, then update the version guard and fixtures.",
    ).toBe(45);
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

  it.each(["file", "directory"] as const)("checks exact helper bytes after the %s copy with signing enabled", async (mapping) => {
    const { context, resources } = await createPackage("win32");
    const signature = join(resources, "windows-path-kind", "x64", "ave-path-kind.exe.signed");
    await expect(afterPack(context, { mapping, substitute: false })).resolves.toBeUndefined();
    expect(existsSync(signature)).toBe(false);
  });

  it.each(["file", "directory"] as const)("refuses substituted helper bytes without sending the %s copy to the signer", async (mapping) => {
    const { context, resources } = await createPackage("win32");
    const signature = join(resources, "windows-path-kind", "x64", "ave-path-kind.exe.signed");
    await expect(afterPack(context, { mapping, substitute: true })).rejects.toThrow(
      "The packaged Windows path helper is not the before-pack build",
    );
    expect(existsSync(signature)).toBe(false);
  });

  it("rejects a mismatching win32 sandbox helper at package creation", async () => {
    const { context, vendorDirectory } = await createPackage("win32");
    const helper = join(vendorDirectory, "srt-win", "x64", "srt-win.exe");
    const bytes = readFileSync(helper);
    bytes[0x20] ^= 1;
    writeFileSync(helper, bytes);
    await expect(afterPack(context)).rejects.toThrow("srt-win-integrity-mismatch: x64");
  });

  it("rejects a missing native SDK payload with a typed packaging error", async () => {
    const { context, modules } = await createPackage("win32");
    const missing = join(modules, "@koromix");
    rmSync(missing, { recursive: true });
    await expect(afterPack(context)).rejects.toMatchObject({
      name: "MxcIntegrityError", message: `Native SDK packaging payload missing: ${missing}`,
    });
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

  it.each(BUNDLED_RENDERER_NOTICES)("refuses a packaged app missing the bundled $packageName notice", async ({ noticeFile }) => {
    const { context, resources } = await createPackage("darwin");
    rmSync(join(resources, "licenses", "renderer", noticeFile));
    await expect(afterPack(context)).rejects.toThrow("Bundled renderer notice missing");
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

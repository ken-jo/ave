import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasCppBuildTools,
  missingBuildToolsMessage,
  prepareWindowsJob,
  windowsJobLauncherPath,
  windowsJobLauncherState,
  windowsJobSources,
} from "../../scripts/prepare-windows-job.mjs";
import {
  WINDOWS_PATH_KIND_PROFILE, WINDOWS_PATH_KIND_PROFILE_SETTINGS, windowsPathKindCompilerCommand,
  windowsPathKindPath, windowsPathKindReceipt, windowsPathKindReceiptPath, windowsPathKindRustflags, windowsPathKindToolPaths,
  verifyWindowsPathKindReceipt,
} from "../../scripts/lib/windows-path-kind-build.mjs";
import { windowsPeImageDigest } from "../../scripts/lib/windows-path-kind-image-digest.mjs";
import { contentHash as sha256 } from "../../src/__tests__/support/content-hash.js";

const roots: string[] = [];
const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-02-01T00:00:00Z");
const LAUNCHER = windowsJobLauncherPath("x64");
const PATH_KIND = join("resources", "windows-path-kind", "x64", "ave-path-kind.exe");
const RECEIPT = windowsPathKindReceiptPath("x64");
const PIN = 'channel = "1.92.0"\n';
const RUST_INPUTS = ["native/windows-path-kind/src/main.rs", "native/windows-path-kind/Cargo.toml",
  "native/windows-path-kind/Cargo.lock", "scripts/build-windows-path-kind.mjs", "scripts/lib/windows-path-kind-build.mjs"];

function pathKindPe(dll = "KERNEL32.dll", delayed = false): Buffer {
  const binary = Buffer.alloc(0x400);
  binary.writeUInt16LE(0x5a4d);
  binary.writeUInt32LE(64, 60);
  binary.writeUInt32LE(0x4550, 64);
  binary.writeUInt16LE(0x8664, 68);
  binary.writeUInt16LE(1, 70); // One section
  binary.writeUInt16LE(240, 84); // Optional header size
  const optional = 88;
  binary.writeUInt16LE(0x20b, optional);
  binary.writeUInt32LE(16, optional + 108); // Data directory count
  const directory = optional + 112 + 8 * (delayed ? 13 : 1);
  binary.writeUInt32LE(0x1000, directory);
  binary.writeUInt32LE(delayed ? 64 : 40, directory + 4);
  const section = optional + 240;
  binary.writeUInt32LE(0x200, section + 8);
  binary.writeUInt32LE(0x1000, section + 12);
  binary.writeUInt32LE(0x200, section + 16);
  binary.writeUInt32LE(0x200, section + 20);
  if (delayed) binary.writeUInt32LE(1, 0x200);
  binary.writeUInt32LE(0x1080, 0x200 + (delayed ? 4 : 12));
  binary.write(dll, 0x280, "ascii");
  return binary;
}

function stagePathKind(root: string, machine = 0x8664): void {
  const binary = pathKindPe();
  const toolchain = /^channel = "(.*)"/mu.exec(readFileSync(join(root, "rust-toolchain.toml"), "utf8"))?.[1];
  if (!toolchain) throw new Error("Missing fixture toolchain");
  const rustupRoot = "C:\\example\\.rustup";
  const host = "x86_64-pc-windows-msvc";
  const tools = windowsPathKindToolPaths(rustupRoot, toolchain, host);
  const sysroot = win32.dirname(win32.dirname(tools.rustc));
  const systemRoot = "C:\\Windows";
  const programFiles = "C:\\Program Files (x86)";
  const sdk = win32.join(programFiles, "Windows Kits", "10", "Lib", "10.0.12345.0");
  const sdkImports = win32.join(sdk, "um", "x64");
  const msvc = "C:\\example\\VC\\Tools\\MSVC\\14.0.12345\\lib\\x64";
  const staticCrt = [win32.join(msvc, "libcmt.lib"), win32.join(msvc, "libvcruntime.lib"), win32.join(sdk, "ucrt", "x64", "libucrt.lib")];
  const rustlib = win32.join(sysroot, "lib", "rustlib");
  const targetLib = win32.join(rustlib, host, "lib");
  const suffix = "0123456789abcdef";
  const files = (paths: string[]) => paths.map((path) => ({ path, sha256: "0".repeat(64) }));
  const inputs = {
    systemRoot, sysroot, sdkImports, staticCrt,
    tools: files([
      win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe"), ...Object.values(tools),
      win32.join(sysroot, "bin", `rustc_driver-${suffix}.dll`), win32.join(sysroot, "bin", `std-${suffix}.dll`),
    ]),
    rustLibraries: files([
      ...["alloc", "cfg_if", "compiler_builtins", "core", "getopts", "hashbrown", "panic_abort", "panic_unwind", "proc_macro",
        "profiler_builtins", "rustc_demangle", "rustc_literal_escaper", "rustc_std_workspace_alloc", "rustc_std_workspace_core",
        "rustc_std_workspace_std", "std", "std_detect", "sysroot", "test", "unwind", "windows_targets"]
        .map((name) => win32.join(targetLib, `lib${name}-${suffix}.rlib`)),
      win32.join(targetLib, `std-${suffix}.dll`), win32.join(targetLib, `std-${suffix}.dll.lib`),
      ...["intrinsic", "liballoc", "libcore", "libstd"].map((name) => win32.join(rustlib, "etc", `${name}.natvis`)),
    ]),
    libraries: files([
      ...["advapi32.lib", "bcrypt.lib", "dbghelp.lib", "kernel32.lib", "ntdll.lib", "ole32.lib", "shell32.lib", "userenv.lib", "ws2_32.lib"]
        .map((name) => win32.join(sdkImports, name)),
      ...staticCrt,
    ]),
  };
  const identity = {
    toolchain, compiler: `release: ${toolchain}\nhost: ${host}`, host, target: host, rustupRoot, ...tools, inputs,
    profile: WINDOWS_PATH_KIND_PROFILE, profileSettings: WINDOWS_PATH_KIND_PROFILE_SETTINGS,
    rustflags: windowsPathKindRustflags(tools.linker, inputs),
  };
  const targetDir = "C:\\example\\target";
  const invocation = windowsPathKindCompilerCommand(identity, targetDir, "0123456789abcdef");
  const receipt = windowsPathKindReceipt(root, "x64", { identity, invocation, targetDir }, binary);
  binary.writeUInt16LE(machine, 68);
  mkdirSync(dirname(join(root, PATH_KIND)), { recursive: true });
  writeFileSync(join(root, PATH_KIND), binary);
  writeFileSync(join(root, RECEIPT), JSON.stringify(receipt));
}

function write(root: string, relative: string, time: Date): void {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), relative);
  utimesSync(join(root, relative), time, time);
}

function fixtureRoot({ launcher, pathKind = true }: { launcher?: Date; pathKind?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ave-windows-job-"));
  roots.push(root);
  for (const source of ["scripts/build-windows-job.ps1", "native/windows-job/launcher.cpp", "native/windows-job/README.md"]) {
    write(root, source, OLD);
  }
  for (const source of RUST_INPUTS) write(root, source, OLD);
  writeFileSync(join(root, "rust-toolchain.toml"), PIN);
  if (pathKind) stagePathKind(root);
  if (launcher) write(root, LAUNCHER, launcher);
  return root;
}

function buildStub(root: string, calls: string[][]) {
  return (command: string, args: string[]) => {
    calls.push([command, ...args]);
    write(root, LAUNCHER, new Date());
    return { status: 0 };
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pathKindBuildFixture() {
  const root = fixtureRoot({ pathKind: false });
  const crate = "native/windows-path-kind";
  cpSync(resolve(crate, "src"), join(root, crate, "src"), { recursive: true });
  for (const file of RUST_INPUTS.filter((input) => !input.endsWith(".rs"))) {
    cpSync(resolve(file), join(root, file));
  }
  const buildTemp = mkdtempSync(join(tmpdir(), "ave cargo temp-"));
  roots.push(buildTemp);
  const runScript = (script: string, code: string, overrides: NodeJS.ProcessEnv = {}, args: string[] = []) => spawnSync(process.execPath, [
    "--input-type=module", "--eval", code, pathToFileURL(resolve(script)).href, root, ...args,
  ], {
    encoding: "utf8", windowsHide: true,
    env: {
      ...process.env, TMP: buildTemp, TEMP: buildTemp, TMPDIR: buildTemp, AVE_TEST_TMP_ROOT: buildTemp,
      ...overrides, ELECTRON_RUN_AS_NODE: "1",
    },
  });
  const runBuild = (overrides?: NodeJS.ProcessEnv) => runScript("scripts/build-windows-path-kind.mjs",
    'const {buildWindowsPathKind} = await import(process.argv[1]); buildWindowsPathKind({root: process.argv[2]});',
    overrides);
  const receiptPath = join(root, windowsPathKindReceiptPath(process.arch));
  return { root, crate, runBuild, runScript, receiptPath, buildTemp };
}

describe("Windows path helper build", () => {
  it.skipIf(process.platform !== "win32")("pins discovery and records every build tool before using it", () => {
    const { root, runBuild, receiptPath } = pathKindBuildFixture();
    const clean = runBuild();
    expect(clean.status, clean.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const { tools } = receipt.identity.inputs;
    const discovery = tools.find(({ path }: { path: string }) => win32.basename(path) === "vswhere.exe");
    expect.soft(discovery).toBeDefined();
    if (discovery) expect(discovery.sha256).toBe(createHash("sha256").update(readFileSync(discovery.path)).digest("hex"));

    const hostile = runBuild({ SystemRoot: "Q:\\example", "ProgramFiles(x86)": root, PATH: root });
    expect(hostile.status, hostile.stderr).toBe(0);
    expect(JSON.parse(readFileSync(receiptPath, "utf8")).identity).toEqual(receipt.identity);
  }, 60_000);

  it.skipIf(process.platform !== "win32")("rejects incomplete, duplicated or redirected build input inventories", () => {
    const { root, runBuild, receiptPath } = pathKindBuildFixture();
    const built = runBuild();
    expect(built.status, built.stderr).toBe(0);
    verifyWindowsPathKindReceipt(root, process.arch);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const { inputs } = receipt.identity;
    for (const list of ["tools", "rustLibraries", "libraries"] as const) {
      for (let index = 0; index < inputs[list].length; index += 1) {
        const files = inputs[list].filter((_: unknown, i: number) => i !== index);
        writeFileSync(receiptPath, JSON.stringify({
          ...receipt, identity: { ...receipt.identity, inputs: { ...inputs, [list]: files } },
        }));
        expect.soft(() => verifyWindowsPathKindReceipt(root, process.arch), inputs[list][index].path).toThrow(/toolchain identity/u);
      }
    }
    for (const unexpected of [inputs.tools[0], { ...inputs.tools[0], path: "Q:\\example\\vswhere.exe" }]) {
      writeFileSync(receiptPath, JSON.stringify({
        ...receipt, identity: { ...receipt.identity, inputs: { ...inputs, tools: [...inputs.tools, unexpected] } },
      }));
      expect.soft(() => verifyWindowsPathKindReceipt(root, process.arch)).toThrow(/toolchain identity/u);
    }
  }, 60_000);

  it.skipIf(process.platform !== "win32")("seals a real offline Cargo build and verifies its executed compiler command", () => {
    const { root, crate, runBuild, receiptPath } = pathKindBuildFixture();
    const clean = runBuild();
    expect(clean.status, clean.stderr).toBe(0);
    const cleanReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));

    const cargoHome = join(root, "user cargo home");
    mkdirSync(cargoHome);
    writeFileSync(join(cargoHome, "config.toml"), "[profile.release]\nopt-level = 1\n");
    const changedProfile = runBuild({ CARGO_HOME: cargoHome, CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1" });
    expect(changedProfile.status, changedProfile.stderr).toBe(0);
    expect.soft(changedProfile.stderr).toContain("-C opt-level=3");
    expect.soft(changedProfile.stderr).toContain("-C codegen-units=16");

    const substitute = join(root, "alternate.exe");
    const hostileConfig = '[build]\nrustc = "alternate.exe"\nrustc-wrapper = "alternate.exe"\n[profile.release]\nopt-level = 0\n';
    for (const folder of [join(root, ".cargo"), join(root, crate, ".cargo")]) {
      mkdirSync(folder);
      writeFileSync(join(folder, "config.toml"), hostileConfig);
    }
    const targetLinker = process.arch === "arm64" ? "AARCH64_PC_WINDOWS_MSVC" : "X86_64_PC_WINDOWS_MSVC";
    const hostile = runBuild({
      CARGO_HOME: cargoHome, CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
      RUSTC: substitute, RUSTC_WRAPPER: substitute, RUSTC_WORKSPACE_WRAPPER: substitute,
      CARGO_BUILD_RUSTC: substitute, CARGO_BUILD_RUSTC_WRAPPER: substitute, CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: substitute,
      RUSTUP_TOOLCHAIN: "alternate", RUSTUP_HOME: join(root, "alternate rustup"), CARGO: substitute,
      USERPROFILE: join(root, "alternate profile"), PATH: root,
      [`CARGO_TARGET_${targetLinker}_LINKER`]: substitute,
      RUSTFLAGS: "--unexpected", CARGO_ENCODED_RUSTFLAGS: "--unexpected", LINK: "/unexpected", LIB: root,
    });
    expect(hostile.status, hostile.stderr).toBe(0);
    verifyWindowsPathKindReceipt(root, process.arch);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(hostile.stderr.match(/^\s*Running `(.+)`\r?$/mu)?.[1]).toBe(receipt.invocation);
    expect(receipt.identity).toEqual(cleanReceipt.identity);
    expect(receipt.invocation.replaceAll(receipt.targetDir, "<target>")).toBe(
      cleanReceipt.invocation.replaceAll(cleanReceipt.targetDir, "<target>"),
    );
    expect(receipt.invocation).not.toContain(substitute);

    const manifest = join(root, crate, "Cargo.toml");
    const originalManifest = readFileSync(manifest, "utf8");
    writeFileSync(manifest, `${originalManifest}\n[profile.release.package.ave-path-kind]\nopt-level = 2\n`);
    const unexpectedFlags = runBuild();
    expect(unexpectedFlags.status).toBe(1);
    expect(unexpectedFlags.stderr).toContain("-C opt-level=2");
    expect(unexpectedFlags.stderr).toContain("Unexpected Windows path helper compiler invocation");
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(receipt);
    writeFileSync(manifest, originalManifest);

    writeFileSync(receiptPath, JSON.stringify({ ...receipt, invocation: `${receipt.invocation} -C link-arg=/unexpected` }));
    expect(() => verifyWindowsPathKindReceipt(root, process.arch)).toThrow("Unexpected Windows path helper compiler invocation");

    const parent = join(root, "build parent");
    mkdirSync(join(parent, ".cargo"), { recursive: true });
    writeFileSync(join(parent, ".cargo", "config"), hostileConfig);
    const blocked = runBuild({ TMP: parent, TEMP: parent, TMPDIR: parent, AVE_TEST_TMP_ROOT: parent });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("Unexpected Cargo config above the Windows path helper build directory");
  }, 60_000);

  it.skipIf(process.platform !== "win32")("isolates the link from crate-local libraries", () => {
    const { root, crate, runBuild, receiptPath } = pathKindBuildFixture();
    const clean = runBuild();
    expect(clean.status, clean.stderr).toBe(0);
    const executable = join(root, windowsPathKindPath(process.arch));
    const binary = readFileSync(executable);
    const cleanReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));

    writeFileSync(join(root, crate, "libucrt.lib"), "unexpected archive");
    writeFileSync(join(root, "kernel32.lib"), "unexpected archive");
    const shadowed = runBuild();
    expect(shadowed.status, shadowed.stderr).toBe(0);
    expect(readFileSync(executable)).toEqual(binary);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.identity.inputs).toEqual(cleanReceipt.identity.inputs);
    expect(receipt.identity.inputs.libraries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/libucrt\.lib$/iu), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    ]));
    verifyWindowsPathKindReceipt(root, process.arch);
  }, 60_000);

  it.skipIf(process.platform !== "win32")("replaces an independently supplied executable even with an authentic recorded command", () => {
    const { root, runBuild, runScript, receiptPath, buildTemp } = pathKindBuildFixture();
    write(root, windowsJobLauncherPath(process.arch), NEW);
    const built = runBuild();
    expect(built.status, built.stderr).toBe(0);
    const executable = join(root, windowsPathKindPath(process.arch));
    const original = readFileSync(executable);
    const supplied = pathKindPe();
    if (process.arch === "arm64") supplied.writeUInt16LE(0xaa64, 68);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeFileSync(executable, supplied);
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, binarySha256: createHash("sha256").update(supplied).digest("hex") }));
    verifyWindowsPathKindReceipt(root, process.arch);

    const prepared = runScript("scripts/prepare-windows-job.mjs",
      'const {prepareWindowsJob} = await import(process.argv[1]); prepareWindowsJob({root: process.argv[2]});');
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(readFileSync(executable).equals(original)).toBe(true);
    expect(readdirSync(buildTemp)).toEqual([]);
    verifyWindowsPathKindReceipt(root, process.arch);
  }, 60_000);

  it.skipIf(process.platform !== "win32")("gives each test build a private helper and fixture that a second build cannot replace", () => {
    const { root, runScript, buildTemp } = pathKindBuildFixture();
    const outputs = [mkdtempSync(join(buildTemp, "first-")), mkdtempSync(join(buildTemp, "second-"))];
    const build = (outDir: string) => {
      const result = runScript("scripts/build-windows-path-kind.mjs",
        "const {buildWindowsPathKind} = await import(process.argv[1]);"
        + "console.log(JSON.stringify(buildWindowsPathKind({root: process.argv[2], fixture: true, outDir: process.argv[3]})));",
        {}, [outDir]);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim()) as { helper: string; fixture: string; binarySha256: string };
    };
    const first = build(outputs[0]);
    const selected = readFileSync(first.fixture);
    const second = build(outputs[1]);
    expect([first.helper, first.fixture]).toEqual([join(outputs[0], "ave-path-kind.exe"), join(outputs[0], "ave-path-pin-test.exe")]);
    expect(second.fixture).not.toBe(first.fixture);
    expect(readFileSync(first.fixture).equals(selected)).toBe(true);
    expect(createHash("sha256").update(readFileSync(first.helper)).digest("hex")).toBe(first.binarySha256);
    expect(readdirSync(buildTemp).sort()).toEqual(outputs.map((output) => output.slice(buildTemp.length + 1)).sort());
    expect(existsSync(join(root, windowsPathKindPath(process.arch)))).toBe(false);
    const nativeTest = readFileSync(resolve("scripts/test-windows-path-kind.mjs"), "utf8");
    expect(nativeTest).toContain("buildWindowsPathKind({ root, fixture: true, outDir: output })");
    expect(nativeTest).not.toContain("ave-path-pin-test.exe");
  }, 120_000);

  it.skipIf(process.platform !== "win32")("refuses a helper substituted after the runner's build returns", () => {
    const { runScript } = pathKindBuildFixture();
    const code = [
      "import { registerHooks } from 'node:module';",
      "registerHooks({ load(url, context, nextLoad) {",
      "  if (!url.endsWith('/scripts/build-windows-path-kind.mjs')) return nextLoad(url, context);",
      "  return { format: 'module', shortCircuit: true, source: " +
        "\"import { writeFileSync } from 'node:fs'; import { buildWindowsPathKind as build } from \"" +
        " + JSON.stringify(url + '?original') + ';' + " +
        "\"export function buildWindowsPathKind(options) { const result = build({ ...options, root: process.argv[2] }); " +
        "writeFileSync(result.helper, 'substituted helper'); return result; }\" };",
      "}});",
      "await import(process.argv[1]);",
    ].join("\n");
    const result = runScript("scripts/test-windows-path-kind.mjs", code);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Windows test executable does not match the producing build");
  }, 120_000);

  it.skipIf(process.platform !== "win32")("refuses a pin fixture substituted after the builder publishes it", () => {
    const { runScript, buildTemp } = pathKindBuildFixture();
    const outDir = mkdtempSync(join(buildTemp, "pin-test-"));
    const code = [
      "import assert from 'node:assert/strict';",
      "import { createHash } from 'node:crypto';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const { buildWindowsPathKind } = await import(process.argv[1]);",
      "const { fixture, fixtureSha256 } = buildWindowsPathKind({ root: process.argv[2], fixture: true, outDir: process.argv[3] });",
      "assert.equal(fixtureSha256, createHash('sha256').update(readFileSync(fixture)).digest('hex'));",
      "const { withVerifiedWindowsExecutable } = await import(process.argv[4]);",
      "assert.equal(withVerifiedWindowsExecutable(fixture, fixtureSha256, path => path.endsWith('ave-path-pin-test.exe')), true);",
      "writeFileSync(fixture, 'substituted fixture');",
      "assert.throws(() => withVerifiedWindowsExecutable(fixture, fixtureSha256, () => assert.fail('launch reached')), " +
        "/Windows test executable does not match the producing build/);",
    ].join("\n");
    const result = runScript("scripts/build-windows-path-kind.mjs", code, {}, [
      outDir, pathToFileURL(resolve("scripts/lib/windows-locked-executable.mjs")).href,
    ]);
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  it.skipIf(process.platform !== "win32")("binds the main bundle to fresh output instead of staged executable bytes", () => {
    const { root, runScript } = pathKindBuildFixture();
    const executable = join(root, windowsPathKindPath(process.arch));
    mkdirSync(dirname(executable), { recursive: true });
    const supplied = pathKindPe();
    writeFileSync(executable, supplied);
    const result = runScript("scripts/build-windows-path-kind.mjs",
      'const {buildWindowsPathKind} = await import(process.argv[1]); console.log(buildWindowsPathKind({root: process.argv[2]}).binarySha256);');
    expect(result.status, result.stderr).toBe(0);
    const built = readFileSync(executable);
    expect(built.equals(supplied)).toBe(false);
    expect(result.stdout.trim()).toBe(createHash("sha256").update(built).digest("hex"));

    const dev = readFileSync(resolve("scripts/run-electron-dev.mjs"), "utf8");
    const bundle = readFileSync(resolve("scripts/build-main-esbuild.mjs"), "utf8");
    expect(dev).toContain('spawnWatcher("main", process.execPath, [resolve(repoRoot, "scripts/build-main-esbuild.mjs"), "--watch"])');
    expect(bundle).toContain("pathKindSha256 = buildWindowsPathKind({ root: repoRoot })");
    expect(bundle).toContain('__AVE_WINDOWS_PATH_KIND_SHA256__: pathKindSha256 === null ? "null" : WINDOWS_PATH_KIND_BUNDLE_PIN');
    expect(bundle).toContain("windowsPathKindBundlePinDeclaration(pathKindSha256)");
  }, 60_000);

  it.each([
    ["VCRUNTIME140.dll", false],
    ["api-ms-win-crt-runtime-l1-1-0.dll", true],
    ["ucrtbase", true],
    ["api-ms-win-crt-runtime-l1-1-0", true],
    ["C:/Windows\\System32/ExT-Ms-Win-CrT-Runtime-L1-1-0", true],
    ["C:\\Windows\\System32\\VcRuNtImE140.DlL", false],
    ["C:/Windows/System32/UcRtBaSe.DlL", true],
    ["VCRUNT~1.DLL", true],
    ["KERNEL~1.DLL", false],
    ["unknown.dll", false],
    ["C:/example/KERNEL32.dll", true],
    ["kernel32", true],
    ["kernel32.dll ", true],
  ] as const)("rejects receipt creation and verification for an executable importing %s", (dll, delayed) => {
    const root = fixtureRoot();
    const receipt = JSON.parse(readFileSync(join(root, RECEIPT), "utf8"));
    const binary = pathKindPe(dll, delayed);
    expect.soft(() => windowsPathKindReceipt(root, "x64", receipt, binary)).toThrow(dll);
    receipt.binarySha256 = createHash("sha256").update(binary).digest("hex");
    writeFileSync(join(root, PATH_KIND), binary);
    writeFileSync(join(root, RECEIPT), JSON.stringify(receipt));
    expect(() => verifyWindowsPathKindReceipt(root, "x64")).toThrow(dll);
  });

  it.each([["KERNEL32.dll", false], ["api-ms-win-core-synch-l1-2-0.dll", true]] as const)(
    "accepts the permitted system import %s", (dll, delayed) => {
      const root = fixtureRoot();
      const build = JSON.parse(readFileSync(join(root, RECEIPT), "utf8"));
      const binary = pathKindPe(dll, delayed);
      const receipt = windowsPathKindReceipt(root, "x64", build, binary);
      writeFileSync(join(root, PATH_KIND), binary);
      writeFileSync(join(root, RECEIPT), JSON.stringify(receipt));
      verifyWindowsPathKindReceipt(root, "x64");
    },
  );
});

describe("windowsJobLauncherState", () => {
  it("does nothing off Windows, even without a launcher", () => {
    expect(windowsJobLauncherState(fixtureRoot(), { platform: "linux", arch: "x64" }).state).toBe("skip");
  });

  it("reports a missing launcher", () => {
    expect(windowsJobLauncherState(fixtureRoot(), { platform: "win32", arch: "x64" })).toEqual({ state: "missing", launcher: LAUNCHER });
  });

  it("reports a launcher older than a nested source or the build script as stale", () => {
    const root = fixtureRoot({ launcher: NEW });
    write(root, "native/windows-job/include/job.h", new Date("2026-03-01T00:00:00Z"));
    expect(windowsJobSources(root)).toContain(join("native", "windows-job", "include", "job.h"));
    expect(windowsJobLauncherState(root, { platform: "win32", arch: "x64" }))
      .toEqual({ state: "stale", launcher: LAUNCHER, newer: join("native", "windows-job", "include", "job.h") });

    const scriptRoot = fixtureRoot({ launcher: NEW });
    write(scriptRoot, "scripts/build-windows-job.ps1", new Date("2026-03-01T00:00:00Z"));
    expect(windowsJobLauncherState(scriptRoot, { platform: "win32", arch: "x64" }).state).toBe("stale");
  });

  it("reports a launcher newer than every source as fresh", () => {
    expect(windowsJobLauncherState(fixtureRoot({ launcher: NEW }), { platform: "win32", arch: "x64" }).state).toBe("fresh");
  });

  it("looks for the launcher of the requested architecture", () => {
    const root = fixtureRoot({ launcher: NEW });
    expect(windowsJobLauncherState(root, { platform: "win32", arch: "arm64" }).state).toBe("missing");
  });
});

describe("prepareWindowsJob", () => {
  it("builds a missing launcher through build:windows-job for the host architecture", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    const lines: string[] = [];
    const found = prepareWindowsJob({
      root, platform: "win32", arch: "x64", findBuildTools: () => true, runSync: buildStub(root, calls), buildPathKind: () => stagePathKind(root), log: (line) => lines.push(line),
    });
    expect(found.state).toBe("missing");
    expect(calls).toEqual([["bun.exe", "run", "build:windows-job", "-Arch", "x64"]]);
    expect(lines).toEqual([`[windows-job] building ${LAUNCHER} (missing)`, `[windows-path-kind] building ${PATH_KIND} (fresh build)`]);
  });

  it("rebuilds a stale launcher and names the newer source", () => {
    const root = fixtureRoot({ launcher: OLD });
    write(root, "native/windows-job/launcher.cpp", NEW);
    const calls: string[][] = [];
    const lines: string[] = [];
    prepareWindowsJob({ root, platform: "win32", arch: "x64", findBuildTools: () => true, runSync: buildStub(root, calls), buildPathKind: () => stagePathKind(root), log: (line) => lines.push(line) });
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([`[windows-job] building ${LAUNCHER} (older than ${join("native", "windows-job", "launcher.cpp")})`, `[windows-path-kind] building ${PATH_KIND} (fresh build)`]);
  });

  it("skips a fresh launcher without looking for the build tools", () => {
    const root = fixtureRoot({ launcher: NEW });
    const calls: string[][] = [];
    const lines: string[] = [];
    const found = prepareWindowsJob({
      root, platform: "win32", arch: "x64",
      findBuildTools: () => { throw new Error("must not probe"); }, runSync: buildStub(root, calls), buildPathKind: () => stagePathKind(root), log: (line) => lines.push(line),
    });
    expect(found.state).toBe("fresh");
    expect(calls).toEqual([]);
    expect(lines).toEqual([`[windows-job] up to date: ${LAUNCHER}`, `[windows-path-kind] building ${PATH_KIND} (fresh build)`]);
  });

  it.each(["valid", "missing digest", "substituted binary", "substituted receipt", "changed source"] as const)("prepares a shard with a %s path helper input", (input) => {
    const root = fixtureRoot({ launcher: NEW });
    const binary = readFileSync(join(root, PATH_KIND));
    const receipt = readFileSync(join(root, RECEIPT));
    const env = {
      AVE_WINDOWS_TEST_PLAN: "windows-plan.json",
      AVE_WINDOWS_PATH_KIND_SHA256: input === "missing digest" ? undefined : sha256(binary),
      AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256: sha256(receipt),
    };
    if (input === "substituted binary") writeFileSync(join(root, PATH_KIND), Buffer.concat([binary, Buffer.from("changed")]));
    if (input === "substituted receipt") writeFileSync(join(root, RECEIPT), Buffer.concat([receipt, Buffer.from("\n")]));
    if (input === "changed source") write(root, "native/windows-path-kind/src/extra.rs", OLD);
    const builds: object[] = [];
    const prepare = () => prepareWindowsJob({
      root, platform: "win32", arch: "x64", env, log: () => {},
      buildPathKind: (options) => { builds.push(options); },
    });
    const failures = {
      "missing digest": /Missing the producing build's digest/u,
      "substituted binary": /is not the output of the producing build/u,
      "substituted receipt": /is not the output of the producing build/u,
      "changed source": /build inputs or binary changed/u,
    };
    if (input === "valid") expect(prepare().state).toBe("fresh");
    else expect(prepare).toThrow(failures[input]);
    expect(builds).toEqual([]);
  });

  it("does nothing off Windows", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    const lines: string[] = [];
    expect(prepareWindowsJob({ root, platform: "darwin", arch: "arm64", runSync: buildStub(root, calls), buildPathKind: () => stagePathKind(root), log: (line) => lines.push(line) }).state).toBe("skip");
    expect([calls, lines]).toEqual([[], []]);
  });

  it.each(["missing", "old executable", "source", "script", "lockfile", "toolchain", "wrong machine"])("prepares a path classifier with %s changes independently of the job launcher", (change) => {
    const root = fixtureRoot({ launcher: new Date("2026-04-01T00:00:00Z") });
    if (change === "missing") rmSync(join(root, PATH_KIND));
    if (change === "old executable") rmSync(join(root, RECEIPT));
    if (change === "source") write(root, "native/windows-path-kind/src/extra.rs", OLD);
    if (change === "script") writeFileSync(join(root, "scripts/build-windows-path-kind.mjs"), "changed");
    if (change === "lockfile") writeFileSync(join(root, "native/windows-path-kind/Cargo.lock"), "changed");
    if (change === "toolchain") writeFileSync(join(root, "rust-toolchain.toml"), 'channel = "1.92.1"\n');
    if (change === "wrong machine") stagePathKind(root, 0xaa64);
    const builds: object[] = [];
    prepareWindowsJob({
      root, platform: "win32", arch: "x64", log: () => {},
      runSync: () => { throw new Error("must not rebuild the job launcher"); },
      buildPathKind: (options) => { builds.push(options); },
    });
    expect(builds).toEqual([{ root, arch: "x64", fixture: true }]);
  });

  it("propagates failure to build the path classifier even with a fresh job launcher", () => {
    const root = fixtureRoot({ launcher: NEW });
    rmSync(join(root, PATH_KIND));
    const options = { root, platform: "win32" as const, arch: "x64", log: () => {} };
    expect(() => prepareWindowsJob({ ...options, buildPathKind: () => { throw new Error("link failed"); } }))
      .toThrow(/link failed.*run: bun run build:windows-path-kind/u);
  });

  it("fails without the C++ build tools, naming the toolchain and the command, and does not build", () => {
    const root = fixtureRoot();
    const calls: string[][] = [];
    const run = () => prepareWindowsJob({ root, platform: "win32", arch: "x64", findBuildTools: () => false, runSync: buildStub(root, calls), buildPathKind: () => stagePathKind(root), log: () => {} });
    expect(run).toThrow(missingBuildToolsMessage(LAUNCHER));
    expect(missingBuildToolsMessage(LAUNCHER)).toContain("Visual Studio C++ build tools (MSVC");
    expect(missingBuildToolsMessage(LAUNCHER)).toMatch(/run: bun run build:windows-job$/);
    expect(calls).toEqual([]);
  });

  it("fails when the build fails or leaves no up-to-date launcher", () => {
    const root = fixtureRoot();
    const options = { root, platform: "win32" as const, arch: "x64", findBuildTools: () => true, log: () => {} };
    expect(() => prepareWindowsJob({ ...options, runSync: () => ({ status: 1 }) })).toThrow("bun run build:windows-job -Arch x64 failed (exit 1)");
    expect(() => prepareWindowsJob({ ...options, runSync: () => ({ status: 0 }) })).toThrow("did not produce an up-to-date");
  });
});

describe("hasCppBuildTools", () => {
  const programFilesX86 = "C:\\Program Files (x86)";

  it("is false without vswhere or without an MSVC installation", () => {
    expect(hasCppBuildTools({ programFilesX86: "", runSync: () => { throw new Error("must not run"); } })).toBe(false);
    expect(hasCppBuildTools({ programFilesX86, exists: () => false, runSync: () => { throw new Error("must not run"); } })).toBe(false);
    expect(hasCppBuildTools({ programFilesX86, exists: () => true, runSync: () => ({ status: 0, stdout: "\r\n" }) })).toBe(false);
    expect(hasCppBuildTools({ programFilesX86, exists: () => true, runSync: () => ({ status: 1, stdout: "" }) })).toBe(false);
  });

  it("asks vswhere for the component build-windows-job.ps1 requires", () => {
    const calls: [string, string[]][] = [];
    expect(hasCppBuildTools({
      programFilesX86, exists: () => true,
      runSync: (command, args) => { calls.push([command, args]); return { status: 0, stdout: "C:\\VS\\BuildTools\r\n" }; },
    })).toBe(true);
    expect(calls[0][0]).toContain(join("Microsoft Visual Studio", "Installer", "vswhere.exe"));
    expect(calls[0][1]).toEqual(expect.arrayContaining(["-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"]));
    const buildScript = readFileSync(resolve("scripts/build-windows-job.ps1"), "utf8");
    expect(buildScript).toContain("-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64");
  });
});

describe("Windows job launcher preparation wiring", () => {
  it("runs from test:prepare, which every hook test run goes through", () => {
    const scripts = JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts;
    expect(scripts["test:prepare"]).toContain("node scripts/prepare-windows-job.mjs");
    const runner = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    // The hook never calls test:vitest directly; the manual stage runs `test`, whose test:prepare builds it.
    expect(runner).not.toContain('"run", "test:vitest"');
    expect(runner).toContain('runPackageScripts(dir, ["test", "build"]');
  });
});

describe("Windows path helper packaging", () => {
  // Hooks run in one packager process; a child keeps the hooks and their recorded build in one module graph.
  const PACKAGING = [
    "const [lib, digest, hooks, root, bundlePin, archivePin, step, change] = process.argv.slice(1);",
    "const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');",
    "const { join } = await import('node:path');",
    "const { transformSync } = await import('esbuild');",
    "const { createPackage } = await import('@electron/asar');",
    "const appOutDir = join(root, 'win-unpacked');",
    "const { createHash } = await import('node:crypto');",
    "const { createRequire } = await import('node:module');",
    "const packaging = await import(lib);",
    "const { windowsPeImageDigest } = await import(digest);",
    "const bytes = readFileSync(join(root, 'build.exe'));",
    "const build = { binarySha256: createHash('sha256').update(bytes).digest('hex'), imageSha256: windowsPeImageDigest(bytes) };",
    "const compile = pin => transformSync('export const runtimePin = __AVE_WINDOWS_PATH_KIND_SHA256__;', { " +
      "format: 'esm', minify: true, define: { __AVE_WINDOWS_PATH_KIND_SHA256__: '__aveWindowsPathKindPin' }, " +
      "banner: 'const __aveWindowsPathKindPin = ' + JSON.stringify(pin) + ';' }).code;",
    "const bundleDir = join(root, 'dist/src/main');",
    "const bundled = compile(bundlePin); const chunk = compile(bundlePin);",
    "const sha256 = text => createHash('sha256').update(text).digest('hex');",
    "const changeBytes = text => change === 'alter-staging' ? text + '\\nexport const fixture = true;\\n' : text;",
    "const inventory = main => ({ 'main.js': sha256(main), " +
      "...(change === 'omit-chunk' ? {} : { 'chunks/chunk-ABC.js': sha256(chunk) }) });",
    "const pin = { arch: 'x64', imageSha256: windowsPeImageDigest(readFileSync(join(root, 'pin.exe'))) };",
    "const receiptPath = join(root, 'receipt.json');",
    "writeFileSync(receiptPath, JSON.stringify({ ...pin, bundleSha256: inventory(bundled) }));",
    "mkdirSync(join(bundleDir, 'chunks'), { recursive: true });",
    "writeFileSync(join(bundleDir, 'main.js'), changeBytes(bundled));",
    "writeFileSync(join(bundleDir, 'chunks/chunk-ABC.js'), chunk);",
    "const manifest = { windowsPathKind: { ...pin, bundleSha256: inventory(changeBytes(bundled)) } };",
    "writeFileSync(join(bundleDir, 'bundle-manifest.json'), JSON.stringify(manifest));",
    "packaging.recordWindowsPathKindPackageBuild({ appOutDir, arch: 'x64', manifest, receiptPath, build, bundleDir });",
    "const archiveInput = join(root, 'asar-input');",
    "const archiveBundle = join(archiveInput, 'dist/src/main');",
    "mkdirSync(join(archiveBundle, 'chunks'), { recursive: true });",
    "writeFileSync(join(archiveBundle, 'main.js'), changeBytes(compile(archivePin)));",
    "writeFileSync(join(archiveBundle, 'chunks/chunk-ABC.js'), chunk);",
    "process.noAsar = true;",
    "await createPackage(archiveInput, join(appOutDir, 'resources', 'app.asar'));",
    "const context = { electronPlatformName: 'win32', arch: 1, appOutDir, packager: { appInfo: { productFilename: 'Ave' } } };",
    "if (step === 'pack') packaging.assertPackagedWindowsPathKind(appOutDir, 'x64');",
    "else if (step === 'sign') packaging.assertSignedWindowsPathKind(appOutDir, 'x64');",
    "else await createRequire(hooks)('./electron-' + step + '.cjs')(context);",
  ].join("\n");

  function signed(image: Buffer): Buffer {
    const result = Buffer.concat([image, Buffer.alloc(16, 0x5a)]);
    result.writeUInt32LE(0x1234, 88 + 64);
    result.writeUInt32LE(image.length, 88 + 112 + 32);
    result.writeUInt32LE(16, 88 + 112 + 36);
    return result;
  }

  function packaging(step: string, {
    packaged, built = pathKindPe(), pin = built, bundlePin = pin, archivePin = bundlePin, change = "",
  }: { packaged: Buffer; built?: Buffer; pin?: Buffer; bundlePin?: Buffer; archivePin?: Buffer; change?: string }) {
    const root = mkdtempSync(join(tmpdir(), "ave-path-kind-package-"));
    roots.push(root);
    const appOutDir = join(root, "win-unpacked");
    const helper = join(appOutDir, "resources", "windows-path-kind", "x64", "ave-path-kind.exe");
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, packaged);
    writeFileSync(join(root, "build.exe"), built);
    writeFileSync(join(root, "pin.exe"), pin);
    return spawnSync(process.execPath, [
      "--input-type=module", "--eval", PACKAGING,
      pathToFileURL(resolve("scripts/lib/windows-path-kind-package.mjs")).href,
      pathToFileURL(resolve("scripts/lib/windows-path-kind-image-digest.mjs")).href,
      pathToFileURL(resolve("scripts/package.json")).href,
      root, windowsPeImageDigest(bundlePin), windowsPeImageDigest(archivePin), step, change,
    ], { encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  }

  const substituted = () => {
    const image = pathKindPe();
    image.write("substituted", 0x300, "ascii");
    return image;
  };

  it("fails the package when a different staged helper reaches the copy after the build", () => {
    const result = packaging("after-pack", { packaged: substituted() });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The packaged Windows path helper is not the before-pack build");
    const original = packaging("pack", { packaged: pathKindPe() });
    expect(original.status, original.stderr).toBe(0);
  });

  it("accepts the signed build and refuses a signed substitute", () => {
    const accepted = packaging("sign", { packaged: signed(pathKindPe()) });
    expect(accepted.status, accepted.stderr).toBe(0);
    const unsignedChange = packaging("sign", { packaged: substituted() });
    expect(unsignedChange.stderr).toContain("The signed Windows path helper is not the before-pack build");
    const result = packaging("after-sign", { packaged: signed(substituted()) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The signed Windows path helper is not the before-pack build");
  });

  it("refuses a fresh build the main bundle does not pin, and a package without a recorded build", () => {
    const unpinned = packaging("pack", { packaged: pathKindPe(), pin: substituted() });
    expect(unpinned.status).not.toBe(0);
    expect(unpinned.stderr).toContain("The main bundle does not pin this x64 Windows path helper build");
    const script = [
      "const { assertPackagedWindowsPathKind } = await import(process.argv[1]);",
      "assertPackagedWindowsPathKind(process.argv[2], 'x64');",
    ].join("\n");
    const unrecorded = spawnSync(process.execPath, ["--input-type=module", "--eval", script,
      pathToFileURL(resolve("scripts/lib/windows-path-kind-package.mjs")).href, join(tmpdir(), "missing-package")],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    expect(unrecorded.stderr).toContain("No Windows path helper build was recorded for this x64 package");
  });

  it("refuses a stale bundle behind a manifest matching the fresh helper", () => {
    const result = packaging("pack", { packaged: pathKindPe(), bundlePin: substituted() });
    expect(result.stderr).toContain("The main bundle pin does not match the before-pack build");
    expect(result.status).not.toBe(0);
  });

  it("refuses a substituted archived bundle after accepting the build", () => {
    const result = packaging("pack", { packaged: pathKindPe(), archivePin: substituted() });
    expect(result.stderr).toContain("The archived main bundle does not match the before-pack build");
    expect(result.status).not.toBe(0);
  });

  it("refuses staged bundle bytes even when their staged manifest agrees", () => {
    const result = packaging("pack", { packaged: pathKindPe(), change: "alter-staging" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The main bundle bytes do not match the producing build");
  });

  it("refuses an archived executable chunk outside the producing build inventory", () => {
    const result = packaging("pack", { packaged: pathKindPe(), change: "omit-chunk" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The archived main bundle contains a file missing from the producing build inventory");
  });

  it("wires the packaging hooks to the before-pack build and the producer receipt", () => {
    const beforePack = readFileSync(resolve("scripts/electron-before-pack.cjs"), "utf8");
    expect(beforePack).toContain("const pathKind = buildWindowsPathKind({ root: context.packager.projectDir, arch });");
    expect(beforePack).toContain("receiptPath: process.env.AVE_WINDOWS_PATH_KIND_BUNDLE_RECEIPT");
    expect(readFileSync(resolve("scripts/build-main-esbuild.mjs"), "utf8"))
      .toContain('writeFileSync(receipt, JSON.stringify({ arch: process.arch, imageSha256: pathKindSha256, bundleSha256 }), { flag: "wx", mode: 0o600 });');
  });
});

describe("Windows CI path helper restore", () => {
  function restoreFixture() {
    const root = fixtureRoot();
    const inputs = join(root, ".windows-native-inputs");
    const helper = readFileSync(join(root, PATH_KIND));
    const receipt = readFileSync(join(root, RECEIPT));
    const { TARGETS } = createRequire(import.meta.url)("../../scripts/lib/srt-win-integrity.cjs") as { TARGETS: Record<string, unknown> };
    const vendor = "node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win";
    for (const file of [LAUNCHER, ...Object.keys(TARGETS).flatMap(arch => ["upstream-srt-win.exe", "srt-win.exe", "build-receipt.json"]
      .map(name => join(vendor, arch, name))), ...["js", "json"].map(extension => `src/permissions/generated/srt-win-build-receipts.${extension}`)]) {
      write(inputs, file, OLD);
    }
    for (const [file, bytes] of [[PATH_KIND, helper], [RECEIPT, receipt]] as const) {
      rmSync(join(root, file));
      mkdirSync(dirname(join(inputs, file)), { recursive: true });
      writeFileSync(join(inputs, file), bytes);
    }
    const runnerTemp = join(root, ".runner");
    mkdirSync(join(runnerTemp, "python-release-mirror"), { recursive: true });
    writeFileSync(join(runnerTemp, "python-release-mirror", "python.tar.gz"), "archive");
    writeFileSync(join(runnerTemp, "env"), "");
    const restore = (digests: { AVE_WINDOWS_PATH_KIND_SHA256?: string; AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256?: string }) => {
      const env: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: join(runnerTemp, "env"), ELECTRON_RUN_AS_NODE: "1", ...digests };
      for (const name of ["AVE_WINDOWS_PATH_KIND_SHA256", "AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256"] as const) if (!(name in digests)) delete env[name];
      return spawnSync(process.execPath, [resolve(".github/scripts/restore-windows-ci-inputs.mjs")], { cwd: root, encoding: "utf8", windowsHide: true, env });
    };
    return { root, inputs, restore, produced: { AVE_WINDOWS_PATH_KIND_SHA256: sha256(helper), AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256: sha256(receipt) } };
  }

  it.skipIf(process.arch !== "x64")("rejects an independently substituted helper and matching receipt before promoting them", () => {
    const { root, inputs, restore, produced } = restoreFixture();
    const supplied = pathKindPe();
    supplied.write("substituted", 0x300, "ascii");
    const receipt = JSON.parse(readFileSync(join(inputs, RECEIPT), "utf8"));
    writeFileSync(join(inputs, PATH_KIND), supplied);
    writeFileSync(join(inputs, RECEIPT), JSON.stringify({ ...receipt, binarySha256: sha256(supplied) }));
    const result = restore(produced);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not the output of the producing build");
    expect(existsSync(join(root, PATH_KIND))).toBe(false);
  });

  it.skipIf(process.arch !== "x64")("refuses a restore without the producing build's digests", () => {
    const { root, restore, produced } = restoreFixture();
    for (const digests of [{}, { ...produced, AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256: "" }, { ...produced, AVE_WINDOWS_PATH_KIND_SHA256: "A".repeat(64) }]) {
      const result = restore(digests);
      expect(result.stderr).toContain("Missing the producing build's digest");
    }
    expect(existsSync(join(root, PATH_KIND))).toBe(false);
  });

  it.skipIf(process.arch !== "x64")("promotes the original same-run payload", () => {
    const { root, restore, produced } = restoreFixture();
    const result = restore(produced);
    expect(result.status, result.stderr).toBe(0);
    expect(sha256(readFileSync(join(root, PATH_KIND)))).toBe(produced.AVE_WINDOWS_PATH_KIND_SHA256);
    verifyWindowsPathKindReceipt(root, "x64");
  });

  it("passes the designated build's digests from the preparation job to both restore steps", () => {
    const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain(`      path_kind_sha256: \${{ steps.windows-path-kind-build.outputs.binary_sha256 }}`);
    expect(workflow).toContain(`      path_kind_receipt_sha256: \${{ steps.windows-path-kind-build.outputs.receipt_sha256 }}`);
    expect(workflow).toContain("      - name: Build Windows path helper and fixture\n        id: windows-path-kind-build\n");
    const restore = "        env:\n"
      + `          AVE_WINDOWS_PATH_KIND_SHA256: \${{ needs.windows-native-preparation.outputs.path_kind_sha256 }}\n`
      + `          AVE_WINDOWS_PATH_KIND_RECEIPT_SHA256: \${{ needs.windows-native-preparation.outputs.path_kind_receipt_sha256 }}\n`
      + "        run: node .github/scripts/restore-windows-ci-inputs.mjs\n";
    expect(workflow.split(restore)).toHaveLength(3);
    expect(readFileSync(resolve("scripts/build-windows-path-kind.mjs"), "utf8"))
      .toContain(`binary_sha256=\${binarySha256}\\nreceipt_sha256=\${receiptSha256}\\n`);
  });
});

describe("signing-stable Windows helper image digest", () => {
  const SECURITY = 88 + 112 + 32;
  const withTable = (image: Buffer, start = image.length, size = 16, trailing = 0) => {
    const result = Buffer.concat([image, Buffer.alloc(start - image.length), Buffer.alloc(size, 0x5a), Buffer.alloc(trailing)]);
    result.writeUInt32LE(0xbeef, 88 + 64);
    result.writeUInt32LE(start, SECURITY);
    result.writeUInt32LE(size + trailing, SECURITY + 4);
    return result;
  };

  it("keeps the digest across signing and changes it for any image byte", () => {
    const image = pathKindPe();
    const digest = windowsPeImageDigest(image);
    expect(windowsPeImageDigest(withTable(image))).toBe(digest);
    const checksum = Buffer.from(image);
    checksum.writeUInt32LE(7, 88 + 64);
    expect(windowsPeImageDigest(checksum)).toBe(digest);
    for (const offset of [0x208, 72, 0x3ff]) {
      const changed = Buffer.from(image);
      changed[offset] ^= 1;
      expect(windowsPeImageDigest(changed), String(offset)).not.toBe(digest);
    }
    const unaligned = Buffer.concat([image, Buffer.from([1, 2, 3])]);
    expect(windowsPeImageDigest(withTable(unaligned, image.length + 8))).toBe(windowsPeImageDigest(unaligned));
  });

  it("refuses a certificate table that hides image bytes or does not end the file", () => {
    const image = pathKindPe();
    for (const candidate of [
      (() => { const inside = Buffer.from(image); inside.writeUInt32LE(0x200, SECURITY); inside.writeUInt32LE(0x200, SECURITY + 4); return inside; })(), // covers the section
      withTable(image, image.length + 4), // unaligned
      (() => { const extra = withTable(image); extra.writeUInt32LE(8, SECURITY + 4); return extra; })(), // ends before the file
      Buffer.from("MZ not an image"),
    ]) {
      expect(() => windowsPeImageDigest(candidate)).toThrow("not a PE image");
    }
  });
});

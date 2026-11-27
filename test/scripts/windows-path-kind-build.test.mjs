import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { windowsJobLauncherPath, windowsJobSources } from "../../scripts/prepare-windows-job.mjs";
import { windowsPathKindPath, windowsPathKindReceiptPath, verifyWindowsPathKindReceipt } from "../../scripts/lib/windows-path-kind-build.mjs";
import { pathKindPe } from "../../src/__tests__/support/windows-path-kind-pe.mts";

function pathKindBuildFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ave-windows-job-"));
  const buildTemp = mkdtempSync(join(tmpdir(), "ave cargo temp-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(buildTemp, { recursive: true, force: true });
  });
  const crate = "native/windows-path-kind";
  for (const file of [
    join(crate, "src"), join(crate, "Cargo.toml"), join(crate, "Cargo.lock"), "rust-toolchain.toml",
    "scripts/build-windows-path-kind.mjs", "scripts/lib/windows-path-kind-build.mjs", ...windowsJobSources(process.cwd()),
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(resolve(file), join(root, file), { recursive: true });
  }
  // Keep the real SystemRoot for runtime startup, then spoof it for the build.
  const runScript = (script, code, overrides = {}, args = []) => spawnSync(process.execPath, [
    "--input-type=module", "--eval", `Object.assign(process.env, ${JSON.stringify(overrides)});\n${code}`,
    pathToFileURL(resolve(script)).href, root, ...args,
  ], {
    encoding: "utf8", windowsHide: true,
    env: {
      ...process.env, TMP: buildTemp, TEMP: buildTemp, TMPDIR: buildTemp, AVE_TEST_TMP_ROOT: buildTemp,
    },
  });
  const runBuild = (overrides) => runScript("scripts/build-windows-path-kind.mjs",
    'const {buildWindowsPathKind} = await import(process.argv[1]); buildWindowsPathKind({root: process.argv[2]});',
    overrides);
  const receiptPath = join(root, windowsPathKindReceiptPath(process.arch));
  return { root, crate, runBuild, runScript, receiptPath, buildTemp };
}

describe("Windows path helper build", { skip: process.platform !== "win32" }, () => {
  it("pins discovery and records every build tool before using it", { timeout: 60_000 }, (t) => {
    const { root, runBuild, receiptPath } = pathKindBuildFixture(t);
    const clean = runBuild();
    assert.equal(clean.status, 0, clean.stderr);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const { tools } = receipt.identity.inputs;
    const discovery = tools.find(({ path }) => win32.basename(path) === "vswhere.exe");
    assert.ok(discovery);
    assert.equal(discovery.sha256, createHash("sha256").update(readFileSync(discovery.path)).digest("hex"));

    const hostile = runBuild({ SystemRoot: "Q:\\example", "ProgramFiles(x86)": root, PATH: root });
    assert.equal(hostile.status, 0, hostile.stderr);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")).identity, receipt.identity);
  });

  it("rejects incomplete, duplicated or redirected build input inventories", { timeout: 60_000 }, (t) => {
    const { root, runBuild, receiptPath } = pathKindBuildFixture(t);
    const built = runBuild();
    assert.equal(built.status, 0, built.stderr);
    verifyWindowsPathKindReceipt(root, process.arch);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const { inputs } = receipt.identity;
    for (const list of ["tools", "rustLibraries", "libraries"]) {
      for (let index = 0; index < inputs[list].length; index += 1) {
        const files = inputs[list].filter((_, i) => i !== index);
        writeFileSync(receiptPath, JSON.stringify({
          ...receipt, identity: { ...receipt.identity, inputs: { ...inputs, [list]: files } },
        }));
        assert.throws(() => verifyWindowsPathKindReceipt(root, process.arch), /toolchain identity/u, inputs[list][index].path);
      }
    }
    for (const unexpected of [inputs.tools[0], { ...inputs.tools[0], path: "Q:\\example\\vswhere.exe" }]) {
      writeFileSync(receiptPath, JSON.stringify({
        ...receipt, identity: { ...receipt.identity, inputs: { ...inputs, tools: [...inputs.tools, unexpected] } },
      }));
      assert.throws(() => verifyWindowsPathKindReceipt(root, process.arch), /toolchain identity/u);
    }
  });

  it("seals a real offline Cargo build and verifies its executed compiler command", { timeout: 60_000 }, (t) => {
    const { root, crate, runBuild, receiptPath } = pathKindBuildFixture(t);
    const clean = runBuild();
    assert.equal(clean.status, 0, clean.stderr);
    const cleanReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));

    const cargoHome = join(root, "user cargo home");
    mkdirSync(cargoHome);
    writeFileSync(join(cargoHome, "config.toml"), "[profile.release]\nopt-level = 1\n");
    const changedProfile = runBuild({ CARGO_HOME: cargoHome, CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1" });
    assert.equal(changedProfile.status, 0, changedProfile.stderr);
    assert.ok(changedProfile.stderr.includes("-C opt-level=3"));
    assert.ok(changedProfile.stderr.includes("-C codegen-units=16"));

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
    assert.equal(hostile.status, 0, hostile.stderr);
    verifyWindowsPathKindReceipt(root, process.arch);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(hostile.stderr.match(/^\s*Running `(.+)`\r?$/mu)?.[1], receipt.invocation);
    assert.deepEqual(receipt.identity, cleanReceipt.identity);
    assert.equal(receipt.invocation.replaceAll(receipt.targetDir, "<target>"),
      cleanReceipt.invocation.replaceAll(cleanReceipt.targetDir, "<target>"),
    );
    assert.ok(!receipt.invocation.includes(substitute));

    const manifest = join(root, crate, "Cargo.toml");
    const originalManifest = readFileSync(manifest, "utf8");
    writeFileSync(manifest, `${originalManifest}\n[profile.release.package.ave-path-kind]\nopt-level = 2\n`);
    const unexpectedFlags = runBuild();
    assert.equal(unexpectedFlags.status, 1);
    assert.ok(unexpectedFlags.stderr.includes("-C opt-level=2"));
    assert.ok(unexpectedFlags.stderr.includes("Unexpected Windows path helper compiler invocation"));
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), receipt);
    writeFileSync(manifest, originalManifest);

    writeFileSync(receiptPath, JSON.stringify({ ...receipt, invocation: `${receipt.invocation} -C link-arg=/unexpected` }));
    assert.throws(() => verifyWindowsPathKindReceipt(root, process.arch), /Unexpected Windows path helper compiler invocation/u);

    const parent = join(root, "build parent");
    mkdirSync(join(parent, ".cargo"), { recursive: true });
    writeFileSync(join(parent, ".cargo", "config"), hostileConfig);
    const blocked = runBuild({ TMP: parent, TEMP: parent, TMPDIR: parent, AVE_TEST_TMP_ROOT: parent });
    assert.equal(blocked.status, 1);
    assert.ok(blocked.stderr.includes("Unexpected Cargo config above the Windows path helper build directory"));
  });

  it("isolates the link from crate-local libraries", { timeout: 60_000 }, (t) => {
    const { root, crate, runBuild, receiptPath } = pathKindBuildFixture(t);
    const clean = runBuild();
    assert.equal(clean.status, 0, clean.stderr);
    const executable = join(root, windowsPathKindPath(process.arch));
    const binary = readFileSync(executable);
    const cleanReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));

    writeFileSync(join(root, crate, "libucrt.lib"), "unexpected archive");
    writeFileSync(join(root, "kernel32.lib"), "unexpected archive");
    const shadowed = runBuild();
    assert.equal(shadowed.status, 0, shadowed.stderr);
    assert.deepEqual(readFileSync(executable), binary);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.deepEqual(receipt.identity.inputs, cleanReceipt.identity.inputs);
    assert.ok(receipt.identity.inputs.libraries.some(({ path, sha256 }) =>
      /libucrt\.lib$/iu.test(path) && /^[a-f0-9]{64}$/u.test(sha256)));
    verifyWindowsPathKindReceipt(root, process.arch);
  });

  it("replaces an independently supplied executable even with an authentic recorded command", { timeout: 60_000 }, (t) => {
    const { root, runBuild, runScript, receiptPath, buildTemp } = pathKindBuildFixture(t);
    const launcher = join(root, windowsJobLauncherPath(process.arch));
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "launcher fixture");
    writeFileSync(join(root, windowsJobLauncherPath(process.arch, true)), "policy reader fixture");
    const built = runBuild();
    assert.equal(built.status, 0, built.stderr);
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
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(executable).equals(original), true);
    assert.deepEqual(readdirSync(buildTemp), []);
    verifyWindowsPathKindReceipt(root, process.arch);
  });

  it("gives each test build a private helper and fixture that a second build cannot replace", { timeout: 120_000 }, (t) => {
    const { root, runScript, buildTemp } = pathKindBuildFixture(t);
    const outputs = [mkdtempSync(join(buildTemp, "first-")), mkdtempSync(join(buildTemp, "second-"))];
    const build = (outDir) => {
      const result = runScript("scripts/build-windows-path-kind.mjs",
        "const {buildWindowsPathKind} = await import(process.argv[1]);"
        + "console.log(JSON.stringify(buildWindowsPathKind({root: process.argv[2], fixture: true, outDir: process.argv[3]})));",
        {}, [outDir]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim());
    };
    const first = build(outputs[0]);
    const selected = readFileSync(first.fixture);
    const second = build(outputs[1]);
    assert.deepEqual([first.helper, first.fixture], [join(outputs[0], "ave-path-kind.exe"), join(outputs[0], "ave-path-pin-test.exe")]);
    assert.notEqual(second.fixture, first.fixture);
    assert.equal(readFileSync(first.fixture).equals(selected), true);
    assert.equal(createHash("sha256").update(readFileSync(first.helper)).digest("hex"), first.binarySha256);
    assert.deepEqual(readdirSync(buildTemp).sort(), outputs.map((output) => output.slice(buildTemp.length + 1)).sort());
    assert.equal(existsSync(join(root, windowsPathKindPath(process.arch))), false);
    const nativeTest = readFileSync(resolve("scripts/test-windows-path-kind.mjs"), "utf8");
    assert.ok(nativeTest.includes("buildWindowsPathKind({ root, fixture: true, outDir: output })"));
    assert.ok(!nativeTest.includes("ave-path-pin-test.exe"));
  });

  it("refuses a helper substituted after the runner's build returns", { timeout: 120_000 }, (t) => {
    const { runScript } = pathKindBuildFixture(t);
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
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("Windows test executable does not match the producing build"));
  });

  it("refuses a pin fixture substituted after the builder publishes it", { timeout: 120_000 }, (t) => {
    const { runScript, buildTemp } = pathKindBuildFixture(t);
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
    assert.equal(result.status, 0, result.stderr);
  });

  it("binds the main bundle to fresh output instead of staged executable bytes", { timeout: 60_000 }, (t) => {
    const { root, runScript } = pathKindBuildFixture(t);
    const executable = join(root, windowsPathKindPath(process.arch));
    mkdirSync(dirname(executable), { recursive: true });
    const supplied = pathKindPe();
    writeFileSync(executable, supplied);
    const result = runScript("scripts/build-windows-path-kind.mjs",
      'const {buildWindowsPathKind} = await import(process.argv[1]); console.log(buildWindowsPathKind({root: process.argv[2]}).binarySha256);');
    assert.equal(result.status, 0, result.stderr);
    const built = readFileSync(executable);
    assert.equal(built.equals(supplied), false);
    assert.equal(result.stdout.trim(), createHash("sha256").update(built).digest("hex"));

    const dev = readFileSync(resolve("scripts/run-electron-dev.mjs"), "utf8");
    const bundle = readFileSync(resolve("scripts/build-main-esbuild.mjs"), "utf8");
    assert.ok(dev.includes('spawnWatcher("main", process.execPath, [resolve(repoRoot, "scripts/build-main-esbuild.mjs"), "--watch"])'));
    assert.ok(bundle.includes("pathKindSha256 = buildWindowsPathKind({ root: repoRoot })"));
    assert.ok(bundle.includes('__AVE_WINDOWS_PATH_KIND_SHA256__: pathKindSha256 === null ? "null" : WINDOWS_PATH_KIND_BUNDLE_PIN'));
    assert.ok(bundle.includes("windowsPathKindBundlePinDeclaration(pathKindSha256)"));
  });
});

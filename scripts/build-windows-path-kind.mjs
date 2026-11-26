import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertWindowsPathKindInputDigests, assertWindowsPathKindInvocation, assertWindowsPathKindLinkInputs,
  assertWindowsPathKindMachine, windowsPathKindCompiler,
  windowsPathKindCrateFiles, windowsPathKindHoldFixturePath, windowsPathKindPath,
  windowsPathKindReceipt, windowsPathKindReceiptPath, windowsPathKindSourceDigest, windowsPathKindSystemEnvironment,
} from "./lib/windows-path-kind-build.mjs";
import { windowsPeImageDigest } from "./lib/windows-path-kind-image-digest.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function assertNoCargoConfig(directory) {
  for (let parent = directory; ; parent = dirname(parent)) {
    for (const name of ["config", "config.toml"]) {
      if (lstatSync(join(parent, ".cargo", name), { throwIfNoEntry: false })) {
        throw new Error("Unexpected Cargo config above the Windows path helper build directory");
      }
    }
    if (dirname(parent) === parent) return;
  }
}

/**
 * Builds the helper and returns its digests. With `outDir` the helper and pin fixture go to that private directory.
 * Otherwise the helper and receipt replace the checkout copies. Fixture builds also publish the hold fixture there.
 */
export function buildWindowsPathKind({ root = ROOT, arch = process.arch, fixture = false, outDir } = {}) {
  if (process.platform !== "win32") throw new Error("The Windows path helper requires a Windows build");
  const identity = windowsPathKindCompiler(root, arch);
  const source = windowsPathKindSourceDigest(root);
  const buildDir = mkdtempSync(join(realpathSync(tmpdir()), "ave-path-kind-cargo-"));
  const targetDir = join(buildDir, "target");
  const cargoHome = join(buildDir, "cargo-home");
  const output = (name) => join(targetDir, identity.target, identity.profile, `${name}.exe`);
  try {
    mkdirSync(cargoHome);
    // Cargo runs rustc in the crate directory. Stage only the declared sources there.
    for (const file of windowsPathKindCrateFiles(root)) {
      const destination = join(buildDir, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, file), destination);
    }
    if (windowsPathKindSourceDigest(root, buildDir) !== source) throw new Error("Windows path helper sources changed during staging");
    const env = {
      ...windowsPathKindSystemEnvironment(identity.inputs.systemRoot),
      TEMP: buildDir,
      TMP: buildDir,
      TMPDIR: buildDir,
      CARGO_HOME: cargoHome,
      RUSTC: identity.rustc,
      CARGO_ENCODED_RUSTFLAGS: identity.rustflags.join("\x1f"),
    };
    const profile = Object.entries(identity.profileSettings).flatMap(([key, value]) =>
      ["--config", `profile.${identity.profile}.${key}=${JSON.stringify(value)}`]);
    const cargo = (name, features = []) => {
      // An absolute manifest selects the crate without making its directory the config search root.
      assertNoCargoConfig(buildDir);
      const result = spawnSync(identity.cargo, [
        "build", "-v", "--color", "never", "--locked", "--offline",
        "--profile", identity.profile, ...profile, "--target", identity.target, "--target-dir", targetDir,
        "--manifest-path", join(buildDir, "native/windows-path-kind/Cargo.toml"), "--bin", name, ...features,
      ], { cwd: buildDir, env, encoding: "utf8", windowsHide: true });
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Windows path helper Cargo build failed (exit ${result.status})`);
      const commands = result.stderr.split(/\r?\n/u).filter(line => /^\s*Running\b/u.test(line));
      const match = /^\s*Running `(.+)`$/u.exec(commands[0] ?? "");
      if (commands.length !== 1 || !match) throw new Error("Expected one Windows path helper compiler invocation");
      const build = { identity, targetDir, invocation: match[1] };
      assertWindowsPathKindInvocation(build, name);
      assertWindowsPathKindLinkInputs(result.stdout, identity, buildDir,
        join(targetDir, identity.target, identity.profile, "deps", `${name.replaceAll("-", "_")}.exe`));
      return build;
    };
    const build = cargo("ave-path-kind");
    const binary = readFileSync(output("ave-path-kind"));
    const receipt = windowsPathKindReceipt(root, arch, build, binary);
    let fixtureBytes;
    let holdFixtureBytes;
    if (fixture) {
      cargo("ave-path-pin-test", ["--features", "fixture"]);
      fixtureBytes = readFileSync(output("ave-path-pin-test"));
      assertWindowsPathKindMachine(fixtureBytes, arch);
      if (!outDir) {
        cargo("ave-path-kind-hold-fixture", ["--features", "fixture"]);
        holdFixtureBytes = readFileSync(output("ave-path-kind-hold-fixture"));
        assertWindowsPathKindMachine(holdFixtureBytes, arch);
      }
    }
    if (receipt.sourceSha256 !== source) throw new Error("Windows path helper sources changed during build");
    assertWindowsPathKindInputDigests(identity.inputs);
    const receiptText = `${JSON.stringify(receipt)}\n`;
    const evidence = {
      binarySha256: receipt.binarySha256,
      imageSha256: windowsPeImageDigest(binary),
      receiptSha256: createHash("sha256").update(receiptText).digest("hex"),
    };
    if (outDir) {
      const helper = join(outDir, "ave-path-kind.exe");
      writeFileSync(helper, binary, { flag: "wx" });
      if (!fixtureBytes) return { ...evidence, helper };
      const pinFixture = join(outDir, "ave-path-pin-test.exe");
      const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
      writeFileSync(pinFixture, fixtureBytes, { flag: "wx" });
      return { ...evidence, helper, fixture: pinFixture, fixtureSha256 };
    }
    const exe = join(root, windowsPathKindPath(arch));
    const manifest = join(root, windowsPathKindReceiptPath(arch));
    const holdFixture = join(root, windowsPathKindHoldFixturePath(arch));
    mkdirSync(dirname(exe), { recursive: true });
    const outputs = [[exe, binary], [manifest, receiptText]];
    if (holdFixtureBytes) outputs.push([holdFixture, holdFixtureBytes]);
    const staged = outputs.map(([file, bytes]) => ({ file, bytes, temp: `${file}.${process.pid}.tmp` }));
    try {
      for (const { temp, bytes } of staged) writeFileSync(temp, bytes, { flag: "wx" });
      for (const { temp, file } of staged) renameSync(temp, file);
    } finally {
      for (const { temp } of staged) rmSync(temp, { force: true });
    }
    if (!holdFixtureBytes) return { ...evidence, helper: exe };
    const holdFixtureSha256 = createHash("sha256").update(holdFixtureBytes).digest("hex");
    return { ...evidence, helper: exe, holdFixtureSha256 };
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { arch: { type: "string" }, fixture: { type: "boolean" } } });
  const { binarySha256, receiptSha256, holdFixtureSha256 } = buildWindowsPathKind(values);
  // CI passes these through job outputs to the jobs that restore the uploaded helper.
  if (process.env.GITHUB_OUTPUT) {
    const fixtureOutput = holdFixtureSha256 ? `hold_fixture_sha256=${holdFixtureSha256}\n` : "";
    appendFileSync(process.env.GITHUB_OUTPUT, `binary_sha256=${binarySha256}\nreceipt_sha256=${receiptSha256}\n${fixtureOutput}`);
  }
}

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertWindowsPathKindMachine, windowsPathKindCompiler, windowsPathKindPath,
  windowsPathKindReceipt, windowsPathKindReceiptPath, windowsPathKindSourceDigest,
} from "./lib/windows-path-kind-build.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CARGO_COMPILER_ENV = /^(?:(?:CARGO_BUILD_)?RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?|CARGO_ENCODED_RUSTFLAGS)$/iu;

export function buildWindowsPathKind({ root = ROOT, arch = process.arch, fixture = false } = {}) {
  if (process.platform !== "win32") throw new Error("The Windows path helper requires a Windows build");
  const { executable, identity } = windowsPathKindCompiler(root, arch);
  const source = windowsPathKindSourceDigest(root);
  const targetDir = mkdtempSync(join(tmpdir(), "ave-path-kind-cargo-"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !CARGO_COMPILER_ENV.test(key))),
    RUSTC: executable,
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
    CARGO_ENCODED_RUSTFLAGS: identity.rustflags,
  };
  const cargo = (name, features = []) => execFileSync("rustup", [
    "run", identity.toolchain, "cargo", "build", "--locked", "--offline",
    "--profile", identity.profile, "--target", identity.target, "--target-dir", targetDir,
    "--manifest-path", "native/windows-path-kind/Cargo.toml", "--bin", name, ...features,
  ], { cwd: root, env, stdio: "inherit", windowsHide: true });
  const output = (name) => join(targetDir, identity.target, identity.profile, `${name}.exe`);
  try {
    cargo("ave-path-kind");
    const binary = readFileSync(output("ave-path-kind"));
    const receipt = windowsPathKindReceipt(root, arch, identity, binary);
    if (fixture) {
      cargo("ave-path-pin-test", ["--features", "fixture"]);
      const test = output("ave-path-pin-test");
      assertWindowsPathKindMachine(readFileSync(test), arch);
      copyFileSync(test, join(tmpdir(), "ave-path-pin-test.exe"));
    }
    if (receipt.sourceSha256 !== source) throw new Error("Windows path helper sources changed during build");
    const exe = join(root, windowsPathKindPath(arch));
    const manifest = join(root, windowsPathKindReceiptPath(arch));
    mkdirSync(dirname(exe), { recursive: true });
    const staged = [`${exe}.${process.pid}.tmp`, `${manifest}.${process.pid}.tmp`];
    try {
      writeFileSync(staged[0], binary, { flag: "wx" });
      writeFileSync(staged[1], `${JSON.stringify(receipt)}\n`, { flag: "wx" });
      renameSync(staged[0], exe);
      renameSync(staged[1], manifest);
    } finally {
      for (const file of staged) rmSync(file, { force: true });
    }
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { arch: { type: "string" }, fixture: { type: "boolean" } } });
  buildWindowsPathKind(values);
}

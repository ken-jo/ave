import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CRATE = "native/windows-path-kind";
const TARGETS = { x64: ["x86_64-pc-windows-msvc", 0x8664], arm64: ["aarch64-pc-windows-msvc", 0xaa64] };
export const WINDOWS_PATH_KIND_PROFILE = "release";
export const WINDOWS_PATH_KIND_RUSTFLAGS = "-C\x1ftarget-feature=+crt-static";

export function windowsPathKindToolchain(root) {
  const version = /^channel = "(\d+\.\d+\.\d+)"$/mu.exec(readFileSync(join(root, "rust-toolchain.toml"), "utf8"))?.[1];
  if (!version) throw new Error("Expected a pinned Rust toolchain");
  return version;
}

export function windowsPathKindTarget(arch) {
  if (!Object.hasOwn(TARGETS, arch)) throw new Error("Unsupported Windows path helper architecture");
  return TARGETS[arch][0];
}

export function windowsPathKindCompiler(root, arch) {
  const toolchain = windowsPathKindToolchain(root);
  const target = windowsPathKindTarget(arch);
  // Use only an installed compiler. The rustup proxy can install a missing toolchain.
  const compiler = execFileSync("rustup", ["run", toolchain, "rustc", "-vV"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  if (!compiler.split(/\r?\n/u).includes(`release: ${toolchain}`)) throw new Error("Rust compiler does not match the pinned release");
  return { toolchain, compiler, target, profile: WINDOWS_PATH_KIND_PROFILE, rustflags: WINDOWS_PATH_KIND_RUSTFLAGS };
}

export function windowsPathKindPath(arch) {
  return join("resources", "windows-path-kind", arch, "ave-path-kind.exe");
}

export function windowsPathKindReceiptPath(arch) {
  return `${windowsPathKindPath(arch)}.build.json`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function windowsPathKindSourceDigest(root) {
  const paths = [
    "rust-toolchain.toml", "scripts/build-windows-path-kind.mjs", "scripts/lib/windows-path-kind-build.mjs",
    `${CRATE}/Cargo.toml`, `${CRATE}/Cargo.lock`,
  ];
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".rs")) paths.push(file);
    }
  };
  walk(`${CRATE}/src`);
  return sha256(JSON.stringify(paths.sort().map(file => [file, sha256(readFileSync(join(root, file)))])));
}

export function assertWindowsPathKindMachine(bytes, arch) {
  windowsPathKindTarget(arch);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
  if (pe < 64 || pe + 26 > bytes.length || bytes.readUInt16LE(0) !== 0x5a4d
    || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== TARGETS[arch][1]
    || bytes.readUInt16LE(pe + 24) !== 0x20b) {
    throw new Error(`Windows path helper is not a ${arch} PE32+ executable`);
  }
}

export function windowsPathKindReceipt(root, arch, identity, binary) {
  assertWindowsPathKindMachine(binary, arch);
  return { identity, sourceSha256: windowsPathKindSourceDigest(root), binarySha256: sha256(binary) };
}

export function verifyWindowsPathKindBuild(root, arch) {
  const binary = readFileSync(join(root, windowsPathKindPath(arch)));
  const receipt = JSON.parse(readFileSync(join(root, windowsPathKindReceiptPath(arch)), "utf8"));
  const pinned = windowsPathKindToolchain(root);
  const identity = receipt.identity;
  if (identity?.toolchain !== pinned || identity.target !== windowsPathKindTarget(arch)
    || identity.profile !== WINDOWS_PATH_KIND_PROFILE || identity.rustflags !== WINDOWS_PATH_KIND_RUSTFLAGS
    || typeof identity.compiler !== "string" || !identity.compiler.split(/\r?\n/u).includes(`release: ${pinned}`)) {
    throw new Error("Windows path helper toolchain identity changed");
  }
  const current = windowsPathKindReceipt(root, arch, identity, binary);
  if (receipt.sourceSha256 !== current.sourceSha256 || receipt.binarySha256 !== current.binarySha256) {
    throw new Error("Windows path helper build inputs or binary changed");
  }
}

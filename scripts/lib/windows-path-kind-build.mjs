import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const CRATE = "native/windows-path-kind";
const TARGETS = { x64: ["x86_64-pc-windows-msvc", 0x8664], arm64: ["aarch64-pc-windows-msvc", 0xaa64] };
const IMPORT_DIRECTORIES = [
  { index: 1, descriptorSize: 20, nameOffset: 12 },
  { index: 13, descriptorSize: 32, nameOffset: 4 },
];
const CRT_DLL = /^(?:api-ms-win-crt-|ext-ms-win-crt-|ucrtbase|msvcr|msvcp|vcruntime|concrt|vccorlib)[^.]*\.dll$/iu;
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
  const options = { cwd: root, encoding: "utf8", windowsHide: true };
  const executable = execFileSync("rustup", ["which", "--toolchain", toolchain, "rustc"], options).trim();
  if (!isAbsolute(executable)) throw new Error("Expected an absolute path to the pinned Rust compiler");
  const compiler = execFileSync(executable, ["-vV"], options).trim();
  if (!compiler.split(/\r?\n/u).includes(`release: ${toolchain}`)) throw new Error("Rust compiler does not match the pinned release");
  return { executable, identity: { toolchain, compiler, target, profile: WINDOWS_PATH_KIND_PROFILE, rustflags: WINDOWS_PATH_KIND_RUSTFLAGS } };
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

function assertStaticCrt(bytes) {
  const pe = bytes.readUInt32LE(60);
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const sections = optional + optionalSize;
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const invalid = () => new Error("Invalid Windows path helper PE import table");
  if (optionalSize < 112 || sections + 40 * sectionCount > bytes.length) throw invalid();
  const directoryCount = bytes.readUInt32LE(optional + 108);
  if (112 + 8 * directoryCount > optionalSize) throw invalid();

  const dataAtRva = (rva) => {
    for (let section = sections; section < sections + 40 * sectionCount; section += 40) {
      const relative = rva - bytes.readUInt32LE(section + 12);
      const size = bytes.readUInt32LE(section + 16);
      const start = bytes.readUInt32LE(section + 20);
      if (relative < 0 || relative >= size) continue;
      if (start === 0 || start + size > bytes.length) throw invalid();
      return bytes.subarray(start + relative, start + size);
    }
    throw invalid();
  };

  for (const { index, descriptorSize, nameOffset } of IMPORT_DIRECTORIES) {
    if (index >= directoryCount) continue;
    const directory = optional + 112 + 8 * index;
    const rva = bytes.readUInt32LE(directory);
    const size = bytes.readUInt32LE(directory + 4);
    if (rva === 0 && size === 0) continue;
    if (rva === 0 || size < descriptorSize) throw invalid();
    const table = dataAtRva(rva);
    if (size > table.length) throw invalid();
    let offset = 0;
    for (; offset + descriptorSize <= size; offset += descriptorSize) {
      const descriptor = table.subarray(offset, offset + descriptorSize);
      if (descriptor.every((byte) => byte === 0)) break;
      const nameRva = descriptor.readUInt32LE(nameOffset);
      // The delay-load descriptor must use RVAs.
      if (nameRva === 0 || (index === 13 && descriptor.readUInt32LE(0) !== 1)) throw invalid();
      const name = dataAtRva(nameRva);
      const end = name.indexOf(0);
      if (end <= 0) throw invalid();
      const dll = name.toString("latin1", 0, end);
      if (CRT_DLL.test(dll)) throw new Error(`Windows path helper imports a dynamic CRT: ${dll}`);
    }
    if (offset + descriptorSize > size) throw invalid();
  }
}

export function windowsPathKindReceipt(root, arch, identity, binary) {
  assertWindowsPathKindMachine(binary, arch);
  assertStaticCrt(binary);
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

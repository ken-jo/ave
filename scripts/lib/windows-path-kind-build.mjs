import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

const CRATE = "native/windows-path-kind";
const TARGETS = { x64: ["x86_64-pc-windows-msvc", 0x8664], arm64: ["aarch64-pc-windows-msvc", 0xaa64] };
const IMPORT_DIRECTORIES = [
  { index: 1, descriptorSize: 20, nameOffset: 12 },
  { index: 13, descriptorSize: 32, nameOffset: 4 },
];
const CRT_DLL = /^(?:api-ms-win-crt-|ext-ms-win-crt-|ucrtbase|msvcr|msvcp|vcruntime|concrt|vccorlib)[^.]*\.dll$/iu;
export const WINDOWS_PATH_KIND_PROFILE = "release";
export const WINDOWS_PATH_KIND_PROFILE_SETTINGS = Object.freeze({
  "opt-level": 3,
  debug: false,
  "split-debuginfo": "off",
  strip: "debuginfo",
  "debug-assertions": false,
  "overflow-checks": false,
  lto: false,
  panic: "unwind",
  incremental: false,
  "codegen-units": 16,
  rpath: false,
});

export function windowsPathKindToolPaths(rustupRoot, toolchain, host) {
  const installation = win32.join(rustupRoot, "toolchains", [toolchain, host].join("-"));
  return {
    rustc: win32.join(installation, "bin", "rustc.exe"),
    cargo: win32.join(installation, "bin", "cargo.exe"),
    linker: win32.join(installation, "lib", "rustlib", host, "bin", "rust-lld.exe"),
  };
}

function isFullyQualifiedWindowsPath(value) {
  return typeof value === "string" && win32.isAbsolute(value) && win32.parse(value).root.length > 1;
}

export function windowsPathKindSystemEnvironment() {
  const { SystemRoot } = process.env;
  if (!isFullyQualifiedWindowsPath(SystemRoot)) throw new Error("Missing Windows system directory");
  return {
    SystemRoot,
    SystemDrive: win32.parse(SystemRoot).root.slice(0, -1),
    WINDIR: SystemRoot,
    PATH: win32.join(SystemRoot, "System32"),
    // Empty values suppress the process launcher's automatic environment inheritance.
    HOMEDRIVE: "", HOMEPATH: "", LOGONSERVER: "", USERDOMAIN: "", USERNAME: "", USERPROFILE: "", TEMP: "",
  };
}

export function windowsPathKindRustflags(linker) {
  return ["-C", "target-feature=+crt-static", "-C", `linker=${linker}`, "-C", "linker-flavor=lld-link"];
}

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
  const host = windowsPathKindTarget(process.arch);
  const rustupRoot = realpathSync(join(userInfo().homedir, ".rustup"));
  const tools = windowsPathKindToolPaths(rustupRoot, toolchain, host);
  for (const executable of Object.values(tools)) {
    if (realpathSync(executable).toLowerCase() !== executable.toLowerCase()) {
      throw new Error("Rust build tool is outside the pinned installation");
    }
  }
  const compiler = execFileSync(tools.rustc, ["-vV"], {
    cwd: dirname(tools.rustc), env: windowsPathKindSystemEnvironment(), encoding: "utf8", windowsHide: true,
  }).trim();
  if (!matchesCompiler(compiler, toolchain, host)) throw new Error("Rust compiler does not match the pinned release and host");
  return {
    toolchain, compiler, host, target, rustupRoot, ...tools, profile: WINDOWS_PATH_KIND_PROFILE,
    profileSettings: WINDOWS_PATH_KIND_PROFILE_SETTINGS, rustflags: windowsPathKindRustflags(tools.linker),
  };
}

function matchesCompiler(compiler, toolchain, host) {
  if (typeof compiler !== "string") return false;
  const lines = compiler.split(/\r?\n/u);
  return lines.includes(`release: ${toolchain}`) && lines.includes(`host: ${host}`);
}

export function windowsPathKindCompilerCommand(identity, targetDir, metadata, fixture = false) {
  const { target, profile, rustc, rustflags, profileSettings } = identity;
  const deps = win32.join(targetDir, target, profile, "deps");
  const args = [
    rustc, "--crate-name", fixture ? "ave_path_pin_test" : "ave_path_kind",
    "--edition=2024", fixture ? "src\\fixture.rs" : "src\\main.rs",
    "--error-format=json", "--json=diagnostic-rendered-ansi,artifacts,future-incompat",
    "--crate-type", "bin", "--emit=dep-info,link",
    "-C", `opt-level=${profileSettings["opt-level"]}`, "-C", "embed-bitcode=no",
    "-C", `codegen-units=${profileSettings["codegen-units"]}`,
    ...(fixture ? ["--cfg", 'feature="fixture"'] : []),
    "--check-cfg", "cfg(docsrs,test)", "--check-cfg", 'cfg(feature, values("fixture"))',
    "-C", `metadata=${metadata}`, "--out-dir", deps, "--target", target,
    "-C", `strip=${profileSettings.strip}`,
    "-L", `dependency=${deps}`, "-L", `dependency=${win32.join(targetDir, profile, "deps")}`,
    ...rustflags,
  ];
  // Match the pinned build driver's Windows display of argument boundaries.
  return args.map(arg => /[\s"]/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg).join(" ");
}

export function assertWindowsPathKindInvocation({ identity, invocation, targetDir }, fixture = false) {
  const metadata = typeof invocation === "string" && / -C metadata=([a-f0-9]{16}) /u.exec(invocation)?.[1];
  if (!metadata || !isFullyQualifiedWindowsPath(targetDir)
    || invocation !== windowsPathKindCompilerCommand(identity, targetDir, metadata, fixture)) {
    throw new Error("Unexpected Windows path helper compiler invocation");
  }
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
      if (CRT_DLL.test(win32.basename(dll))) throw new Error(`Windows path helper imports a dynamic CRT: ${dll}`);
    }
    if (offset + descriptorSize > size) throw invalid();
  }
}

export function windowsPathKindReceipt(root, arch, build, binary) {
  assertWindowsPathKindMachine(binary, arch);
  assertStaticCrt(binary);
  assertWindowsPathKindInvocation(build);
  const { identity, invocation, targetDir } = build;
  return { identity, invocation, targetDir, sourceSha256: windowsPathKindSourceDigest(root), binarySha256: sha256(binary) };
}

export function verifyWindowsPathKindBuild(root, arch) {
  const binary = readFileSync(join(root, windowsPathKindPath(arch)));
  const receipt = JSON.parse(readFileSync(join(root, windowsPathKindReceiptPath(arch)), "utf8"));
  const pinned = windowsPathKindToolchain(root);
  const { identity, invocation, targetDir } = receipt;
  if (identity?.toolchain !== pinned || identity.target !== windowsPathKindTarget(arch)
    || !Object.values(TARGETS).some(([target]) => target === identity.host)
    || !isFullyQualifiedWindowsPath(identity.rustupRoot)
    || identity.profile !== WINDOWS_PATH_KIND_PROFILE || !isDeepStrictEqual(identity.profileSettings, WINDOWS_PATH_KIND_PROFILE_SETTINGS)
    || !matchesCompiler(identity.compiler, pinned, identity.host)) {
    throw new Error("Windows path helper toolchain identity changed");
  }
  const tools = windowsPathKindToolPaths(identity.rustupRoot, pinned, identity.host);
  if (Object.entries(tools).some(([name, executable]) => identity[name] !== executable)
    || !isDeepStrictEqual(identity.rustflags, windowsPathKindRustflags(tools.linker))) {
    throw new Error("Windows path helper toolchain identity changed");
  }
  const current = windowsPathKindReceipt(root, arch, { identity, invocation, targetDir }, binary);
  if (receipt.sourceSha256 !== current.sourceSha256 || receipt.binarySha256 !== current.binarySha256) {
    throw new Error("Windows path helper build inputs or binary changed");
  }
}

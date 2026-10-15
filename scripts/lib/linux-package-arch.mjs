/**
 * Architecture audit for a packaged Linux app and its installers.
 *
 * Linux installers are cross-built (x64 on the ARM64 release runners), so a
 * host-arch native binary that slips into the package is a broken install
 * that nothing else fails on: the build host cannot launch an x64 app to
 * smoke it. This walks every regular file, reads the ELF header itself
 * (EI_CLASS/EI_DATA/e_machine), and cross-checks each ELF and every `.node`
 * with `file(1)` so the verdict does not rest on one parser.
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";

// e_machine values from the System V ABI (elf.h): EM_X86_64 = 62, EM_AARCH64 = 183.
const LINUX_ARCH_SPECS = Object.freeze({
  x64: Object.freeze({ machine: 62, filePattern: /\bx86-64\b/u, debArch: "amd64", rpmArch: "x86_64", uvDir: "linux-x64" }),
  arm64: Object.freeze({ machine: 183, filePattern: /\bARM aarch64\b/u, debArch: "arm64", rpmArch: "aarch64", uvDir: "linux-arm64" }),
});

const MACHINE_NAMES = { 3: "x86", 40: "arm", 62: "x86-64", 183: "aarch64" };

export function archSpec(arch) {
  const spec = LINUX_ARCH_SPECS[arch];
  if (!spec) throw new Error(`unsupported Linux package arch '${arch}' (expected ${Object.keys(LINUX_ARCH_SPECS).join(" or ")})`);
  return spec;
}

/** Parse an ELF identification + e_machine from the first bytes of a file, or null when it is not ELF. */
export function parseElfHeader(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return null;
  const elfClass = bytes[4] === 1 ? 32 : bytes[4] === 2 ? 64 : null;
  const littleEndian = bytes[5] === 1 ? true : bytes[5] === 2 ? false : null;
  if (elfClass === null || littleEndian === null) return { valid: false, elfClass, littleEndian, machine: null };
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const machine = littleEndian ? view.readUInt16LE(18) : view.readUInt16BE(18);
  return { valid: true, elfClass, littleEndian, machine };
}

export function describeMachine(header) {
  if (!header) return "not ELF";
  if (!header.valid) return "malformed ELF";
  return `${MACHINE_NAMES[header.machine] ?? `e_machine ${header.machine}`} (${header.elfClass}-bit ${header.littleEndian ? "LE" : "BE"})`;
}

/**
 * node-gyp's header cache for the cross node-pty build: under the workspace's
 * `.cache/` with the job's other caches, not the runner user's ~/.cache/node-gyp.
 */
export function nodeGypHeadersDir(workspaceRoot) {
  return join(workspaceRoot, ".cache", "node-gyp");
}

export function crossNodeGypRebuildArgs(nodeGypScript, gypArch, workspaceRoot) {
  return [nodeGypScript, "rebuild", `--arch=${gypArch}`, `--devdir=${nodeGypHeadersDir(workspaceRoot)}`];
}

/**
 * Under Electron (the unit-test runner) `fs` treats `app.asar` as a directory;
 * this audit walks the real files, so asar redirection is off while it runs.
 */
function withoutAsar(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

function headerMatches(header, spec) {
  return Boolean(header?.valid && header.elfClass === 64 && header.littleEndian && header.machine === spec.machine);
}

function readHead(path, length = 64, position = 0) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Scratch space: the job's RUNNER_TEMP on Actions, else the OS temp dir. */
function scratchDir(prefix) {
  return mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), prefix));
}

const SQUASHFS_MAGIC = "hsqs";

/**
 * Byte offset of the squashfs payload in a type-2 AppImage: the end of the
 * runtime ELF, taken as e_shoff + e_shentsize * e_shnum (the section header
 * table is the last thing in the runtime). This is the calculation the
 * AppImage runtime itself uses for `--appimage-offset` (get_elf_size() in
 * AppImageKit/type2-runtime runtime.c, appimage_get_elf_size() in
 * libappimage). Returns null when the runtime is not a 64-bit LE ELF.
 */
export function appImagePayloadOffset(head) {
  const header = parseElfHeader(head);
  if (!header?.valid || header.elfClass !== 64 || !header.littleEndian || head.length < 64) return null;
  const view = Buffer.from(head.buffer, head.byteOffset, head.length);
  const shoff = Number(view.readBigUInt64LE(0x28));
  return shoff + view.readUInt16LE(0x3a) * view.readUInt16LE(0x3c);
}

function unsquashfs(exec, appImage, offset, dest) {
  try {
    // -o skips the runtime; unsquashfs only reads the image, it never runs it.
    exec("unsquashfs", ["-no-progress", "-no-xattrs", "-o", String(offset), "-d", dest, appImage], { stdio: ["ignore", "ignore", "inherit"] });
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`unsquashfs not found on PATH: auditing the AppImage payload of ${basename(appImage)} needs squashfs-tools`);
    }
    throw err;
  }
}

/** Every regular file below `root`; symlinks are recorded, never followed. */
function walkRegularFiles(root) {
  const files = [];
  const symlinks = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) symlinks.push(path);
      else if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile()) files.push({ path, mode: stat.mode });
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), symlinks: symlinks.sort() };
}

function defaultFileCommand(path) {
  return execFileSync("file", ["-b", path], { encoding: "utf8" }).trim();
}

/** App roots: directories that hold `resources/app.asar` (linux-unpacked, /opt/<Product> inside a deb/rpm). */
function findAppRoots(root) {
  const roots = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (existsSync(join(dir, "resources", "app.asar"))) roots.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "app.asar.unpacked") stack.push(join(dir, entry.name));
    }
  }
  return roots.sort();
}

/**
 * Audit one extracted tree. Returns `{ violations, checked }`: `checked` lists
 * every file `file(1)` was run on, with its output, for the job log.
 */
export function auditTree(root, arch, options = {}) {
  return withoutAsar(() => auditTreeUnchecked(root, arch, options));
}

function auditTreeUnchecked(root, arch, { fileCommand = defaultFileCommand, label = root } = {}) {
  const spec = archSpec(arch);
  const violations = [];
  const checked = [];
  const scratch = scratchDir("ave-arch-audit-");
  try {
    const appRoots = findAppRoots(root);
    if (appRoots.length !== 1) {
      violations.push(`${label}: expected exactly one app root holding resources/app.asar, found ${appRoots.length}`);
    }

    const { files } = walkRegularFiles(root);
    const crossCheck = (path, shownAs) => {
      let output;
      try {
        output = fileCommand(path);
      } catch (err) {
        violations.push(`${shownAs}: file(1) failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      checked.push({ path: shownAs, file: output });
      if (!spec.filePattern.test(output)) violations.push(`${shownAs}: file(1) does not report ${arch}: ${output}`);
    };

    let nodeAddons = 0;
    for (const { path } of files) {
      const shown = `${label}/${relative(root, path)}`;
      const header = parseElfHeader(readHead(path));
      const isAddon = path.endsWith(".node");
      if (isAddon) nodeAddons += 1;
      if (header) {
        if (!headerMatches(header, spec)) violations.push(`${shown}: ELF is ${describeMachine(header)}, expected ${arch}`);
        crossCheck(path, shown);
      } else if (isAddon) {
        violations.push(`${shown}: native addon is not a Linux ELF shared object`);
        crossCheck(path, shown);
      }
      // uv ships gzip-compressed and is materialized at first launch; the
      // compressed archive must hold the target-arch binary too.
      if (basename(path) === "uv.gz") {
        if (basename(join(path, "..")) !== spec.uvDir) violations.push(`${shown}: uv runtime directory is not ${spec.uvDir}`);
        const inflated = join(scratch, `uv-${checked.length}`);
        try {
          writeFileSync(inflated, gunzipSync(readFileSync(path)));
        } catch (err) {
          violations.push(`${shown}: cannot gunzip: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const uvHeader = parseElfHeader(readHead(inflated));
        if (!headerMatches(uvHeader, spec)) violations.push(`${shown} (inflated): ELF is ${describeMachine(uvHeader)}, expected ${arch}`);
        crossCheck(inflated, `${shown} (inflated)`);
      }
    }
    if (nodeAddons === 0) violations.push(`${label}: no packaged .node native addon found`);

    // The main executable sits at the app root next to resources/: at least
    // one root-level ELF executable must exist (and was checked above).
    for (const appRoot of appRoots) {
      const rootElves = files.filter(({ path, mode }) =>
        join(path, "..") === appRoot && (mode & 0o111) !== 0 && !/\.so(\.\d+)*$/u.test(path) && parseElfHeader(readHead(path)));
      if (rootElves.length === 0) violations.push(`${label}/${relative(root, appRoot)}: no executable ELF main binary at the app root`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { violations, checked };
}

/** Find the electron-builder intermediate dir for one Linux arch (`linux-unpacked` is x64). */
function unpackedDirFor(releaseDir, arch) {
  const name = arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`;
  return join(releaseDir, name);
}

function installerFiles(releaseDir) {
  const names = readdirSync(releaseDir);
  return {
    appImage: names.filter((name) => name.endsWith(".AppImage")).map((name) => join(releaseDir, name)),
    deb: names.filter((name) => name.endsWith(".deb")).map((name) => join(releaseDir, name)),
    rpm: names.filter((name) => name.endsWith(".rpm")).map((name) => join(releaseDir, name)),
  };
}

/**
 * Audit the unpacked app and, with `requireInstallers`, exactly one AppImage,
 * deb and rpm: their declared arch (runtime ELF, package metadata), then
 * every installer's extracted payload.
 */
export function auditLinuxRelease(releaseDir, arch, options = {}) {
  return withoutAsar(() => auditLinuxReleaseUnchecked(releaseDir, arch, options));
}

function auditLinuxReleaseUnchecked(releaseDir, arch, { requireInstallers = false, fileCommand = defaultFileCommand, exec = execFileSync } = {}) {
  const spec = archSpec(arch);
  const violations = [];
  const checked = [];
  const merge = (result) => {
    violations.push(...result.violations);
    checked.push(...result.checked);
  };

  const unpacked = unpackedDirFor(releaseDir, arch);
  const otherUnpacked = readdirSync(releaseDir).filter((name) => /^linux(-.+)?-unpacked$/u.test(name) && join(releaseDir, name) !== unpacked);
  if (otherUnpacked.length > 0) violations.push(`unexpected unpacked output for another arch: ${otherUnpacked.join(", ")}`);
  if (!existsSync(unpacked)) violations.push(`unpacked app missing: ${unpacked}`);
  else merge(auditTree(unpacked, arch, { fileCommand, label: basename(unpacked) }));

  if (!requireInstallers) return { violations, checked };

  const installers = installerFiles(releaseDir);
  for (const [kind, paths] of Object.entries(installers)) {
    if (paths.length !== 1) violations.push(`expected exactly one ${kind} installer, found ${paths.length}`);
  }

  // `unpack(dir)` writes the payload into `dir`, or into `join(dir, tree)`
  // when the extractor must create its destination itself (unsquashfs -d).
  const extract = (installer, unpack, tree = ".") => {
    const dir = scratchDir("ave-installer-audit-");
    try {
      unpack(dir);
      merge(auditTree(join(dir, tree), arch, { fileCommand, label: basename(installer) }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const extractDeclared = (installer, declaredArch, expected, unpack) => {
    if (declaredArch !== expected) violations.push(`${basename(installer)}: declares arch '${declaredArch}', expected '${expected}'`);
    extract(installer, unpack);
  };

  for (const appImage of installers.appImage) {
    // The AppImage is its ELF runtime (which decides where it can run)
    // followed by a squashfs of the app tree, extracted and audited like the
    // deb/rpm payloads below.
    const head = readHead(appImage);
    const header = parseElfHeader(head);
    if (!headerMatches(header, spec)) violations.push(`${basename(appImage)}: AppImage runtime is ${describeMachine(header)}, expected ${arch}`);
    const output = fileCommand(appImage);
    checked.push({ path: basename(appImage), file: output });
    if (!spec.filePattern.test(output)) violations.push(`${basename(appImage)}: file(1) does not report ${arch}: ${output}`);

    const offset = appImagePayloadOffset(head);
    const magic = offset === null ? "" : readHead(appImage, SQUASHFS_MAGIC.length, offset).toString("latin1");
    if (magic !== SQUASHFS_MAGIC) {
      violations.push(`${basename(appImage)}: no squashfs payload at the end of the runtime ELF (offset ${offset ?? "unreadable"})`);
      continue;
    }
    extract(appImage, (dir) => unsquashfs(exec, appImage, offset, join(dir, "root")), "root");
  }
  for (const deb of installers.deb) {
    const declared = String(exec("dpkg-deb", ["-f", deb, "Architecture"], { encoding: "utf8" })).trim();
    extractDeclared(deb, declared, spec.debArch, (dir) => exec("dpkg-deb", ["-x", deb, dir]));
  }
  for (const rpm of installers.rpm) {
    const declared = String(exec("rpm", ["-qp", "--qf", "%{ARCH}", rpm], { encoding: "utf8" })).trim();
    extractDeclared(rpm, declared, spec.rpmArch, (dir) =>
      exec("sh", ["-c", 'rpm2cpio "$1" | cpio -idm --quiet', "sh", rpm], { cwd: dir }));
  }
  return { violations, checked };
}

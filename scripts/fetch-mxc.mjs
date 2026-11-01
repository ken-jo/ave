// Stage the per-architecture launcher and the selected SDK addon.
// Verify archive integrity and pinned launcher hashes; keep an already matching binary.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Boot and packaging verify the launcher against the same pins.
const PINS = JSON.parse(await readFile(path.join(PROJECT_ROOT, "src", "permissions", "mxc-launcher-pins.json"), "utf8"));
export const MXC_PACKAGE_VERSION = PINS.version;
const TARBALL_URL = `https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-${MXC_PACKAGE_VERSION}.tgz`;
const TARBALL_SHA512_BASE64 = PINS.tarballSha512Base64;
export const WXC_EXEC_SHA256 = Object.freeze({ ...PINS.wxcExecSha256 });
const LICENSE_SHA256 = PINS.licenseSha256;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// postinstall stages the launcher for the host arch on Windows only, so a dev checkout runs MXC tests like CI.
export function currentMxcArch(platform = process.platform, arch = process.arch) {
  if (platform !== "win32") return null;
  if (!Object.hasOwn(WXC_EXEC_SHA256, arch)) throw new Error(`fetch-mxc: no pinned launcher for win32-${arch}`);
  return arch;
}

function parseArgs(argv) {
  let arch;
  let tarball;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--arch") arch = argv[++i];
    else if (arg === "--current") arch = currentMxcArch() ?? "";
    else if (arg === "--tarball") tarball = argv[++i];
    else throw new Error(`fetch-mxc: unknown argument ${arg}`);
  }
  if (!Object.hasOwn(WXC_EXEC_SHA256, arch ?? "")) {
    throw new Error(`fetch-mxc: --arch must be one of ${Object.keys(WXC_EXEC_SHA256).join(", ")}`);
  }
  return { arch, tarball };
}

async function tarballBytes(localPath) {
  if (localPath) return await readFile(localPath);
  const response = await fetch(TARBALL_URL);
  if (!response.ok) throw new Error(`fetch-mxc: ${TARBALL_URL} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function stageMxcLauncher({ arch, tarball, projectRoot = PROJECT_ROOT }) {
  const expected = WXC_EXEC_SHA256[arch];
  const target = path.join(projectRoot, "resources", "mxc", arch, "wxc-exec.exe");
  const licensePath = path.join(projectRoot, "resources", "licenses", "mxc", "LICENSE.md");
  if (sha256(await readFile(licensePath)) !== LICENSE_SHA256) {
    throw new Error(`fetch-mxc: ${licensePath} differs from the MIT license shipped in mxc-sdk ${MXC_PACKAGE_VERSION}`);
  }
  if (existsSync(target) && sha256(await readFile(target)) === expected) return target;

  const bytes = await tarballBytes(tarball);
  const integrity = createHash("sha512").update(bytes).digest("base64");
  if (integrity !== TARBALL_SHA512_BASE64) {
    throw new Error(`fetch-mxc: mxc-sdk ${MXC_PACKAGE_VERSION} tarball integrity mismatch`);
  }
  const work = await mkdtemp(path.join(tmpdir(), "ave-mxc-"));
  try {
    await writeFile(path.join(work, "mxc.tgz"), bytes);
    const member = `package/bin/${arch}/wxc-exec.exe`;
    // Relative paths work with both supported tar implementations.
    execFileSync("tar", ["-xzf", "mxc.tgz", member], { cwd: work, stdio: "inherit" });
    const extracted = path.join(work, ...member.split("/"));
    if (sha256(await readFile(extracted)) !== expected) {
      throw new Error(`fetch-mxc: ${member} sha256 mismatch`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(extracted, target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return target;
}

// Cross-architecture packaging cannot assume optional addons for the target
// were installed on the build host. Stage only a missing target; refuse drift.
export async function stageMxcSdkAddon({ arch, tarball, projectRoot = PROJECT_ROOT }) {
  const pin = PINS.sdk.addons[arch];
  if (!pin) throw new Error("fetch-mxc: unsupported SDK addon architecture");
  const modules = path.join(projectRoot, "node_modules");
  const target = path.join(modules, ...pin.package.split("/"));
  const prefix = pin.package + "/";
  const files = Object.entries(PINS.sdk.architectures[arch]).filter(([name]) => name.startsWith(prefix));
  const verify = async (directory) => {
    for (const [name, expected] of files) {
      if (sha256(await readFile(path.join(directory, name.slice(prefix.length)))) !== expected) {
        throw new Error("fetch-mxc: SDK addon hash mismatch");
      }
    }
  };
  if (existsSync(target)) { await verify(target); return target; }
  const archive = tarball ? await readFile(tarball) : await (async () => {
    const name = pin.package.split("/")[1];
    const url = "https://registry.npmjs.org/" + pin.package + "/-/" + name + "-" + pin.version + ".tgz";
    const response = await fetch(url);
    if (!response.ok) throw new Error("fetch-mxc: SDK addon archive unavailable");
    return Buffer.from(await response.arrayBuffer());
  })();
  if (createHash("sha512").update(archive).digest("base64") !== pin.tarballSha512Base64) {
    throw new Error("fetch-mxc: SDK addon tarball integrity mismatch");
  }
  const work = await mkdtemp(path.join(tmpdir(), "ave-mxc-addon-"));
  try {
    await writeFile(path.join(work, "addon.tgz"), archive);
    execFileSync("tar", ["-xzf", "addon.tgz"], { cwd: work, stdio: "inherit" });
    const extracted = path.join(work, "package");
    await verify(extracted);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(extracted, target, { recursive: true, errorOnExist: true, force: false });
    await verify(target);
  } finally { await rm(work, { recursive: true, force: true }); }
  return target;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--current") && currentMxcArch() === null) process.exit(0);
  const staged = await stageMxcLauncher(parseArgs(process.argv.slice(2)));
  process.stdout.write(`fetch-mxc: ${path.relative(PROJECT_ROOT, staged)} (mxc-sdk ${MXC_PACKAGE_VERSION})\n`);
}

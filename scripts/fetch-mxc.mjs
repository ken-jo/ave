// Stage the per-architecture launcher and the selected SDK addon.
// Verify archive integrity and pinned launcher hashes; keep an already matching binary.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchBytesWithRetry } from "./lib/fetch-with-retry.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Boot and packaging verify the launcher against the same pins.
const PINS = JSON.parse(await readFile(path.join(PROJECT_ROOT, "src", "permissions", "mxc-launcher-pins.json"), "utf8"));
export const MXC_PACKAGE_VERSION = PINS.version;
const TARBALL_URL = `https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-${MXC_PACKAGE_VERSION}.tgz`;
const TARBALL_SHA512_BASE64 = PINS.tarballSha512Base64;
const LICENSE_SHA256 = PINS.licenseSha256;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function mxcLauncherForTarget(target) {
  if (!Object.hasOwn(PINS.targets, target)) throw new Error(`fetch-mxc: no pinned launcher for ${target}`);
  const [platform, arch] = target.split("-");
  const { launcher } = PINS.targets[target];
  if (!launcher || !/^[0-9a-f]{64}$/.test(launcher.sha256)
      || !new RegExp(`^bin/${arch}/[a-z0-9.-]+$`).test(launcher.member)) {
    throw new Error(`fetch-mxc: malformed launcher pin for ${target}`);
  }
  return { ...launcher, platform, arch, name: path.posix.basename(launcher.member) };
}

export function currentMxcTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "x64") {
    process.stderr.write("fetch-mxc: x64 macOS is not a supported build host\n");
    return null;
  }
  if (!Object.keys(PINS.targets).some((target) => target.startsWith(`${platform}-`))) return null;
  const target = `${platform}-${arch}`;
  mxcLauncherForTarget(target);
  return target;
}

function parseArgs(argv) {
  let target;
  let tarball;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") target = argv[++i];
    else if (arg === "--current") target = process.platform === "darwin" ? null : currentMxcTarget();
    else if (arg === "--tarball" && argv[i + 1]) tarball = argv[++i];
    else throw new Error(`fetch-mxc: unknown or incomplete argument ${arg}`);
  }
  if (target !== null && !Object.hasOwn(PINS.targets, target)) {
    throw new Error(`fetch-mxc: --target must be one of ${Object.keys(PINS.targets).join(", ")}`);
  }
  return { target, tarball };
}

async function tarballBytes(localPath) {
  if (localPath) return await readFile(localPath);
  return await fetchBytesWithRetry(TARBALL_URL, {
    httpError: (response) => `fetch-mxc: ${TARBALL_URL} answered ${response.status}`,
    log: (msg) => process.stderr.write(`fetch-mxc: ${msg}\n`),
  });
}

export async function stageMxcLauncher({ target, tarball, projectRoot = PROJECT_ROOT }) {
  const pin = mxcLauncherForTarget(target);
  const destination = path.join(projectRoot, "resources", "mxc", pin.arch, pin.name);
  const licensePath = path.join(projectRoot, "resources", "licenses", "mxc", "LICENSE.md");
  if (sha256(await readFile(licensePath)) !== LICENSE_SHA256) {
    throw new Error(`fetch-mxc: ${licensePath} differs from the MIT license shipped in mxc-sdk ${MXC_PACKAGE_VERSION}`);
  }
  const makeExecutable = async () => {
    if (pin.platform !== "win32") await chmod(destination, 0o755);
    return destination;
  };
  if (existsSync(destination) && sha256(await readFile(destination)) === pin.sha256) return makeExecutable();

  const installed = path.join(projectRoot, "node_modules", PINS.package, pin.member);
  const copyVerified = async (file) => {
    if (sha256(await readFile(file)) !== pin.sha256) throw new Error(`fetch-mxc: ${file} sha256 mismatch`);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file, destination);
    return makeExecutable();
  };
  if (existsSync(installed)) return copyVerified(installed);

  const bytes = await tarballBytes(tarball);
  const integrity = createHash("sha512").update(bytes).digest("base64");
  if (integrity !== TARBALL_SHA512_BASE64) {
    throw new Error(`fetch-mxc: mxc-sdk ${MXC_PACKAGE_VERSION} tarball integrity mismatch`);
  }
  const work = await mkdtemp(path.join(tmpdir(), "ave-mxc-"));
  try {
    await writeFile(path.join(work, "mxc.tgz"), bytes);
    const member = `package/${pin.member}`;
    execFileSync("tar", ["-xzf", "mxc.tgz", member], { cwd: work, stdio: "inherit" });
    return await copyVerified(path.join(work, ...member.split("/")));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Cross-architecture packaging cannot assume optional addons for the target
// were installed on the build host. Stage only a missing target; refuse drift.
export async function stageMxcSdkAddon({ arch, tarball, projectRoot = PROJECT_ROOT }) {
  const pin = PINS.sdk.addons[arch];
  if (!pin) throw new Error("fetch-mxc: unsupported SDK addon architecture");
  const modules = path.join(projectRoot, "node_modules");
  const target = path.join(modules, ...pin.package.split("/"));
  const prefix = pin.package + "/";
  const files = Object.entries(arch === "darwin-arm64" ? PINS.sdk.darwinFiles : PINS.sdk.architectures[arch])
    .filter(([name]) => name.startsWith(prefix));
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
    return await fetchBytesWithRetry(url, {
      httpError: () => "fetch-mxc: SDK addon archive unavailable",
      log: (msg) => process.stderr.write(`fetch-mxc: ${msg}\n`),
    });
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
  const options = parseArgs(process.argv.slice(2));
  if (options.target === null) process.exit(0);
  const staged = await stageMxcLauncher(options);
  process.stdout.write(`fetch-mxc: ${path.relative(PROJECT_ROOT, staged)} (mxc-sdk ${MXC_PACKAGE_VERSION})\n`);
}

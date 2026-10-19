/**
 * fetch-mxc.mjs — stage Microsoft Execution Containers' launcher for a Windows build.
 *
 * Ave runs each agent shell command on Windows in its own MXC container by
 * spawning `wxc-exec.exe --config-base64 <request>` (src/permissions/mxc-windows.ts).
 * The launcher ships in the MIT-licensed `@microsoft/mxc-sdk` npm package; Ave
 * does not load the SDK's JavaScript (its Windows stdio path needs a newer Node
 * than Electron bundles), so only the per-architecture launcher and the license
 * are staged:
 *
 *   resources/mxc/<arch>/wxc-exec.exe   (gitignored; packaged as mxc/<arch>/wxc-exec.exe)
 *   resources/licenses/mxc/LICENSE.md   (committed; this script checks it is unchanged)
 *
 * Only the launcher ships. The package's other binaries serve paths Ave never
 * requests: `winhttp-proxy-shim.exe` is the AppContainer-tier proxy fallback
 * (elevated, may raise UAC), which MXC refuses for `runtimeConfig.networkProxy`
 * with egress deny + ingress allow, the only network shape Ave sends, and boot
 * accepts only a dry run that selects `base-container`; `plm.exe` is the
 * elevated WPR tracing helper behind `telemetry`, which Ave never enables;
 * `wslcsdk.dll` and the `wxc-*-daemon` / `wxc-host-prep` binaries serve the
 * WSL-container, Windows Sandbox, isolation-session and AppContainer+DACL
 * backends. Every PR 9 measurement ran the launcher alone in its directory.
 *
 * The tarball is checked against the registry's published sha512 integrity and
 * each launcher against its own sha256, so a moved tag or a swapped file fails
 * the build instead of shipping. Idempotent: a launcher already matching its
 * hash is kept.
 *
 *   node scripts/fetch-mxc.mjs --arch x64
 *   node scripts/fetch-mxc.mjs --arch arm64 --tarball ./mxc-sdk-1.0.0.tgz
 *
 * Version: 1.0.0, the first stable release (2026-10-06). 1.0.1 (2026-10-17)
 * is newer than the two-week floor this repository keeps for pinned
 * dependencies; Ave detects the identity-less loopback proxy by probing the
 * request it sends, not by version, so moving to 1.0.1 only changes the pins.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One source for the pins: the app verifies the shipped launcher against the
// same file before its first use each boot (src/permissions/mxc-windows.ts).
const PINS = JSON.parse(await readFile(path.join(PROJECT_ROOT, "src", "permissions", "mxc-launcher-pins.json"), "utf8"));
export const MXC_PACKAGE_VERSION = PINS.version;
const TARBALL_URL = `https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-${MXC_PACKAGE_VERSION}.tgz`;
const TARBALL_SHA512_BASE64 = PINS.tarballSha512Base64;
export const WXC_EXEC_SHA256 = Object.freeze({ ...PINS.wxcExecSha256 });
const LICENSE_SHA256 = PINS.licenseSha256;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  let arch;
  let tarball;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--arch") arch = argv[++i];
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
    // Relative paths only: bsdtar (Windows' tar.exe) and GNU tar both accept them.
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const staged = await stageMxcLauncher(parseArgs(process.argv.slice(2)));
  process.stdout.write(`fetch-mxc: ${path.relative(PROJECT_ROOT, staged)} (mxc-sdk ${MXC_PACKAGE_VERSION})\n`);
}

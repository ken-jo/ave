import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchBytesWithRetry } from "../../scripts/lib/fetch-with-retry.mjs";
import { resolveUvTarget } from "../../scripts/uv-targets.mjs";
import { PYTHON_VERSION } from "./python-archive-cache.mjs";

const RELEASE_BASE = "https://github.com/astral-sh/python-build-standalone/releases/download/";

// The install command keeps distribution selection and checksum verification.
// A local mirror supplies the selected archive after an authenticated download.
export async function preparePythonDownloadMirror({ uv, mirrorRoot, listDownloads, download = fetchBytesWithRetry }) {
  if (!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN) || process.env.UV_PYTHON_INSTALL_MIRROR) return null;
  const output = listDownloads ? listDownloads() : execFileSync(uv, [
    "python", "list", "--only-downloads", "--show-urls", "--output-format", "json", PYTHON_VERSION,
  ], { encoding: "utf8", windowsHide: true, env: { ...process.env, UV_CACHE_DIR: join(mirrorRoot, "uv-cache") } });
  const candidates = JSON.parse(output).filter((entry) => entry.implementation === "cpython" && entry.variant === "default");
  if (candidates.length !== 1 || !candidates[0].url?.startsWith(RELEASE_BASE)) {
    throw new Error("Cannot identify the managed interpreter release");
  }
  const url = candidates[0].url;
  const suffix = url.slice(RELEASE_BASE.length);
  if (!/^\d+\/[^/]+\.tar\.gz$/.test(suffix) || decodeURIComponent(suffix).includes("..")) {
    throw new Error("Invalid managed interpreter release path");
  }
  const bytes = await download(url, { httpError: (response) => `Interpreter archive download failed with HTTP ${response.status}` });
  const destination = join(mirrorRoot, decodeURIComponent(suffix));
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  return pathToFileURL(resolve(mirrorRoot)).href;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if ((process.env.GITHUB_TOKEN || process.env.GH_TOKEN) && !process.env.UV_PYTHON_INSTALL_MIRROR) {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const target = resolveUvTarget(process.platform, process.arch);
    const uv = resolve(root, "resources", "uv", target.dir, target.bin);
    if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error("Runner download paths are required");
    const mirror = await preparePythonDownloadMirror({ uv, mirrorRoot: join(process.env.RUNNER_TEMP, "python-release-mirror") });
    appendFileSync(process.env.GITHUB_ENV, `AVE_PYTHON_DOWNLOAD_MIRROR=${mirror}\n`);
  }
}

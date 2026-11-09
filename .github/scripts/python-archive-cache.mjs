import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveUvTarget } from "../../scripts/uv-targets.mjs";

export const PYTHON_VERSION = "3.12";

export function pythonArchiveCacheKey(versionOutput, platform = process.platform, arch = process.arch) {
  const version = /^uv (\d+\.\d+\.\d+)(?:\s|$)/.exec(versionOutput)?.[1];
  if (!version) throw new Error("Cannot identify the installed runtime version");
  const target = resolveUvTarget(platform, arch);
  return `python-archive-v1-uv-${version}-python-${PYTHON_VERSION}-${target.dir}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const target = resolveUvTarget(process.platform, process.arch);
  const uv = resolve(root, "resources", "uv", target.dir, target.bin);
  const version = execFileSync(uv, ["--version"], { encoding: "utf8", windowsHide: true });
  appendFileSync(process.env.GITHUB_OUTPUT, `key=${pythonArchiveCacheKey(version)}\n`);
}

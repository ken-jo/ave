import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SKILL_SCRIPT_ENTRIES } from "./lib/skill-script-inventory.mjs";
import { WINDOWS_PATH_KIND_BUNDLE_PIN, windowsPathKindBundlePinDeclaration } from "./lib/windows-path-kind-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildSkillScripts({ pathKindSha256 = null, directory = resolve(ROOT, "dist/skill-scripts") } = {}) {
  const pathKindPin = pathKindSha256 === null ? {} : {
    define: { __AVE_WINDOWS_PATH_KIND_SHA256__: WINDOWS_PATH_KIND_BUNDLE_PIN },
    banner: { js: windowsPathKindBundlePinDeclaration(pathKindSha256) },
  };
  await mkdir(directory, { recursive: true });
  const scripts = {};
  for (const [name, source] of Object.entries(SKILL_SCRIPT_ENTRIES)) {
    const file = `${name}.cjs`;
    const target = resolve(directory, file);
    const result = await build({ absWorkingDir: ROOT, entryPoints: [source], bundle: true,
      platform: "node", format: "cjs", target: "node22", outfile: target, write: false,
      legalComments: "eof", minify: true, logLevel: "silent", ...pathKindPin });
    const bytes = result.outputFiles[0].contents;
    let existing;
    try { existing = await readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!existing?.equals(bytes)) await writeFile(target, bytes);
    scripts[file] = createHash("sha256").update(bytes).digest("hex");
  }
  const manifest = `${JSON.stringify({ version: 1, scripts }, null, 2)}\n`;
  await writeFile(resolve(directory, "manifest.json"), manifest);
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSkillScripts();
}

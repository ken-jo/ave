import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = { "edit-xlsx": "src/skills/xlsx-edit-cli.ts" };

export async function buildSkillScripts() {
  const directory = resolve(ROOT, "dist/skill-scripts");
  await mkdir(directory, { recursive: true });
  const scripts = {};
  for (const [name, source] of Object.entries(ENTRIES)) {
    const file = `${name}.cjs`;
    const target = resolve(directory, file);
    const result = await build({ absWorkingDir: ROOT, entryPoints: [source], bundle: true,
      platform: "node", format: "cjs", target: "node22", outfile: target, write: false,
      legalComments: "eof", minify: true, logLevel: "silent" });
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

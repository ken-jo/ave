import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_MANIFEST = "outputs.json";

export type WindowsPreparationManifest = {
  readonly identity: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = value as Record<string, unknown>;
  return `{${Object.keys(entries).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(entries[key])}`).join(",")}}`;
}

export function windowsPreparationKey(manifest: WindowsPreparationManifest) {
  return `ave-windows-preparation-v1-${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// Inventory the tracked build, workflow and packaging input trees. The payload
// check writes a generated application entry, and imports its tracked pins
// under src/permissions. Installed dependencies come from the frozen lockfile.
const INPUT_TREES = /^(?:\.github|build|config|native|patches|resources|scripts|src\/permissions)\//u;

export async function windowsPreparationInputs(root: string, identity: WindowsPreparationManifest["identity"]): Promise<WindowsPreparationManifest> {
  const paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .split("\0").filter(path => path && (!path.includes("/") || INPUT_TREES.test(path))).sort();
  if (!paths.includes("bun.lock")) throw new Error("Missing preparation input: bun.lock");
  const files: Record<string, string> = {};
  for (const file of paths) {
    const path = join(root, file);
    if (!lstatSync(path).isFile()) throw new Error(`Invalid preparation input: ${file}`);
    files[file] = await hashFile(path);
  }
  return { identity, files };
}

async function outputFiles(root: string) {
  if (!lstatSync(root).isDirectory()) throw new Error("Invalid preparation cache root");
  const files: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const file = relative ? `${relative}/${name}` : name;
      const path = join(root, file);
      const stat = lstatSync(path);
      if (stat.isDirectory()) await visit(file);
      else if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Invalid preparation output: ${file}`);
      else if (file !== OUTPUT_MANIFEST) files[file] = await hashFile(path);
    }
  }
  await visit("");
  return files;
}

export async function sealWindowsPreparation(root: string, key: string, required: readonly string[]) {
  const files = await outputFiles(root);
  if (required.some(file => !Object.hasOwn(files, file))) throw new Error("Missing preparation output");
  writeFileSync(join(root, OUTPUT_MANIFEST), `${JSON.stringify({ key, files })}\n`, { flag: "wx" });
}

async function verifyWindowsPreparation(root: string, key: string, required: readonly string[]) {
  const files = await outputFiles(root);
  const { key: storedKey, files: stored } = JSON.parse(readFileSync(join(root, OUTPUT_MANIFEST), "utf8"));
  if (storedKey !== key || required.some(file => !Object.hasOwn(files, file)) || canonicalJson(stored) !== canonicalJson(files)) {
    throw new Error("Windows preparation cache digest mismatch");
  }
}

export async function restoreWindowsPreparation(
  store: string,
  key: string | undefined,
  required: readonly string[],
  exactHit: boolean,
  verifyIdentity: () => void | Promise<void>,
): Promise<boolean> {
  if (key && exactHit) {
    try {
      await verifyWindowsPreparation(store, key, required);
      await verifyIdentity();
      return true;
    } catch (error) {
      console.log(`Windows preparation cache rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Discard partial or invalid output before the builder can write here.
  rmSync(store, { recursive: true, force: true });
  return false;
}

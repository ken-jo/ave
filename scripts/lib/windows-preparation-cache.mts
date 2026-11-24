import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
// under src/permissions. Also bind the installed files the packager validates.
const INPUT_TREES = /^(?:\.github|build|config|native|patches|resources|scripts|src\/permissions)\//u;

export async function windowsPreparationInputs(
  root: string,
  identity: WindowsPreparationManifest["identity"],
  installed: readonly string[] = [],
): Promise<WindowsPreparationManifest> {
  const paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .split("\0").filter(path => path && (!path.includes("/") || INPUT_TREES.test(path))).sort();
  if (!paths.includes("bun.lock")) throw new Error("Missing preparation input: bun.lock");
  const files = Object.create(null) as Record<string, string>;
  for (const file of paths) {
    const path = join(root, file);
    if (!lstatSync(path).isFile()) throw new Error(`Invalid preparation input: ${file}`);
    files[file] = await hashFile(path);
  }
  for (const file of installed) {
    if (!file.startsWith("node_modules/") || file.split("/").includes("..")) throw new Error(`Invalid installed preparation input: ${file}`);
    const path = join(root, file);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    files[file] = stat?.isFile() ? await hashFile(path) : stat ? "not a regular file" : "missing";
  }
  return { identity, files };
}

function* outputPaths(root: string, relative = ""): Generator<string> {
  if (!lstatSync(root).isDirectory()) throw new Error("Invalid preparation cache root");
  for (const name of readdirSync(join(root, relative)).sort()) {
    const file = relative ? `${relative}/${name}` : name;
    if (name === "__proto__") throw new Error(`Unexpected preparation output: ${file}`);
    const stat = lstatSync(join(root, file));
    if (stat.isDirectory()) yield* outputPaths(root, file);
    else if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Invalid preparation output: ${file}`);
    else if (file !== OUTPUT_MANIFEST) yield file;
  }
}

function assertExpectedFile(expected: Readonly<Record<string, string>>, file: string) {
  if (!Object.hasOwn(expected, file)) throw new Error(`Unexpected preparation output: ${file}`);
}

async function outputFiles(root: string, expected?: Readonly<Record<string, string>>) {
  const files = Object.create(null) as Record<string, string>;
  for (const file of outputPaths(root)) {
    if (expected) assertExpectedFile(expected, file);
    files[file] = await hashFile(join(root, file));
  }
  return files;
}

export async function sealWindowsPreparation(root: string, key: string, required: readonly string[]) {
  const files = await outputFiles(root);
  if (required.some(file => !Object.hasOwn(files, file))) throw new Error("Missing preparation output");
  const manifest = `${JSON.stringify({ key, files })}\n`;
  writeFileSync(join(root, OUTPUT_MANIFEST), manifest, { flag: "wx" });
  return createHash("sha256").update(manifest).digest("hex");
}

function readOutputManifest(root: string, digest?: string): { key: string; files: Record<string, string> } {
  const path = join(root, OUTPUT_MANIFEST);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid preparation output manifest");
  const manifest = readFileSync(path);
  if (digest !== undefined && createHash("sha256").update(manifest).digest("hex") !== digest) {
    throw new Error("Windows preparation seal changed");
  }
  return JSON.parse(manifest.toString("utf8"));
}

async function verifyWindowsPreparation(root: string, key: string, required: readonly string[], expected: ReturnType<typeof readOutputManifest>) {
  const files = await outputFiles(root, expected.files);
  if (expected.key !== key || required.some(file => !Object.hasOwn(files, file))
    || canonicalJson(expected.files) !== canonicalJson(files) || canonicalJson(readOutputManifest(root)) !== canonicalJson(expected)) {
    throw new Error("Windows preparation cache digest mismatch");
  }
}

export async function verifySealedWindowsPreparation(root: string, key: string, required: readonly string[], digest: string | undefined) {
  if (!digest || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Missing preparation seal digest");
  await verifyWindowsPreparation(root, key, required, readOutputManifest(root, digest));
}

type RestoreChecks = {
  verifyIdentity: (directory: string) => void | Promise<void>;
  verifyInputs?: () => void | Promise<void>;
  stage?: {
    directory: string;
    install: (readVerified: (file: string) => Buffer) => void;
  };
};

export async function restoreWindowsPreparation(
  store: string,
  key: string | undefined,
  required: readonly string[],
  exactHit: boolean,
  { verifyIdentity, verifyInputs, stage }: RestoreChecks,
): Promise<boolean> {
  const directory = stage?.directory ?? store;
  if (key && exactHit) {
    try { await verifyInputs?.(); }
    catch (error) {
      if (stage) rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    try {
      if (!lstatSync(store).isDirectory()) throw new Error("Invalid preparation cache root");
      const expected = readOutputManifest(store);
      if (stage) {
        // Preserve rejection of unsupported filesystem entries even when a
        // copy would turn them into ordinary files.
        for (const file of outputPaths(store)) assertExpectedFile(expected.files, file);
        for (const name of readdirSync(store)) {
          cpSync(join(store, name), join(directory, name), {
            recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false,
          });
        }
      }
      await verifyWindowsPreparation(directory, key, required, expected);
      await verifyIdentity(directory);
      await verifyWindowsPreparation(directory, key, required, expected);
      stage?.install(file => {
        assertExpectedFile(expected.files, file);
        const bytes = readFileSync(join(directory, file));
        if (createHash("sha256").update(bytes).digest("hex") !== expected.files[file]) {
          throw new Error(`Windows preparation cache digest mismatch: ${file}`);
        }
        return bytes;
      });
      return true;
    } catch (error) {
      console.log(`Windows preparation cache rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Discard partial or invalid output before the builder can write here.
  if (stage) rmSync(directory, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
  return false;
}

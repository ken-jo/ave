#!/usr/bin/env node
// Publish reproducible contract bytes from a clean commit; signing belongs to the workflow.
// --allow-dirty is for local development only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Copy from commit objects without changing bytes.
export const CONTRACT_COPIES = Object.freeze({
  "public-contract.ts": "src/plugins/public-contract.ts",
  "plugin-manifest.schema.json": "schemas/plugin-manifest.schema.json",
  "protocol.schema.json": "schemas/plugin-host-protocol/4/protocol.schema.json",
});

export const CONTRACT_BUILDS = Object.freeze({
  "marketplace-check.js": "src/marketplace/repository-check.ts",
  "agent-plugin-components.js": "src/marketplace/content/agent-plugin-components.ts",
});

export const BUNDLE_MANIFEST = "bundle.json";
export const BUNDLE_SUMS = "SHA256SUMS";

// Run the bundler from the checkout for relative source labels.
// Replace the host logger transport: this checker must not log through the host.
const BUN_RECIPE = String.raw`
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const [app, entry] = process.argv.slice(-2);
const appRoot = realpathSync(app);
const loggerImport = resolve(appRoot, "src/lib/logger.js");
const result = await Bun.build({
  entrypoints: [resolve(appRoot, entry)],
  root: appRoot,
  target: "node",
  format: "esm",
  plugins: [{
    name: "marketplace-check-unused-host-logger",
    setup(build) {
      build.onResolve({ filter: /\/lib\/logger\.js$/u }, (args) => {
        if (resolve(args.resolveDir, args.path) !== loggerImport) return;
        return { path: "unused-host-logger", namespace: "marketplace-check" };
      });
      build.onLoad({ filter: /.*/u, namespace: "marketplace-check" }, () => ({
        loader: "js",
        contents: ${JSON.stringify(`const silent = () => {};
const logger = { debug: silent, info: silent, warn: silent, error: silent, trace: silent, fatal: silent, child: () => logger };
export function createLogger() { return logger; }`)},
      }));
    },
  }],
});
if (!result.success) throw new Error("checker bundle failed: " + result.logs.map((log) => log.message).join("; "));
if (result.outputs.length !== 1) throw new Error("checker bundle expected one output, got " + result.outputs.length);
process.stdout.write(Buffer.from(await result.outputs[0].arrayBuffer()));
`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Published bundles must not depend on or expose the build checkout.
export function embeddedBuildPaths(bytes) {
  const source = bytes.toString();
  const paths = [];
  if (/\/(?:private|Users|home|tmp|var|workspace|workspaces|root|opt|mnt|builds|repo)\//u.test(source)) paths.push("Unix checkout path");
  if (/(?:^|[\s"'`(=])[A-Za-z]:[\\/]/mu.test(source)) paths.push("Windows drive path");
  return paths;
}

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
}

function bunBuild(root, entry) {
  return execFileSync("bun", ["-e", BUN_RECIPE, root, entry], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

// The output directory must be empty or absent.
export function buildContractBundle({ root = ROOT, out, tag, commit, allowDirty = false }) {
  if (typeof out !== "string" || out === "") throw new Error("[build-contract-bundle] --out is required");
  if (typeof tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tag)) {
    throw new Error(`[build-contract-bundle] --tag must be a plain tag name, got ${JSON.stringify(tag)}`);
  }
  const head = git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const resolved = commit === undefined ? head : git(root, ["rev-parse", "--verify", `${commit}^{commit}`], { encoding: "utf8" }).trim();
  if (resolved !== head) throw new Error(`[build-contract-bundle] checkout HEAD ${head} is not ${commit} (${resolved})`);
  if (!allowDirty && git(root, ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "") {
    throw new Error("[build-contract-bundle] the checkout has uncommitted changes to tracked files");
  }

  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) throw new Error(`[build-contract-bundle] ${out} is not empty`);

  const files = {};
  const write = (name, bytes) => {
    writeFileSync(join(out, name), bytes);
    files[name] = { sha256: sha256(bytes), bytes: bytes.length };
  };
  // Read commit objects even with --allow-dirty so working-tree edits cannot leak.
  for (const [name, path] of Object.entries(CONTRACT_COPIES)) write(name, git(root, ["show", `${resolved}:${path}`]));
  for (const [name, entry] of Object.entries(CONTRACT_BUILDS)) {
    const bytes = bunBuild(root, entry);
    const leaked = embeddedBuildPaths(bytes);
    if (leaked.length > 0) throw new Error(`[build-contract-bundle] ${name}: embedded absolute build path (${leaked.join(", ")})`);
    write(name, bytes);
  }

  const manifest = { schemaVersion: 1, app: "ave", tag, commit: resolved, files };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, BUNDLE_MANIFEST), manifestBytes);
  const sums = { ...Object.fromEntries(Object.entries(files).map(([name, entry]) => [name, entry.sha256])), [BUNDLE_MANIFEST]: sha256(manifestBytes) };
  const lines = Object.keys(sums).sort().map((name) => `${sums[name]}  ${name}\n`);
  writeFileSync(join(out, BUNDLE_SUMS), lines.join(""));
  return manifest;
}

function parseArgs(argv) {
  const options = { allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--out" || arg === "--tag" || arg === "--commit") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`[build-contract-bundle] ${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else throw new Error(`[build-contract-bundle] unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = buildContractBundle({ ...options, out: options.out === undefined ? undefined : resolve(options.out) });
    for (const [name, entry] of Object.entries(manifest.files)) console.log(`${entry.sha256}  ${String(entry.bytes).padStart(8)}  ${name}`);
    console.log(`[build-contract-bundle] ${manifest.tag} at ${manifest.commit} -> ${options.out}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/** Provision one isolated managed interpreter and verify its dependencies; missing prerequisites fail rather than skip. */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledUvBinaryPath } from "../../../main/uv-runtime.js";
import { errorMessage } from "../../../shared/error-message.js";
import { repositoryRoot } from "./child-entry-bundle.js";

/** The committed fixture is read-only. */
const PYTHON_SMOKE_FIXTURE = fileURLToPath(
  new URL("./fixtures/host-protocol/4/plugins/python-smoke/", import.meta.url),
);

const MCP_REQUIREMENT = "mcp==2.2.0";
const MCP_VERSION = "2.2.0";
/** The MCP dependency minimum supported interpreter version. */
const PYTHON_FLOOR = "3.10";
const UV_INSTALL_PYTHON = "3.12";

/** Cache misses may download the interpreter and dependencies. */
const PROVISION_STEP_TIMEOUT_MS = 300_000;

export interface ProvisionedPython {
  readonly python: string;
  readonly source: "AVE_SMOKE_PYTHON" | "uv";
  readonly version: string;
  /** Cached dependency directory for the selected interpreter. */
  readonly vendor: string;
  readonly wheels: readonly string[];
  readonly provisionMs: number;
}

const cacheRoot = (): string => join(repositoryRoot(), "node_modules", ".cache", "ave-python-smoke");

/** Drop caller environment overrides and active virtual environments; discovery must stay inside the managed install. */
function uvEnvironment(cache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("UV_") || name === "VIRTUAL_ENV" || name.startsWith("CONDA_")) continue;
    env[name] = value;
  }
  return {
    ...env,
    UV_PYTHON_INSTALL_DIR: join(cache, "python"),
    UV_PYTHON_BIN_DIR: join(cache, "bin"),
    UV_PYTHON_INSTALL_BIN: "0",
    UV_CACHE_DIR: join(cache, "uv"),
  };
}

/** Run isolated interpreter probes so user startup hooks and site directories cannot affect results. */
const ISOLATED_PYTHON_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

/** Command failures must name the prerequisite and stderr. */
function run(
  prerequisite: string,
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROVISION_STEP_TIMEOUT_MS,
      ...options,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n").slice(-8).join("\n") : errorMessage(error);
    throw new Error(`[python-smoke] ${prerequisite} (${[command, ...args].join(" ")}):\n${detail}`);
  }
}

function bundledUv(): string {
  try {
    return resolveBundledUvBinaryPath({ defaultApp: true, projectRoot: repositoryRoot() });
  } catch (error) {
    throw new Error(`[python-smoke] uv is missing: ${errorMessage(error)}`);
  }
}

/** Refuse managed discovery results outside the smoke install directory. */
function findManagedPython(uv: string, cache: string): string | undefined {
  let found: string;
  try {
    found = execFileSync(uv, ["python", "find", "--managed-python", `>=${PYTHON_FLOOR}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: uvEnvironment(cache),
      cwd: cache,
      timeout: PROVISION_STEP_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    // Only the explicit no-interpreter result is a cache miss; propagate other discovery failures.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/No interpreter found/u.test(stderr)) return undefined;
    throw new Error(`[python-smoke] uv python find failed: ${stderr.trim() || errorMessage(error)}`);
  }
  const installDir = realpathSync(join(cache, "python"));
  if (!realpathSync(found).startsWith(installDir + sep)) {
    throw new Error(
      `[python-smoke] uv python find --managed-python answered ${found}, which is not under ${installDir}`,
    );
  }
  return found;
}

function resolveInterpreter(uv: string, cache: string): { python: string; source: ProvisionedPython["source"] } {
  const declared = process.env.AVE_SMOKE_PYTHON;
  if (declared !== undefined && declared !== "") return { python: declared, source: "AVE_SMOKE_PYTHON" };
  mkdirSync(join(cache, "python"), { recursive: true });
  const found = findManagedPython(uv, cache);
  if (found !== undefined) return { python: found, source: "uv" };
  run(
    `uv python install ${UV_INSTALL_PYTHON} failed (a cache miss needs network access)`,
    uv,
    ["python", "install", UV_INSTALL_PYTHON],
    { env: uvEnvironment(cache), cwd: cache },
  );
  const installed = findManagedPython(uv, cache);
  if (installed === undefined) {
    throw new Error(`[python-smoke] uv python install ${UV_INSTALL_PYTHON} succeeded and find still found nothing`);
  }
  return { python: installed, source: "uv" };
}

function wheelSet(python: string, dir: string): string[] {
  const listed = run("could not list the vendored distributions", python, [
    "-I",
    "-c",
    "import importlib.metadata as m, json, sys; "
      + "print(json.dumps(sorted(f\"{d.metadata['Name']}=={d.version}\" for d in m.distributions(path=[sys.argv[1]]))))",
    dir,
  ], { env: ISOLATED_PYTHON_ENV });
  return JSON.parse(listed) as string[];
}

/** Remove archive metadata sidecars; they are not installed distributions and can break metadata decoding. */
export function removeAppleDoubleSidecars(dir: string): string[] {
  const removed: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.name.startsWith("._") || entry.isDirectory()) continue;
    const path = join(entry.parentPath, entry.name);
    rmSync(path, { force: true });
    removed.push(path.slice(dir.length + 1));
  }
  return removed.sort();
}

/** Stage dependencies and rename atomically so concurrent suites see only complete caches. */
function vendorFor(uv: string, cache: string, python: string, version: string): string {
  const vendor = join(cache, `${version}-mcp-${MCP_VERSION}`);
  if (existsSync(vendor)) {
    const removed = removeAppleDoubleSidecars(vendor);
    if (removed.length > 0) reportSmoke("removed AppleDouble sidecars from the cached vendor directory", removed);
    return vendor;
  }
  const staging = join(cache, `.staging-${process.pid}-${Date.now()}`);
  try {
    run(
      `uv pip install ${MCP_REQUIREMENT} failed for ${python} (a cache miss needs network access to PyPI)`,
      uv,
      ["pip", "install", "--python", python, "--target", staging, MCP_REQUIREMENT],
      { env: uvEnvironment(cache), cwd: cache },
    );
    try {
      renameSync(staging, vendor);
    } catch (error) {
      if (!existsSync(vendor)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return vendor;
}

/** Write provisioning records to stderr so passing test runs retain measurement evidence. */
export function reportSmoke(label: string, record: unknown): void {
  process.stderr.write(`[python-smoke] ${label} ${JSON.stringify(record)}\n`);
}

let provisioned: ProvisionedPython | undefined;

export function provisionPythonSmoke(): ProvisionedPython {
  if (provisioned) return provisioned;
  const started = performance.now();
  const cache = cacheRoot();
  mkdirSync(cache, { recursive: true });
  const uv = bundledUv();
  const { python, source } = resolveInterpreter(uv, cache);
  const [major, minor] = PYTHON_FLOOR.split(".");
  try {
    execFileSync(python, ["-I", "-c", `import sys; sys.exit(0 if sys.version_info >= (${major}, ${minor}) else 1)`], {
      stdio: "ignore",
      timeout: PROVISION_STEP_TIMEOUT_MS,
      env: ISOLATED_PYTHON_ENV,
    });
  } catch (error) {
    throw new Error(
      `[python-smoke] ${python} (from ${source}) is not a Python ${PYTHON_FLOOR} or newer, `
        + `which ${MCP_REQUIREMENT} requires: ${errorMessage(error)}`,
    );
  }
  const version = run(`${python} did not report its version`, python, ["-I", "-c", "import platform; print(platform.python_version())"], {
    env: ISOLATED_PYTHON_ENV,
  });
  const vendor = vendorFor(uv, cache, python, version);
  provisioned = {
    python,
    source,
    version,
    vendor,
    wheels: wheelSet(python, vendor),
    provisionMs: Math.round(performance.now() - started),
  };
  reportSmoke("provisioned", provisioned);
  return provisioned;
}

/** Copy the fixture and verified dependency tree, recording the interpreter path for the launcher. */
export function installPythonSmoke(root: string, python: ProvisionedPython = provisionPythonSmoke()): string {
  mkdirSync(root, { recursive: true });
  cpSync(PYTHON_SMOKE_FIXTURE, root, { recursive: true });
  cpSync(python.vendor, join(root, "vendor"), { recursive: true });
  writeFileSync(join(root, "bin", "python-path"), python.python, "utf-8");
  chmodSync(join(root, "bin", "plugin"), 0o755);
  // Verify imports resolve inside the supplied vendor tree; matching distribution metadata alone proves too little.
  const vendor = join(root, "vendor");
  const imported = run(`${vendor} does not import ${MCP_REQUIREMENT}`, python.python, [
    "-I",
    "-c",
    "import sys; sys.path.insert(0, sys.argv[1]); import json, os, mcp, importlib.metadata as m; "
      + "print(json.dumps({'version': m.version('mcp'), 'file': os.path.realpath(mcp.__file__)}))",
    vendor,
  ], { env: ISOLATED_PYTHON_ENV });
  const { version: importedVersion, file: importedFile } = JSON.parse(imported) as { version: string; file: string };
  if (!importedFile.startsWith(realpathSync(vendor) + sep)) {
    throw new Error(`[python-smoke] mcp was imported from ${importedFile}, not from ${vendor}`);
  }
  if (importedVersion !== MCP_VERSION) {
    throw new Error(`[python-smoke] ${vendor} imports mcp ${importedVersion}, not ${MCP_VERSION}`);
  }
  return root;
}

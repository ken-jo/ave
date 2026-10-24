/**
 * The Python the cross-language smoke runs on, provisioned and proven
 * (`docs/design/plugin-hostapi-protocol.md` §9.7 P5, decision 46).
 *
 * ONE interpreter, resolved in this order:
 *
 *  - `AVE_SMOKE_PYTHON`, when set: every CI job that runs the smoke sets it to
 *    the interpreter `actions/setup-python` provisioned.
 *  - Otherwise the app's own development uv, with one environment for every uv
 *    call — install directory, executable-link directory, `UV_PYTHON_INSTALL_BIN=0`
 *    and cache, all under `node_modules/.cache/ave-python-smoke` — and
 *    `--managed-python` discovery, so a `python3` on `PATH` is never chosen. A
 *    miss installs 3.12 there and finds again. Nothing is written to the
 *    user's home.
 *
 * Whichever it is, the executable is then held to the `mcp` 2.2.0 floor before
 * anything else, `mcp==2.2.0` is installed for exactly that interpreter by the
 * same uv, and the copy a test runs is proven to import it. A missing uv, a
 * too-old interpreter, a failed install, a failed import or a refused network
 * on a cache miss fails with the missing prerequisite named: nothing here
 * skips.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledUvBinaryPath } from "../../../main/uv-runtime.js";
import { errorMessage } from "../../../shared/error-message.js";
import { repositoryRoot } from "./child-entry-bundle.js";

/** The committed fixture: manifest, launcher, `plugin.py`, golden. Never written to. */
const PYTHON_SMOKE_FIXTURE = fileURLToPath(
  new URL("./fixtures/host-protocol/3/plugins/python-smoke/", import.meta.url),
);

/** The library the fixture serves its MCP half with (fact 1). */
const MCP_REQUIREMENT = "mcp==2.2.0";
const MCP_VERSION = "2.2.0";
/** `mcp` 2.2.0's `requires-python`. */
const PYTHON_FLOOR = "3.10";
/** What uv installs on a discovery miss. */
const UV_INSTALL_PYTHON = "3.12";

/** Generous: a cache miss downloads an interpreter or the wheels. */
const PROVISION_STEP_TIMEOUT_MS = 300_000;

export interface ProvisionedPython {
  /** The verified executable. */
  readonly python: string;
  /** Where it came from. */
  readonly source: "AVE_SMOKE_PYTHON" | "uv";
  /** `platform.python_version()` of {@link python}. */
  readonly version: string;
  /** The cached vendor directory, `mcp` and its dependencies for {@link python}. */
  readonly vendor: string;
  /** `name==version` of every distribution in {@link vendor}. */
  readonly wheels: readonly string[];
  /** Wall time of the whole provisioning, cache hits included. */
  readonly provisionMs: number;
}

const cacheRoot = (): string => join(repositoryRoot(), "node_modules", ".cache", "ave-python-smoke");

/**
 * The one environment every uv call runs under. The caller's own `UV_*`
 * settings are dropped so none of them can steer the run; so are an active
 * virtual or conda environment's markers, because uv offers that
 * environment's interpreter to `find` ahead of the managed ones even under
 * `--managed-python` (observed with uv 0.7.3 and an active conda base, which
 * `find` answered with `$CONDA_PREFIX/bin/python3`; its miss reads "No
 * interpreter found … in virtual environments or managed installations").
 */
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

/**
 * The environment for every probe of the interpreter itself. With `-I` (no
 * `PYTHON*` variables, no user site, no script directory) it keeps the user's
 * `usercustomize`/`sitecustomize` and `PYTHONSTARTUP` out of the checks, so they
 * cannot pass or fail on code that is not the interpreter's.
 */
const ISOLATED_PYTHON_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

/** Run one command; its trimmed stdout, or a failure naming `prerequisite` and the command's stderr. */
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

/**
 * The managed interpreter in the smoke's own install directory, or `undefined`
 * when there is none yet. A `find` that answers with anything outside that
 * directory is refused rather than used: managed-only discovery is the rule,
 * and this is where it is checked.
 */
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
    // A miss is `find`'s own "No interpreter found"; any other failure is uv's.
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

/** The distributions installed in `dir`, as `name==version`. */
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

/**
 * Delete every AppleDouble sidecar (`._<name>`) under `dir`; the paths removed,
 * relative to `dir`.
 *
 * macOS bsdtar writes a file's extended attributes as a `._<name>` entry next
 * to it, and GNU tar extracts that entry as an ordinary file. The CI
 * node_modules cache, which carries this directory, was saved by bsdtar
 * (libarchive) and is restored by the hosted image's GNU tar, so the vendor
 * directory came back with `._mcp-2.2.0.dist-info` beside the real one.
 * `importlib.metadata` takes any name ending in `.dist-info` for a
 * distribution; for a file it falls through to reading the file itself as
 * metadata, and the AppleDouble header (byte 0xa3 at offset 45) is not UTF-8.
 * A sidecar is never part of an installed distribution, so removing it changes
 * nothing that `uv pip install` wrote.
 */
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

/**
 * `mcp==2.2.0` for exactly this interpreter, cached by its version. Installed
 * into a staging directory and renamed into place, so a concurrent suite
 * either finds the finished directory or installs its own.
 */
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
      // Another suite renamed its own copy into place first.
      if (!existsSync(vendor)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return vendor;
}

/**
 * Put one record in the test output. Written to stderr directly because the
 * runner shows a passing test's `console` output only when it fails, and these
 * records — what was provisioned, what was measured — matter most on a pass.
 */
export function reportSmoke(label: string, record: unknown): void {
  process.stderr.write(`[python-smoke] ${label} ${JSON.stringify(record)}\n`);
}

let provisioned: ProvisionedPython | undefined;

/** Provision once per test process; later calls answer from the first. */
export function provisionPythonSmoke(): ProvisionedPython {
  if (provisioned) return provisioned;
  const started = performance.now();
  const cache = cacheRoot();
  mkdirSync(cache, { recursive: true });
  const uv = bundledUv();
  const { python, source } = resolveInterpreter(uv, cache);
  // Before anything else: the floor `mcp` 2.2.0 declares.
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

/**
 * A runnable copy of the fixture at `root`: the committed files, the vendor
 * directory copied to `<root>/vendor`, and `bin/python-path` naming the
 * provisioned interpreter. Then the provisioning check on the copy — the
 * vendored `mcp` imports, at its version — which proves the wheels, not the
 * launcher (`python-smoke-launcher.test.ts` proves that).
 */
export function installPythonSmoke(root: string, python: ProvisionedPython = provisionPythonSmoke()): string {
  mkdirSync(root, { recursive: true });
  cpSync(PYTHON_SMOKE_FIXTURE, root, { recursive: true });
  cpSync(python.vendor, join(root, "vendor"), { recursive: true });
  writeFileSync(join(root, "bin", "python-path"), python.python, "utf-8");
  chmodSync(join(root, "bin", "plugin"), 0o755);
  // `-I` like the interpreter probes, so neither the cwd nor a user site is on
  // `sys.path`; the vendor directory is the one entry added. The module's own
  // file must then lie inside it: distribution metadata alone would also
  // report 2.2.0 for an `mcp` imported from somewhere else.
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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardedNodeOptions } from "./lib/document-consumer-node-options.mjs";

const require = createRequire(import.meta.url);
const FORWARDED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"]);
const DEFAULT_NORMALIZER_PATH = fileURLToPath(
  new URL("./normalize-electron-node-runtime.mjs", import.meta.url),
);
const DEFAULT_GENERATOR_PATH = fileURLToPath(
  new URL("./generate-ave-icons.cjs", import.meta.url),
);
// The generator writes the manifest last, marking completed output.
const GENERATED_ASSETS_MANIFEST = join("build", "generated-assets.json");

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// Fresh worktrees lack ignored branding assets required by tests; use the generator manifest as inventory.
export function missingGeneratedAssets({
  cwd = process.cwd(),
  manifestPath = GENERATED_ASSETS_MANIFEST,
} = {}) {
  const manifest = join(cwd, manifestPath);
  if (!existsSync(manifest)) return [manifestPath];
  let listed;
  try {
    listed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return [manifestPath];
  }
  if (!Array.isArray(listed) || listed.some((entry) => typeof entry !== "string")) {
    return [manifestPath];
  }
  return listed.filter((entry) => !existsSync(join(cwd, entry)));
}

// Generate only missing assets; build preparation and drift checks own regeneration.
export function ensureGeneratedAssets({
  cwd = process.cwd(),
  manifestPath = GENERATED_ASSETS_MANIFEST,
  generatorPath = DEFAULT_GENERATOR_PATH,
  nodeExecPath = process.execPath,
  runSync = spawnSync,
  log = (line) => console.error(line),
} = {}) {
  const missing = missingGeneratedAssets({ cwd, manifestPath });
  if (missing.length === 0) return { generated: false, missing };
  log(`[electron-vitest-assets] generating branding assets; missing: ${missing.join(", ")}`);
  const result = runSync(nodeExecPath, [generatorPath], {
    cwd,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? errorText(result.error) : `generator exited ${result.status}`;
    throw new Error(`[electron-vitest-assets-unavailable] ${reason}`, {
      cause: result.error,
    });
  }
  const stillMissing = missingGeneratedAssets({ cwd, manifestPath });
  if (stillMissing.length > 0) {
    throw new Error(
      `[electron-vitest-assets-unavailable] generator left assets missing: ${stillMissing.join(", ")}`,
    );
  }
  return { generated: true, missing };
}

export function electronNodeNormalizerArgument(normalizerPath = DEFAULT_NORMALIZER_PATH) {
  return `--import=${pathToFileURL(normalizerPath).href}`;
}

export function resolveElectronVitestRuntime({
  loadElectron = () => require("electron"),
  resolveVitest = () => join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
  normalizerPath = DEFAULT_NORMALIZER_PATH,
} = {}) {
  let electronPath;
  let vitestPath;
  try {
    electronPath = loadElectron();
    vitestPath = resolveVitest();
  } catch (error) {
    throw new Error(`[electron-vitest-runtime-unavailable] ${errorText(error)}`, {
      cause: error,
    });
  }
  if (typeof electronPath !== "string" || electronPath.length === 0) {
    throw new Error("[electron-vitest-runtime-invalid] electron executable was not resolved");
  }
  if (typeof vitestPath !== "string" || vitestPath.length === 0) {
    throw new Error("[electron-vitest-runtime-invalid] Vitest entry was not resolved");
  }
  return { electronPath, vitestPath, normalizerPath };
}

export function createElectronVitestInvocation(
  args,
  {
    electronPath,
    vitestPath,
    normalizerPath = DEFAULT_NORMALIZER_PATH,
    cwd = process.cwd(),
    env = process.env,
    nodeExecPath = process.execPath,
    platform = process.platform,
  },
) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("[electron-vitest-args-invalid] Vitest arguments must be strings");
  }
  if (
    typeof electronPath !== "string" ||
    electronPath.length === 0 ||
    typeof vitestPath !== "string" ||
    vitestPath.length === 0 ||
    typeof normalizerPath !== "string" ||
    normalizerPath.length === 0
  ) {
    throw new Error("[electron-vitest-runtime-invalid] Electron and Vitest paths are required");
  }
  const normalizerOption = electronNodeNormalizerArgument(normalizerPath);
  return {
    command: electronPath,
    // Parent applications can disable startup environment options; fresh workers still need the initializer.
    args: [normalizerOption, vitestPath, ...args],
    options: {
      cwd,
      env: {
        ...env,
        // Child test processes inherit the initializer so their console children remain hidden.
        ...(platform === "win32" ? {
          NODE_OPTIONS: guardedNodeOptions(guardedNodeOptions(env.NODE_OPTIONS), normalizerPath),
        } : {}),
        ELECTRON_RUN_AS_NODE: "1",
        AVE_TEST_NODE_EXEC_PATH: nodeExecPath,
      },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

export function runVitestUnderElectron(
  args,
  {
    spawnProcess = spawn,
    signalSource = process,
    electronPath,
    vitestPath,
    normalizerPath,
    cwd,
    env,
    nodeExecPath,
    platform,
  } = {},
) {
  const hasElectronPath = electronPath !== undefined;
  const hasVitestPath = vitestPath !== undefined;
  if (hasElectronPath !== hasVitestPath) {
    return Promise.reject(
      new Error(
        "[electron-vitest-runtime-invalid] electronPath and vitestPath must be provided together",
      ),
    );
  }
  const runtime = hasElectronPath
    ? {
        electronPath,
        vitestPath,
        normalizerPath: normalizerPath ?? DEFAULT_NORMALIZER_PATH,
      }
    : resolveElectronVitestRuntime();
  const invocation = createElectronVitestInvocation(args, {
    ...runtime,
    cwd,
    env,
    nodeExecPath,
    platform,
  });

  let child;
  try {
    child = spawnProcess(
      invocation.command,
      invocation.args,
      invocation.options,
    );
  } catch (error) {
    return Promise.reject(
      new Error(`[electron-vitest-launch-failed] ${errorText(error)}`, {
        cause: error,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const signalHandlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        signalSource.off(signal, handler);
      }
    };

    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill(signal);
        }
      };
      signalHandlers.set(signal, handler);
      signalSource.on(signal, handler);
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(`[electron-vitest-launch-failed] ${errorText(error)}`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal });
    });
  });
}

export function applyElectronVitestResult(result, targetProcess = process) {
  if (result.signal) {
    try {
      targetProcess.kill(targetProcess.pid, result.signal);
      return;
    } catch {
      targetProcess.exitCode = 1;
      return;
    }
  }
  targetProcess.exitCode = Number.isInteger(result.code) ? result.code : 1;
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  try {
    ensureGeneratedAssets();
    await (await import("./build-skill-scripts.mjs")).buildSkillScripts();
    const result = await runVitestUnderElectron(process.argv.slice(2));
    applyElectronVitestResult(result);
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}

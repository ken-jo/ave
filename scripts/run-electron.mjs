import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  headlessLaunchArgs,
  prepareHeadlessLaunchEnv,
} from "./lib/headless-launch-options.mjs";
import {
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";
import { ensureElectronNativeModules } from "./lib/electron-native-modules.mjs";

const args = process.argv.slice(2);
const env = { ...process.env };
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
delete env.ELECTRON_RUN_AS_NODE;

// Windowless commands select the server entry before any desktop process starts.
const commandArgs = headlessLaunchArgs(args);
if (commandArgs) {
  prepareHeadlessLaunchEnv(env);
  const entry = fileURLToPath(new URL("../dist/src/main/headless.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry, ...commandArgs], {
    env: { ...env, NODE_ENV: env.NODE_ENV || "development" },
    stdio: "inherit",
  });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exit(result.status ?? 1);
}

const { default: electronPath } = await import("electron");
ensureElectronNativeModules({ repoRoot });

// Set development logging before module load unless the caller already selected an environment.
if (!env.NODE_ENV) {
  env.NODE_ENV = "development";
}

if (!env.AVE_DEV_CONSOLE) {
  env.AVE_DEV_CONSOLE = "0";
}
prepareElectronLaunchEnv(env);

// Restricted desktop GPU and sandbox initialization can fail before the window appears.
// Keep launch flags aligned with the shared platform policy.
args.splice(0, args.length, ...prepareElectronLaunchArgs(args, env, {
  profileName: "Electron-Ave-Run",
}));

// Code-page changes must share the child console.
// Preserve nested executable-path quoting through the shell wrapper.
if (process.platform === "win32") {
  if (env.AVE_DEBUG === "1") {
    process.stderr.write(
      `[run-electron] args=${JSON.stringify(args)}\n` +
        `[run-electron] AVE_DEV=${env.AVE_DEV} AVE_KEEP_GPU=${env.AVE_KEEP_GPU ?? "<unset>"}\n`,
    );
  }
  const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const electronCmd = [electronPath, ...args].map(quote).join(" ");
  const result = spawnSync(`chcp 65001>nul & ${electronCmd}`, [], {
    env,
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 1);
}

const result = spawnSync(electronPath, args, {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);

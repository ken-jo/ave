// Isolate every job path from the account profile. Native Windows fixtures also
// need the system volume's aliases and trusted volume-root ownership.
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

function systemVolume(systemRoot) {
  const root = typeof systemRoot === "string" ? win32.parse(systemRoot).root : "";
  if (!/^[a-z]:\\$/i.test(root)) throw new Error("Job isolation requires a local system volume");
  return root;
}

export function isolationAssignments({ platform, runnerTemp, systemRoot }, create = mkdtempSync) {
  const paths = platform === "win32" ? win32 : posix;
  const root = platform === "win32" ? create(paths.join(systemVolume(systemRoot), "ave-ci-")) : runnerTemp;
  const home = paths.join(root, "home");
  const temp = paths.join(root, "tmp");
  // Leave room for confined-process socket names and their terminators.
  if (platform === "darwin" && Buffer.byteLength(temp) + 32 > 103) {
    throw new Error("Job temp directory is too long for a Unix socket path");
  }
  return {
    HOME: home, USERPROFILE: home, AVE_HOME: paths.join(home, ".ave"),
    TMPDIR: temp, TEMP: temp, TMP: temp,
    ...(platform === "win32" ? {
      LOCALAPPDATA: paths.join(home, "local-app-data"), APPDATA: paths.join(home, "app-data"),
      AVE_TEST_TMP_ROOT: paths.join(home, ".ave-test-tmp"), AVE_CI_JOB_ROOT: root,
    } : {}),
  };
}

export function validateJobHomeRoot(root, systemRoot) {
  const volume = systemVolume(systemRoot);
  if (typeof root !== "string" || win32.dirname(root).toLowerCase() !== volume.toLowerCase()
    || !/^ave-ci-[a-z0-9]{6}$/i.test(win32.basename(root)) || win32.normalize(root) !== root) {
    throw new Error("Cleanup requires an isolated job root directly on the system volume");
  }
  return root;
}

function main() {
  if (process.argv.includes("--cleanup")) {
    const root = validateJobHomeRoot(process.env.AVE_CI_JOB_ROOT, process.env.SystemRoot);
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()
      || realpathSync.native(root).toLowerCase() !== root.toLowerCase()) {
      throw new Error("Cleanup requires an unchanged isolated job root");
    }
    rmSync(root, { recursive: true, force: true });
    return;
  }
  const { RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv, SystemRoot: systemRoot } = process.env;
  if (!runnerTemp || !githubEnv) throw new Error("RUNNER_TEMP and GITHUB_ENV must be set");
  const values = isolationAssignments({ platform: process.platform, runnerTemp, systemRoot });
  for (const path of [values.HOME, values.TEMP, values.LOCALAPPDATA, values.APPDATA]) {
    if (path !== undefined) mkdirSync(path, { recursive: true });
  }
  appendFileSync(githubEnv, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
  for (const [name, value] of Object.entries(values)) console.log(`${name} = ${value}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

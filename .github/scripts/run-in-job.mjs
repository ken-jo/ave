// Runs one CI test command inside the job launcher's kill-on-close job. The
// launcher records "0" in a fresh receipt only after it has terminated the job
// and proven it empty; cleanup refuses the job root without that proof.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsJobLauncherPath } from "../../scripts/prepare-windows-job.mjs";

export const JOB_RECEIPTS = "job-receipts";
const REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));

export function resolveCommand(command, path = process.env.PATH ?? "") {
  if (win32.isAbsolute(command)) return command;
  if (/[\\/]/u.test(command)) throw new Error(`Contained commands are absolute paths or PATH names: ${command}`);
  const name = /\.exe$/iu.test(command) ? command : `${command}.exe`;
  for (const directory of path.split(";")) {
    if (!win32.isAbsolute(directory)) continue;
    const candidate = win32.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot find ${name} on PATH`);
}

export function runInJob(command, args, {
  root = process.env.AVE_CI_JOB_ROOT, launcher = win32.join(REPOSITORY, windowsJobLauncherPath()), path,
} = {}) {
  if (!root || !win32.isAbsolute(root)) throw new Error("Contained test commands require AVE_CI_JOB_ROOT");
  const receipt = win32.join(root, JOB_RECEIPTS, `${randomUUID()}.receipt`);
  // The launcher treats EOF on this never-written pipe as owner exit and still empties the job.
  const child = spawn(launcher, ["--receipt", receipt, resolveCommand(command, path), ...args],
    { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  return new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", code => done(code ?? 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("Usage: run-in-job.mjs <command> [args...]");
  process.exitCode = await runInJob(command, args);
}

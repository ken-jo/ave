// Runs one CI test command inside the job launcher's kill-on-close job. The
// wrapper registers the command's manifest step and the job-root identity in
// that step's receipt; the launcher appends "0" only after it has terminated
// the job and proven it empty. Cleanup refuses the job root without every
// step's proof.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsJobLauncherPath } from "../../scripts/prepare-windows-job.mjs";

export const JOB_RECEIPTS = "job-receipts";
const REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));

// Loaded on demand: job-root setup runs before packages are installed.
export async function containedStepManifest() {
  const { containedSteps } = await import("./check-windows-workflow.mjs");
  return containedSteps(readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8"));
}

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
  root, identity, manifest, launcher = join(REPOSITORY, windowsJobLauncherPath()), path,
} = {}) {
  if (!root || !isAbsolute(root)) throw new Error("Contained test commands require AVE_CI_JOB_ROOT");
  if (!/^\d+:\d+:\d+$/u.test(identity ?? "")) throw new Error("Contained test commands require AVE_CI_JOB_ROOT_IDENTITY");
  const invocation = [command, ...args].join(" ");
  const step = manifest?.find(entry => entry.invocation === invocation);
  if (!step) throw new Error(`Not a contained workflow step: ${invocation}`);
  const receipt = join(root, JOB_RECEIPTS, step.receipt);
  writeFileSync(receipt, `${step.id}\n${identity}\n`, { flag: "wx" });
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
  process.exitCode = await runInJob(command, args, {
    root: process.env.AVE_CI_JOB_ROOT, identity: process.env.AVE_CI_JOB_ROOT_IDENTITY,
    manifest: await containedStepManifest(),
  });
}

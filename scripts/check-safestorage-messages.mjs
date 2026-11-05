// The audit secret store quarantines only on Electron's exact decrypt-failure message and fails open on its exact transient
// message (src/audit/hmac-chain.ts). Fail when the installed Electron no longer ships either string, before an upgrade turns
// every permanent failure into a loud open failure or a transient one into an unexplained rethrow.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SOURCE = "src/audit/hmac-chain.ts";
const MESSAGE_NAMES = ["ELECTRON_DECRYPT_FAILED_MESSAGE", "ELECTRON_DECRYPT_TEMPORARILY_UNAVAILABLE_MESSAGE"];

export function readExpectedMessages(root = ROOT) {
  const text = readFileSync(join(root, SOURCE), "utf-8");
  return MESSAGE_NAMES.map((name) => {
    const match = new RegExp(`export const ${name} = "([^"]+)";`).exec(text);
    if (match === null) throw new Error(`${SOURCE} no longer declares ${name} as a plain string`);
    return { name, message: match[1] };
  });
}

/** The files that hold Electron's native strings: the executable, plus the framework on macOS. */
export function electronBinaries(root = ROOT) {
  const dist = join(root, "node_modules/electron/dist");
  const executable = readFileSync(join(root, "node_modules/electron/path.txt"), "utf-8").trim();
  const framework = join(dist, "Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework");
  return [join(dist, executable), ...(existsSync(framework) ? [framework] : [])];
}

export function checkSafeStorageMessages(root = ROOT, options = {}) {
  let expected;
  let binaries;
  try {
    expected = options.messages ?? readExpectedMessages(root);
    binaries = options.binaries ?? electronBinaries(root);
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
  const contents = [];
  for (const path of binaries) {
    try { contents.push(readFileSync(path)); }
    catch (error) { return { ok: false, problems: [`cannot read the installed Electron binary ${path}: ${error.message}`] }; }
  }
  const problems = expected
    .filter(({ message }) => !contents.some((bytes) => bytes.includes(message, 0, "utf-8")))
    .map(({ name, message }) => `the installed Electron no longer contains ${name} ("${message}"); update ${SOURCE}`);
  return { ok: problems.length === 0, problems };
}

export function runSafeStorageMessagesCli(options = {}) {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const result = checkSafeStorageMessages(options.root ?? ROOT, options);
  if (result.ok) {
    stdout("[safestorage-messages] OK — the installed Electron ships both decrypt messages");
    return 0;
  }
  for (const problem of result.problems) stderr(`[safestorage-messages] ${problem}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runSafeStorageMessagesCli();
}

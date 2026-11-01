import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Readers see either the previous complete observation or the next complete one.
export async function writeProbeJson(directory, name, value) {
  if (path.basename(name) !== name) throw new Error("Invalid probe journal name");
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx" });
    await rename(temporary, path.join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}

export function packagedMainArguments(argv) {
  const [runDirectory, mode, token, observerExecutable] = argv;
  if (argv.length !== 4 || !path.isAbsolute(runDirectory) || !["echo", "lifetime", "cancel"].includes(mode)
    || !/^[a-f0-9]{32}$/.test(token) || !path.isAbsolute(observerExecutable ?? "") || !/\.exe$/i.test(observerExecutable)) {
    throw new Error("Invalid packaged probe arguments");
  }
  return { runDirectory, mode, token, observerExecutable };
}

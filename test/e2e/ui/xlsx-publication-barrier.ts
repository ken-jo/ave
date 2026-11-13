import { createHash, randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLICATION_BARRIER_PRELUDE = String.raw`"use strict";
(() => {
  const fileSystem = require("node:fs");
  const [readyPath, releasePath] = process.argv.splice(4, 2);
  if (!readyPath || !releasePath || process.argv.length !== 4) throw new Error("Expected workbook publication markers");
  const nativeWrite = fileSystem.writeSync;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  let pending = true;
  fileSystem.writeSync = function(descriptor, bytes, ...args) {
    if (pending && Buffer.isBuffer(bytes) && bytes.length >= 4 && (args[0] ?? 0) === 0
        && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      pending = false;
      fileSystem.writeFileSync(readyPath, "ready\n", { flag: "wx", mode: 0o600 });
      while (!fileSystem.existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 10);
      fileSystem.writeSync = nativeWrite;
    }
    return Reflect.apply(nativeWrite, fileSystem, [descriptor, bytes, ...args]);
  };
})();
`;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Prepare an owned direct-script resource before a fresh application's manifest is pinned. */
export function prepareWorkbookPublicationBarrier(scriptsDirectory: string, workspace: string) {
  const manifestPath = join(scriptsDirectory, "manifest.json");
  const originalManifest = readFileSync(manifestPath);
  const manifest = JSON.parse(originalManifest.toString("utf8")) as { version: number; scripts: Record<string, string> };
  const producer = readFileSync(join(scriptsDirectory, "edit-xlsx.cjs"));
  if (manifest.version !== 1 || manifest.scripts["edit-xlsx.cjs"] !== digest(producer)) {
    throw new Error("Workbook producer does not match its resource manifest");
  }
  const name = `xlsx-publication-${randomBytes(6).toString("hex")}.cjs`;
  const scriptPath = join(scriptsDirectory, name);
  const readyPath = join(workspace, "publication-ready");
  const releasePath = join(workspace, "publication-release");
  const script = Buffer.concat([Buffer.from(PUBLICATION_BARRIER_PRELUDE), producer]);
  const preparedManifest = Buffer.from(`${JSON.stringify({ ...manifest,
    scripts: { ...manifest.scripts, [name]: digest(script) } }, null, 2)}\n`);
  writeFileSync(scriptPath, script, { flag: "wx", mode: 0o600 });
  try { writeFileSync(manifestPath, preparedManifest); }
  catch (error) {
    writeFileSync(manifestPath, originalManifest);
    unlinkSync(scriptPath);
    throw error;
  }
  let restored = false;
  return {
    scriptPath,
    readyPath,
    releasePath,
    release(): void {
      try { writeFileSync(releasePath, "release\n", { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(releasePath, "utf8") !== "release\n") throw error;
      }
    },
    /** Call only after the owned application and its command process have closed. */
    restore(): void {
      if (restored) return;
      if (!readFileSync(manifestPath).equals(preparedManifest) || !readFileSync(scriptPath).equals(script)) {
        throw new Error("Workbook fixture resources changed before restoration");
      }
      writeFileSync(manifestPath, originalManifest);
      unlinkSync(scriptPath);
      restored = true;
    },
  };
}

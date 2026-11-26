import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLICATION_BARRIER_PRELUDE = String.raw`"use strict";
(() => {
  const fileSystem = require("node:fs");
  if (process.argv.length === 4) return;
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
  const name = "edit-xlsx.cjs";
  const scriptPath = join(scriptsDirectory, name);
  const producer = readFileSync(scriptPath);
  if (manifest.version !== 1 || manifest.scripts[name] !== digest(producer)) {
    throw new Error("Workbook producer does not match its resource manifest");
  }
  const readyPath = join(workspace, "publication-ready");
  const releasePath = join(workspace, "publication-release");
  const script = Buffer.concat([Buffer.from(PUBLICATION_BARRIER_PRELUDE), producer]);
  const preparedManifest = Buffer.from(`${JSON.stringify({ ...manifest,
    scripts: { ...manifest.scripts, [name]: digest(script) } }, null, 2)}\n`);
  try {
    writeFileSync(scriptPath, script);
    writeFileSync(manifestPath, preparedManifest);
  } catch (error) {
    writeFileSync(scriptPath, producer);
    writeFileSync(manifestPath, originalManifest);
    throw error;
  }
  let restored = false;
  return {
    scriptPath,
    argv(runtime: string, workbookPath: string, requestPath: string): string[] {
      return [runtime, scriptPath, workbookPath, requestPath, readyPath, releasePath];
    },
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
      writeFileSync(scriptPath, producer);
      writeFileSync(manifestPath, originalManifest);
      restored = true;
    },
  };
}

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

export interface FixtureBuildIo {
  copy(source: string, target: string): void;
  write(path: string, bytes: Uint8Array): void;
  remove(path: string): void;
}

export const fileSystemIo: FixtureBuildIo = {
  copy: (source, target) => cpSync(source, target, { recursive: true, errorOnExist: true, force: false }),
  write: (path, bytes) => writeFileSync(path, bytes, { flag: "wx" }),
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5 }),
};

/** The PowerShell or POSIX command the model sends for this argv. */
export function renderWorkbookCommand(platform: NodeJS.Platform, argv: readonly string[]): string {
  return platform === "win32"
    ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${argv.map((value) => `'${value.replaceAll("'", "''")}'`).join(" ")}`
    : `ELECTRON_RUN_AS_NODE=1 ${argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ")}`;
}

/**
 * Copy the checkout's build into a disposable root that only one application instance runs, then install the
 * publication prelude there. The checkout's build is only read. Leftover roots stay in the checkout's ignored cache.
 */
export function prepareWorkbookPublicationBuild(checkout: string, workspace: string, io: FixtureBuildIo = fileSystemIo) {
  const sharedScripts = join(checkout, "dist", "skill-scripts");
  const manifest = JSON.parse(readFileSync(join(sharedScripts, "manifest.json"), "utf8")) as { version: number; scripts: Record<string, string> };
  const name = "edit-xlsx.cjs";
  const producer = readFileSync(join(sharedScripts, name));
  if (manifest.version !== 1 || manifest.scripts[name] !== digest(producer)) {
    throw new Error("Workbook producer does not match its resource manifest");
  }
  // The host verifier's script name shape: a direct basename, so no copy can leave the disposable root.
  const invalid = Object.keys(manifest.scripts).find((entry) => !/^[a-z][a-z0-9-]*.cjs$/.test(entry));
  if (invalid !== undefined) throw new Error(`Resource manifest names a script outside its directory: ${JSON.stringify(invalid)}`);
  const script = Buffer.concat([Buffer.from(PUBLICATION_BARRIER_PRELUDE), producer]);
  const preparedManifest = Buffer.from(`${JSON.stringify({ ...manifest,
    scripts: { ...manifest.scripts, [name]: digest(script) } }, null, 2)}\n`);
  const outputs = join(checkout, ".cache");
  mkdirSync(outputs, { recursive: true });
  const root = realpathSync.native(mkdtempSync(join(outputs, "xlsx-publication-build-")));
  const scriptsDirectory = join(root, "dist", "skill-scripts");
  const scriptPath = join(scriptsDirectory, name);
  try {
    io.copy(join(checkout, "dist", "src"), join(root, "dist", "src"));
    io.copy(join(checkout, "resources"), join(root, "resources"));
    if (existsSync(join(checkout, "build"))) io.copy(join(checkout, "build"), join(root, "build"));
    mkdirSync(scriptsDirectory);
    for (const entry of Object.keys(manifest.scripts)) {
      if (entry !== name) io.copy(join(sharedScripts, entry), join(scriptsDirectory, entry));
    }
    io.write(scriptPath, script);
    io.write(join(scriptsDirectory, "manifest.json"), preparedManifest);
  } catch (error) {
    try { io.remove(root); } catch { /* A leftover root is never consumed by another instance. */ }
    throw error;
  }
  const readyPath = join(workspace, "publication-ready");
  const releasePath = join(workspace, "publication-release");
  let disposed = false;
  return {
    root,
    mainEntry: join(root, "dist", "src", "main", "main.js"),
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
    dispose(): void {
      if (disposed) return;
      io.remove(root);
      disposed = true;
    },
  };
}

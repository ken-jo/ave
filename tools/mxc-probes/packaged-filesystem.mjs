import { cp, lstat, readdir } from "node:fs/promises";
import path from "node:path";

// These operations are serialized by the controller. Archive handling must be
// restored before the copied application's entry is loaded.
export async function withOrdinaryFilesystem(operation) {
  const owned = Object.hasOwn(process, "noAsar"), previous = process.noAsar;
  process.noAsar = true;
  try { return await operation(); }
  finally {
    if (owned) process.noAsar = previous;
    else delete process.noAsar;
  }
}

async function walkOrdinaryTree(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error("Packaged probe refuses redirected source files");
  if (!info.isDirectory()) return;
  for (const name of await readdir(directory)) await walkOrdinaryTree(path.join(directory, name));
}

export async function assertOrdinaryTree(directory) {
  return withOrdinaryFilesystem(() => walkOrdinaryTree(directory));
}

export async function copyPackagedTree(source, destination) {
  return withOrdinaryFilesystem(async () => {
    await walkOrdinaryTree(source);
    await cp(source, destination, { recursive: true, dereference: false });
  });
}

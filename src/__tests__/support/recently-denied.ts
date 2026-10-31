import { dirname } from "node:path";
import { RecentlyDeniedStore } from "../../permissions/reviewer/recently-denied.js";
import { readJsonFile, writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { refuseNamespaceFileCreation } from "./feature-namespace.js";

/** Keep denial history inside the owning test's temporary directory. */
export function makeRecentlyDeniedStore(filePath: string): RecentlyDeniedStore {
  return new RecentlyDeniedStore({
    dir: dirname(filePath),
    readJson: <T>(_name: string, fallback: T) => readJsonFile(filePath, fallback),
    writeJson: async (_name, value) => writeFileAtomicAtPath(filePath, JSON.stringify(value)),
    childDir: async () => { throw new Error("Child directories are unavailable in this test namespace."); },
    createFile: refuseNamespaceFileCreation,
  });
}

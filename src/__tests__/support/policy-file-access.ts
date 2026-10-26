import { lstat, readFile, stat } from "node:fs/promises";
import type { PolicyFileAccess } from "../../marketplace/sources/policy.js";

export const plainPolicyFileAccess: PolicyFileAccess = {
  stat: (path) => stat(path, { bigint: true }),
  lstat: (path) => lstat(path),
  readFile: (path) => readFile(path, "utf8"),
  now: () => Date.now(),
};

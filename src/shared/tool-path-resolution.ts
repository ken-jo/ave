import { resolve as pathResolve } from "node:path";
import { expandLeadingTilde } from "./home-tilde.js";

/** Enforcement and review must resolve the same tilde-expanded path against invocation cwd, not process cwd. Prefix comparisons still require canonicalization and case folding. */
export function resolveToolPathForPermission(value: string, cwd: string): string {
  // Use the same home-tilde expansion as file tools or review may judge a different file.
  return pathResolve(pathResolve(cwd), expandLeadingTilde(value));
}

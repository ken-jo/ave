import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { policyHomeAnchors } from "./policy-home.js";

/** Permission and execution must expand to the same path: expand backslash forms only on Windows; named-user homes remain unsupported. */
export function leadingTildeHome(path: string): string | undefined {
  if (path !== "~" && !path.startsWith("~/") && !(process.platform === "win32" && path.startsWith("~\\"))) return undefined;
  // An empty home would resolve the rest under cwd; refuse instead.
  const home = homedir();
  if (!home) throw new Error("Cannot resolve home for path policy");
  return home;
}

export function expandLeadingTilde(path: string): string {
  const home = leadingTildeHome(path);
  return home === undefined ? path : path === "~" ? home : pathResolve(home, path.slice(2));
}

/** Shell operands are checked against every independent home anchor. */
export function expandShellTildePaths(path: string): string[] {
  if (path !== "~" && !path.startsWith("~/") && !(process.platform === "win32" && path.startsWith("~\\"))) return [path];
  const homes = policyHomeAnchors();
  return homes.map((home) => path === "~" ? home : pathResolve(home, path.slice(2)));
}

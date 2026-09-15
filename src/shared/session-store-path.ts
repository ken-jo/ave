import { join } from "node:path";
import { aveHome } from "./ave-home.js";

/** Primary session storage follows the configured application data root. */
export function sessionStorePath(applicationRoot: string = aveHome()): string {
  return join(applicationRoot, "sessions");
}

/** Share golden-file enumeration between recorders and schema readers. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Build POSIX-separated names from segments so Windows separators cannot change golden paths. */
export function goldenFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const named = `${prefix}${name}`;
      if (statSync(full).isDirectory()) walk(full, `${named}/`);
      else out.push(named);
    }
  };
  walk(dir, "");
  return out.sort();
}

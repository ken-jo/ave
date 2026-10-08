/**
 * The golden files a recording wrote, as the conformance suites walk them.
 *
 * Shared by `host-protocol-golden.test.ts`, which writes the recordings, and
 * `host-protocol-schema-parity.test.ts`, which reads them back — so the reader
 * walks the same files the recorder wrote.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every golden file under `dir`, relative to it and `/`-separated on every
 * platform: the names are built from segments rather than by `relative`, which
 * answers with `\` on Windows.
 */
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

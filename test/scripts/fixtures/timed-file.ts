// A fixture file with a fixed mtime, for the native-helper build scripts' staleness checks.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeTimedFile(root: string, relative: string, time: Date, content: string | Buffer = relative): void {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), content);
  utimesSync(join(root, relative), time, time);
}

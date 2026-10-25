import { readFile, readdir } from "node:fs/promises";

/** Scan all boot modules so source guards survive module moves; URL paths must retain the correct relative depth. */
export async function readBootWiring(): Promise<string> {
  const parts: string[] = [await readFile(new URL("../../boot.ts", import.meta.url), "utf8")];
  for (const dir of ["../../boot/", "../../boot/steps/"]) {
    const dirUrl = new URL(dir, import.meta.url);
    const entries = await readdir(dirUrl);
    for (const name of entries.sort()) {
      if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
        parts.push(await readFile(new URL(name, dirUrl), "utf8"));
      }
    }
  }
  return parts.join("\n");
}

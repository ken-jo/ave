import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { win32SystemBinary } from "../../shared/windows-system-path.js";
import { type PlantedProgram, withPlantedProgram as withFixture } from "./planted-program-posix.js";

export { installProgramsOnPath, type PlantedProgram, type ProgramsOnPath } from "./planted-program-posix.js";

const LOOKUP_VARIABLE = "NoDefaultCurrentDirectoryInExePath";

export async function withPlantedProgram<T>(names: readonly string[], use: (planted: PlantedProgram) => Promise<T> | T): Promise<T> {
  if (process.platform !== "win32") return withFixture(names, use);

  const previousLookup = process.env[LOOKUP_VARIABLE];
  // The regression must hold without the process-wide defense.
  delete process.env[LOOKUP_VARIABLE];
  try {
    return await withFixture(names, use, {
      separator: ";",
      plant(dir, name, marker) {
        for (const extension of [".exe", ".com"]) copyFileSync(win32SystemBinary("hostname.exe"), join(dir, `${name}${extension}`));
        writeFileSync(join(dir, `${name}.bat`), `@echo planted> "${marker}"\r\n`);
      },
    });
  } finally {
    if (previousLookup === undefined) delete process.env[LOOKUP_VARIABLE];
    else process.env[LOOKUP_VARIABLE] = previousLookup;
  }
}

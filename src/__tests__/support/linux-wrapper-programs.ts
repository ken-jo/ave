import { afterAll, beforeAll } from "vitest";
import { installProgramsOnPath, type ProgramsOnPath } from "./planted-program-posix.js";

/** Supply executable placeholders for suites that simulate Linux and stub the sandbox runtime. */
export function registerLinuxWrapperProgramFixtures(): void {
  let programs: ProgramsOnPath;
  beforeAll(() => { programs = installProgramsOnPath(["bwrap", "socat", "rg"], "linux"); });
  afterAll(async () => { await programs.restore(); });
}

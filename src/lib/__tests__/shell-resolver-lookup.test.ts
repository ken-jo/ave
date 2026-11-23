// The POSIX shell is resolved on the real file system from PATH only, so a planted sh in the cwd never becomes the shell.
import { describe, expect, it } from "vitest";
import { withPlantedProgram } from "../../__tests__/support/planted-program.js";
import { resolveShell, ShellMismatchError } from "../shell-resolver.js";

describe.runIf(process.platform !== "win32")("resolveShell program lookup", () => {
  it("refuses an sh reachable only through the cwd or empty and relative PATH entries", async () => {
    await withPlantedProgram(["sh"], () => {
      expect(() => resolveShell()).toThrow(ShellMismatchError);
    });
  });

  it("returns the absolute sh from a fully qualified PATH folder", async () => {
    await withPlantedProgram(["sh"], (planted) => {
      process.env.PATH = planted.dir;
      expect(resolveShell().cmd).toBe(`${planted.dir}/sh`);
    });
  });
});

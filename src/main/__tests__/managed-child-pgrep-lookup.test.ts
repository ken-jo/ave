// The POSIX tree kill lists children with a PATH-resolved pgrep, never one planted in the cwd.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { withPlantedProgram } from "../../__tests__/support/planted-program.js";
import { forceKillManagedChildProcess, trackManagedChildProcess } from "../managed-child-processes.js";

describe.runIf(process.platform !== "win32")("managed child tree kill program lookup", () => {
  it("never runs a pgrep planted in the cwd or reached through an empty or relative PATH entry", async () => {
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    trackManagedChildProcess(child, { label: "pgrep-lookup" });
    const exited = once(child, "exit");
    await withPlantedProgram(["pgrep"], async (planted) => {
      await forceKillManagedChildProcess(child, "pgrep lookup test");
      await exited;
      expect(planted.ran()).toBe(false);
    });
  });
});

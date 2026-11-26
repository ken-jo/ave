// windows-native
// The tailnet command-line program is launched from an absolute path, never from the current directory.
import { describe, expect, it } from "vitest";
import { withPlantedProgram } from "../../__tests__/support/planted-program.js";
import { runTailscaleCommand } from "../tailnet-cli.js";

describe("runTailscaleCommand program lookup", () => {
  it("reports not-found instead of running a planted program from the cwd or an empty or relative PATH entry", async () => {
    await withPlantedProgram(["tailscale"], async (planted) => {
      expect(await runTailscaleCommand("tailscale", ["version"])).toEqual({ kind: "not-found" });
      expect(planted.ran()).toBe(false);
    });
  });

  it("runs a program found in a fully qualified PATH folder", async () => {
    await withPlantedProgram(["tailscale"], async (planted) => {
      process.env.PATH = planted.dir;
      expect(await runTailscaleCommand("tailscale", [])).toMatchObject({ kind: "ran", code: 0 });
    });
  });
});

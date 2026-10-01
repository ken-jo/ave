/**
 * `PerCommandFilesystem.pinWriteRoots` — the one mechanism that keeps
 * plugin-owned code from removing or replacing the host-created roots it writes
 * into. Its own file because one of these cases is about the FIRST wrap of a
 * process: the app-owned temp root does not exist until a wrap creates it, and
 * a pin computed before that would silently leave the temp root unpinned.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appOwnedSandboxTempRoot,
  buildPerCommandSandboxCustomConfig,
  getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapWorkerCommand,
} from "../asrt-sandbox.js";
import { asrtCanInitialize } from "./test-helpers.js";

const MARKER = ".ave-pinned-write-root";
let home: string;
let previousAveHome: string | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ave-pin-"));
  previousAveHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(home, ".ave");
});

afterAll(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(home, { recursive: true, force: true });
});

describe("pinned write roots", () => {
  it.runIf(process.platform === "darwin")(
    "pins the app-owned temp root on the first wrap of a process, which is the wrap that creates it",
    async () => {
      if (!(await asrtCanInitialize())) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
        return;
      }
      const tempRoot = appOwnedSandboxTempRoot();
      const dataDir = join(home, "data");
      mkdirSync(dataDir);
      expect(existsSync(tempRoot), "the temp root existed before the first wrap").toBe(false);
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const { argv } = await wrapWorkerCommand("true", {
        filesystem: {
          allowWrite: [tempRoot, dataDir],
          denyRead: [],
          denyWrite: getDefaultSensitiveWriteDenyPaths(),
          pinWriteRoots: true,
        },
      });
      const profile = argv.join("\n");
      for (const root of [tempRoot, dataDir]) {
        const real = realpathSync(root);
        expect(profile, `no marker deny for ${real}`).toContain(`(subpath "${join(real, MARKER)}")`);
        expect(profile, `no literal pin for ${real}`).toContain(`(literal "${real}")`);
      }
    },
  );

  it("adds no marker without the flag, and none off macOS", () => {
    const dataDir = mkdtempSync(join(home, "plain-"));
    const unpinned = buildPerCommandSandboxCustomConfig({ allowWrite: [dataDir], denyWrite: [] });
    expect(unpinned?.filesystem?.denyWrite).toEqual([]);
    const pinned = buildPerCommandSandboxCustomConfig({ allowWrite: [dataDir], denyWrite: [], pinWriteRoots: true });
    expect(pinned?.filesystem?.denyWrite).toEqual(
      process.platform === "darwin" ? [join(realpathSync(dataDir), MARKER)] : [],
    );
  });

  it("refuses the flag without a restated deny floor, which a per-command denyWrite replaces", () => {
    expect(() => buildPerCommandSandboxCustomConfig({ allowWrite: [home], pinWriteRoots: true }))
      .toThrow(/pinWriteRoots needs denyWrite restated/);
  });
});

import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
// Pin newly created write roots before the first wrap; computing pins before creation silently drops them and permits replacement.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";

import {
  appOwnedSandboxTempRoot,
  buildPerCommandSandboxCustomConfig,
  ensureSandboxTempPrincipalDir,
  getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapWorkerCommand,
} from "../asrt-sandbox.js";
import { asrtCanInitialize, profileOfWrappedArgv, profileRules } from "./test-helpers.js";

const MARKER = ".ave-pinned-write-root";
let home: string;
let previousAveHome: string | undefined;

beforeAll(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
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
    "pins a principal's temp directory on the first wrap of a process, created for that wrap",
    async () => {
      if (!(await asrtCanInitialize())) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
        return;
      }
      const dataDir = join(home, "data");
      mkdirSync(dataDir);
      expect(existsSync(appOwnedSandboxTempRoot()), "the temp root existed before the first wrap").toBe(false);
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const { dir: tempDir } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "pinned" });
      const { argv } = await wrapWorkerCommand("true", { commandId: TEST_COMMAND_ID,
        filesystem: {
          allowWrite: [tempDir, dataDir],
          denyRead: [],
          denyWrite: getDefaultSensitiveWriteDenyPaths(),
          pinWriteRoots: true,
        },
      });
      // A rule's path filters, with the ones that share a parent folded into one regex expanded again.
      const filters = new Set(profileRules(profileOfWrappedArgv(argv)).flatMap((rule) => rule.filters));
      for (const root of [tempDir, dataDir]) {
        const real = realpathSync(root);
        expect(filters.has(`(subpath ${JSON.stringify(join(real, MARKER))})`), `no marker deny for ${real}`).toBe(true);
        expect(filters.has(`(literal ${JSON.stringify(real)})`), `no literal pin for ${real}`).toBe(true);
      }
    },
  );

  it("adds no marker without the flag, and none off macOS", () => {
    const dataDir = mkdtempSync(join(home, "plain-"));
    const unpinned = buildPerCommandSandboxCustomConfig({ allowWrite: [dataDir], denyWrite: [] });
    expect(unpinned?.filesystem?.denyWrite?.some((path) => typeof path === "string" && path.endsWith(MARKER))).toBe(false);
    const pinned = buildPerCommandSandboxCustomConfig({ allowWrite: [dataDir], denyWrite: [], pinWriteRoots: true });
    expect(pinned?.filesystem?.denyWrite?.includes(join(realpathSync(dataDir), MARKER))).toBe(process.platform === "darwin");
  });

  it("refuses the flag without a restated deny floor, which a per-command denyWrite replaces", () => {
    expect(() => buildPerCommandSandboxCustomConfig({ allowWrite: [home], pinWriteRoots: true }))
      .toThrow(/pinWriteRoots needs denyWrite restated/);
  });
});

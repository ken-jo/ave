import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupTmpDir } from "./support/tmp-dir-teardown.js";
import { tsxChildEnv } from "./support/tsx-child-env.js";

it("runs a TypeScript child without leaving a compile cache in its temp root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-child-cache-"));
  const fixture = "entry.mts";
  try {
    const entry = join(root, fixture);
    writeFileSync(entry, "enum Payload { Answer = 42 }\nconsole.log(Payload.Answer);\n");
    const result = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, ["--import=tsx", entry], {
      env: tsxChildEnv({ ELECTRON_RUN_AS_NODE: "1", TMPDIR: root, TEMP: root, TMP: root, TSX_DISABLE_CACHE: "" }),
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("42");
    expect(readdirSync(root)).toEqual([fixture]);
  } finally {
    await cleanupTmpDir(root);
  }
});

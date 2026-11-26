import { tsxChildEnv } from "../../../__tests__/support/tsx-child-env.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readCurrentModelCatalog } from "../cache.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "refresh-process.ts");
const repoRoot = resolve(here, "../../../..");

async function refreshInProcess(home: string): Promise<string> {
  const child = spawn(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, ["--import=tsx", fixture, home], {
    cwd: repoRoot, env: tsxChildEnv({ AVE_HOME: home }), stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  });
  let stdout = "";
  let stderr = "";
  let processError: Error | undefined;
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolveExit, reject) => {
    child.once("error", (error) => { processError = error; });
    child.once("close", (code, signal) => {
      if (processError) reject(processError);
      else if (code !== 0) reject(new Error(`refresh writer exited ${signal ?? code}: ${stderr}`));
      else resolveExit(stdout.trim());
    });
  });
}

it("serializes separate processes sharing one cache into a single request", async () => {
  const home = mkdtempSync(join(tmpdir(), "catalog-shared-home-"));
  try {
    // A failure in either refresh cannot release the shared directory while its peer writes.
    const results = await Promise.allSettled([refreshInProcess(home), refreshInProcess(home)]);
    const statuses = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(readFileSync(join(home, "requests.log"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect(statuses.sort()).toEqual(["fresh", "updated"]);
    expect(await readCurrentModelCatalog(join(home, "cache", "model-catalog"))).toMatchObject({ ok: true });
  } finally {
    await cleanupTmpDir(home);
  }
});

import { tsxChildEnv } from "../../../__tests__/support/tsx-child-env.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { deferred } from "../../../__tests__/support/deferred.js";
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

function refreshInProcess(home: string, writer: "first" | "second") {
  const child = spawn(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, ["--import=tsx", fixture, home, writer], {
    cwd: repoRoot, env: tsxChildEnv({ AVE_HOME: home }), stdio: ["ignore", "pipe", "pipe", "ipc"], timeout: 10_000,
  });
  const checkpoint = deferred<void>();
  child.once("message", (message) => {
    if (message === (writer === "first" ? "response-held" : "lock-contended")) checkpoint.resolve();
  });
  let stdout = "";
  let stderr = "";
  let processError: Error | undefined;
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const closed = new Promise<string>((resolveExit, reject) => {
    child.once("error", (error) => { processError = error; });
    child.once("close", (code, signal) => {
      if (processError) reject(processError);
      else if (code !== 0) reject(new Error(`${writer} refresh writer exited ${signal ?? code}: ${stderr}`));
      else resolveExit(stdout.trim());
    });
  });
  return { child, checkpoint: checkpoint.promise, closed };
}

it("serializes separate processes sharing one cache into a single request", async () => {
  const home = mkdtempSync(join(tmpdir(), "catalog-shared-home-"));
  try {
    const first = refreshInProcess(home, "first");
    let second: ReturnType<typeof refreshInProcess> | undefined;
    try {
      await Promise.race([first.checkpoint, first.closed.then((status) => {
        throw new Error(`first refresh exited before holding its response: ${status}`);
      })]);
      second = refreshInProcess(home, "second");
      // A refresh that bypasses the lock can finish here while the first response is still held.
      const attempt = await Promise.race([second.checkpoint.then(() => "lock-contended"), second.closed]);
      expect(attempt).toBe("lock-contended");
    } finally {
      if (first.child.connected) first.child.send("release-response");
      // Keep the shared directory until both children close, even on failure.
      await Promise.allSettled(second ? [first.closed, second.closed] : [first.closed]);
    }
    expect(readFileSync(join(home, "requests.log"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect([await first.closed, await second.closed]).toEqual(["updated", "fresh"]);
    expect(await readCurrentModelCatalog(join(home, "cache", "model-catalog"))).toMatchObject({ ok: true });
  } finally {
    await cleanupTmpDir(home);
  }
});

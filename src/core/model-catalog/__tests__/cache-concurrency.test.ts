import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readCurrentModelCatalog } from "../cache.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "refresh-process.ts");
const repoRoot = resolve(here, "../../../..");

function refreshInProcess(home: string): Promise<string> {
  const child = spawn(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, ["--import=tsx", fixture, home], {
    cwd: repoRoot, env: { ...process.env, AVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveExit(stdout.trim()) : reject(new Error(`refresh writer exited ${code}: ${stderr}`)));
  });
}

it("serializes separate processes sharing one cache into a single request", async () => {
  const home = mkdtempSync(join(tmpdir(), "catalog-shared-home-"));
  try {
    const statuses = await Promise.all([refreshInProcess(home), refreshInProcess(home)]);
    expect(readFileSync(join(home, "requests.log"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect(statuses.sort()).toEqual(["fresh", "updated"]);
    expect(await readCurrentModelCatalog(join(home, "cache", "model-catalog"))).toMatchObject({ ok: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

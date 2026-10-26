import { configureHostResources } from "../../main/host-resources.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { ensureAveHomePrivate } from "../ave-home.js";

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });

const paths = useTempPaths("host-ownership-", ".ave");
const require = createRequire(import.meta.url);
const lockSource = fileURLToPath(new URL("../../main/host-instance-lock.ts", import.meta.url));
const accessSource = fileURLToPath(new URL("../ave-home-configuration-access.ts", import.meta.url));
const migrationSource = fileURLToPath(new URL("../ave-home-configuration.ts", import.meta.url));

function fixture(): { home: string; script: string } {
  const home = paths();
  setFixtureOwner(dirname(home));
  expect(ensureAveHomePrivate(home).enforcement).not.toBe("none");
  const script = join(dirname(home), "owner.cjs");
  buildSync({ stdin: { contents: `
    import { configureHostResources } from ${JSON.stringify(fileURLToPath(new URL("../../main/host-resources.ts", import.meta.url)))};
    configureHostResources({ resourcePath: ${JSON.stringify(resolve("resources"))}, isPackaged: false });
    import { acquireHostInstanceLock } from ${JSON.stringify(lockSource)};
    import { isAveHomeConfigurationOwner, withAveHomeConfigurationWrite } from ${JSON.stringify(accessSource)};
    import { migrateAveHomeConfiguration } from ${JSON.stringify(migrationSource)};
    const fs = require('node:fs'), path = require('node:path');
    (async () => {
      try {
        await acquireHostInstanceLock();
        migrateAveHomeConfiguration(process.env.AVE_HOME);
        await withAveHomeConfigurationWrite(path.join(process.env.AVE_HOME, 'settings.json'), async target => fs.writeFileSync(target, '{}'));
        console.log(JSON.stringify({owner:isAveHomeConfigurationOwner(), wrote:true}));
      } catch(error) { console.log(JSON.stringify({name:error.name, message:error.message})); }
      process.stdin.resume(); process.stdin.once('data', () => process.exit(0));
    })();`, resolveDir: dirname(lockSource) }, bundle: true, platform: "node", format: "cjs", outfile: script,
    external: ["electron", "better-sqlite3"] });
  return { home, script };
}

function start(home: string, script: string): { child: ChildProcess; result: Promise<unknown>; exited: Promise<void> } {
  const child = spawn(process.execPath, [script], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AVE_HOME: home, NODE_PATH: dirname(dirname(require.resolve("better-sqlite3/package.json"))) },
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const result = new Promise<unknown>((resolve, reject) => {
    let output = "", errors = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) { try { resolve(JSON.parse(output.split("\n")[0]!)); } catch (error) { reject(error); } }
    });
    child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", () => { if (!output.includes("\n")) reject(new Error(errors || "Owner process exited without a result")); });
  });
  return { child, result, exited };
}

async function stop(process: ReturnType<typeof start>): Promise<void> {
  process.child.stdin!.end("release\n");
  await process.exited;
}

describe("shared host instance ownership", () => {
  it("makes a headless host alone the owner and allows migration and writes", async () => {
    const { home, script } = fixture();
    const host = start(home, script);
    try { expect(await host.result).toEqual({ owner: true, wrote: true }); }
    finally { await stop(host); }
  });

  for (const incumbent of ["interactive", "headless"]) {
    it(`refuses a headless writer while the ${incumbent} host holds the real shared lock`, async () => {
      const { home, script } = fixture();
      const owner = start(home, script);
      try {
        expect(await owner.result).toEqual({ owner: true, wrote: true });
        const contender = start(home, script);
        try {
          expect(await contender.result).toEqual({ name: "AveHomeConfigurationNotOwnerError", message: "Ave is running; close it or use the app" });
        } finally { await stop(contender); }
      } finally { await stop(owner); }
    });
  }
});

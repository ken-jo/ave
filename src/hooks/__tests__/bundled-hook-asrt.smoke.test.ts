import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, getDefaultSensitiveReadDenyPaths } from "../../permissions/asrt-sandbox.js";
import {
  __resetSandboxRequestedAtBootForTest,
  setPluginWorkerConfinementRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { sandboxCasesRun } from "../../plugins/isolation/__tests__/sandbox-cases.js";
import { runOneHookScript } from "../script-hook-runner.js";
import type { ScriptHookStdin } from "../script-hook-types.js";

const testHome = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:os", async (original) => {
  const real = await original<typeof import("node:os")>();
  return { ...real, homedir: () => testHome.path ?? real.homedir() };
});

const payload: ScriptHookStdin = { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin",
  category: "read", input: {}, sessionId: "hook-smoke", trustOrigin: "user-keyboard" };

const NEIGHBOUR = "neighbour-plugin-bytes";

// A plugin hook is wrapped only while plugin-worker confinement was requested at boot.
beforeEach(() => setPluginWorkerConfinementRequestedAtBoot(true));

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  __resetSandboxRequestedAtBootForTest();
  testHome.path = undefined;
  vi.unstubAllEnvs();
});

/**
 * Where a bundled hook's own directories sit, as production places them: under
 * the roots every plugin-owned wrap is refused (`denyPluginsRoot`), so the hook
 * runs only because its own generation is re-allowed (`ownPluginReads`) and
 * writes only because its data is granted — and the neighbours beside it stay
 * unread only because the roots are denied.
 */
const LAYOUTS = {
  // An entry plugin's hook (`plugin-hook-projection.ts`): its generation
  // payload in the plugin cache, its data in the plugin's own directory.
  "an entry plugin": (ave: string) => ({
    generationRoot: join(ave, "plugins", ".cache", "smoke-plugin", "generations", "g", "payload"),
    dataDir: join(ave, "plugins", "smoke-plugin", "data"),
  }),
  // An agent plugin's hook (`agent-plugin-hook-runtime.ts`): its installed
  // version in the content store, its data in the `agent-plugin-data` namespace.
  "an agent plugin": (ave: string) => ({
    generationRoot: join(ave, "packages", "agent-plugin", "smoke-plugin", "1.0.0"),
    dataDir: join(ave, "agent-plugin-data", "smoke-plugin"),
  }),
} as const;

describe("bundled hook process smoke", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux").for(Object.keys(LAYOUTS) as (keyof typeof LAYOUTS)[])(
    "spawns %s's hook from under the plugin roots and denies secret and neighbour reads, outside writes, and unlisted sockets",
    async (kind, context) => {
      // A host without the sandbox backend (the Linux suite runner has no
      // bubblewrap) cannot measure this: the case is skipped there, visibly,
      // and fails instead wherever AVE_REQUIRE_SANDBOX_CASES says it must run.
      if (!(await sandboxCasesRun())) return context.skip("the ASRT sandbox cannot initialize on this host");
      const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-hook-asrt-")));
      const ave = join(root, "ave-home");
      const { generationRoot, dataDir } = LAYOUTS[kind](ave);
      const neighbours = [
        join(ave, "plugins", "neighbour", "data"),
        join(ave, "agent-plugin-data", "neighbour"),
        join(ave, "packages", "agent-plugin", "neighbour", "1.0.0"),
      ];
      const fakeHome = join(root, "home");
      for (const dir of [generationRoot, dataDir, join(fakeHome, ".ssh"), ...neighbours]) mkdirSync(dir, { recursive: true });
      for (const dir of neighbours) writeFileSync(join(dir, "s"), NEIGHBOUR);
      // The control: unconfined, every neighbour sentinel is readable.
      for (const dir of neighbours) expect(readFileSync(join(dir, "s"), "utf8")).toBe(NEIGHBOUR);
      const secret = join(fakeHome, ".ssh", "fixture-key");
      const outside = join(root, "outside.txt");
      const script = join(generationRoot, "hook.cjs");
      writeFileSync(secret, "fixture-private");
      writeFileSync(script, `const fs = require('node:fs'); const net = require('node:net');
const [secret, outside, data, port, ...neighbours] = process.argv.slice(2);
let read = false, outsideWrite = false, dataWrite = false, socket = false;
const neighbourReads = neighbours.map((file) => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { return error.code; } });
try { read = fs.readFileSync(secret, 'utf8') === 'fixture-private'; } catch {}
try { fs.writeFileSync(outside, 'wrong'); outsideWrite = true; } catch {}
try { fs.writeFileSync(data, 'allowed'); dataWrite = fs.readFileSync(data, 'utf8') === 'allowed'; } catch {}
const connection = net.connect(Number(port), '127.0.0.1');
connection.setTimeout(500);
connection.on('connect', () => { socket = true; connection.destroy(); });
connection.on('error', () => {}); connection.on('timeout', () => connection.destroy());
connection.on('close', () => process.stdout.write(JSON.stringify({ action: 'allow', reason: JSON.stringify({ read, outsideWrite, dataWrite, socket, neighbourReads }) })));`);
      vi.stubEnv("AVE_HOME", ave);
      testHome.path = fakeHome;
      expect(getDefaultSensitiveReadDenyPaths()).toContain(join(fakeHome, ".ssh"));
      const server = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing socket port");
      try {
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
        const result = await runOneHookScript({ id: "hook", hookType: "pre", source: "config",
          hookPath: script,
          command: ["node", script, secret, outside, join(dataDir, "state.json"), String(address.port), ...neighbours.map((dir) => join(dir, "s"))],
          confinement: { kind: "bundled", pluginId: "smoke-plugin", dataDir, generationRoot } }, payload, { timeoutMs: 4000 });
        expect(result.decision, result.reason).toBe("allow");
        const reported = JSON.parse(result.reason) as { neighbourReads: string[] };
        expect(reported).toMatchObject({ read: false, outsideWrite: false, dataWrite: true, socket: false });
        // Refused, never read: macOS reports EPERM; bubblewrap's tmpfs mask, ENOENT.
        for (const outcome of reported.neighbourReads) expect(["EPERM", "EACCES", "ENOENT"]).toContain(outcome);
        expect(readFileSync(join(dataDir, "state.json"), "utf8")).toBe("allowed");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await cleanupTmpDir(root);
      }
    },
  );
});

import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, getDefaultSensitiveReadDenyPaths } from "../../permissions/asrt-sandbox.js";
import { asrtCanInitialize } from "../../permissions/__tests__/test-helpers.js";
import { runOneHookScript } from "../script-hook-runner.js";
import type { ScriptHookStdin } from "../script-hook-types.js";

const testHome = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:os", async (original) => {
  const real = await original<typeof import("node:os")>();
  return { ...real, homedir: () => testHome.path ?? real.homedir() };
});

const payload: ScriptHookStdin = { hookType: "pre", event: "pre", toolName: "read_file", source: "builtin",
  category: "read", input: {}, sessionId: "hook-smoke", trustOrigin: "user-keyboard" };

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  testHome.path = undefined;
  vi.unstubAllEnvs();
});

describe("bundled hook process smoke", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "spawns a hook and denies secret reads, outside writes, and unlisted sockets",
    async () => {
      expect(await asrtCanInitialize()).toBe(true);
      const root = mkdtempSync(join(tmpdir(), "ave-hook-asrt-"));
      const generationRoot = join(root, "generation");
      const dataDir = join(root, "data");
      const fakeHome = join(root, "home");
      mkdirSync(generationRoot); mkdirSync(dataDir); mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
      const secret = join(fakeHome, ".ssh", "fixture-key");
      const outside = join(root, "outside.txt");
      const script = join(generationRoot, "hook.cjs");
      writeFileSync(secret, "fixture-private");
      writeFileSync(script, `const fs = require('node:fs'); const net = require('node:net');
const [secret, outside, data, port] = process.argv.slice(2);
let read = false, outsideWrite = false, dataWrite = false, socket = false;
try { read = fs.readFileSync(secret, 'utf8') === 'fixture-private'; } catch {}
try { fs.writeFileSync(outside, 'wrong'); outsideWrite = true; } catch {}
try { fs.writeFileSync(data, 'allowed'); dataWrite = true; } catch {}
const connection = net.connect(Number(port), '127.0.0.1');
connection.setTimeout(500);
connection.on('connect', () => { socket = true; connection.destroy(); });
connection.on('error', () => {}); connection.on('timeout', () => connection.destroy());
connection.on('close', () => process.stdout.write(JSON.stringify({ action: 'allow', reason: JSON.stringify({ read, outsideWrite, dataWrite, socket }) })));`);
      vi.stubEnv("AVE_HOME", join(root, "ave-home"));
      testHome.path = fakeHome;
      expect(getDefaultSensitiveReadDenyPaths()).toContain(join(fakeHome, ".ssh"));
      const server = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing socket port");
      try {
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
        const result = await runOneHookScript({ id: "hook", hookType: "pre", source: "config",
          hookPath: script, command: ["node", script, secret, outside, join(dataDir, "state.json"), String(address.port)],
          confinement: { kind: "bundled", pluginId: "smoke-plugin", dataDir, generationRoot } }, payload, { timeoutMs: 4000 });
        expect(result.decision, result.reason).toBe("allow");
        expect(JSON.parse(result.reason)).toEqual({ read: false, outsideWrite: false, dataWrite: true, socket: false });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await cleanupTmpDir(root);
      }
    },
  );
});

import { execFile, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { assertCodexExecutableLocation, assertCodexLocations, _resetDesktopPackageCacheForTest } from "../codex-executable-location.js";

const probeMode = vi.hoisted(() => ({ real: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fake = vi.fn();
  return {
    execFile: Object.assign((...args: Parameters<typeof actual.execFile>) =>
      probeMode.real ? actual.execFile(...args) : fake(...args), { fake }),
  };
});
const fakeExecFile = (execFile as unknown as { fake: ReturnType<typeof vi.fn> }).fake;

beforeEach(() => {
  _resetDesktopPackageCacheForTest();
  probeMode.real = false;
  fakeExecFile.mockImplementation((...args: unknown[]) => {
    const options = args[2] as { env: NodeJS.ProcessEnv };
    const currentSid = "S-1-5-21-100-200-300-1001";
    const paths = (JSON.parse(options.env.AVE_EXECUTABLE_ACL_PATHS!) as string[]).map((path) => ({
      path, owner: currentSid, daclPresent: true,
      entries: [{ sid: currentSid, mask: 0x1f01ff, flags: 0, type: 0 }],
    }));
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, JSON.stringify({ currentSid, paths, desktopPackage: options.env.AVE_ACL_DESKTOP_PACKAGE === "skip"
      ? { status: "skipped" } : { status: "unavailable", reason: "mapping-not-found" } }), "");
    return {} as ChildProcess;
  });
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTmpDir(root); });

// Stock Windows grants Authenticated Users FILE_ADD_SUBDIRECTORY on C:\, so this
// real probe reproduces the original refusal of every route on the system drive.
it.runIf(process.platform === "win32")("admits the real system command executable as a native route with real access rules", async () => {
  probeMode.real = true;
  await expect(assertCodexExecutableLocation(join(process.env.SystemRoot!, "System32", "cmd.exe"), "native",
    { capSidPath: join(tmpdir(), "absent-cap-fixture") })).resolves.toBeUndefined();
}, 30_000);

it.runIf(process.platform === "win32")("admits the system command executable as a native route with mocked access rules", async () => {
  await expect(assertCodexExecutableLocation(join(process.env.SystemRoot!, "System32", "cmd.exe"), "native",
    { capSidPath: join(tmpdir(), "absent-cap-fixture") })).resolves.toBeUndefined();
});

it.runIf(process.platform === "win32")("admits a temporary native executable with mocked access rules", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-native-route-")));
  roots.push(root);
  const trust = { capSidPath: join(root, "absent-cap-fixture") };
  await assertCodexLocations([{ path: root, kind: "directory", routeKind: "native" }], trust);
  const executable = join(root, "fixture.exe");
  copyFileSync(join(process.env.SystemRoot!, "System32", "cmd.exe"), executable);
  await expect(assertCodexExecutableLocation(executable, "native", trust)).resolves.toBeUndefined();
});

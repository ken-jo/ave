import { copyFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  assertCodexExecutableLocation,
  assertCodexLocations,
  _resetDesktopPackageCacheForTest,
  _resetWindowsAclHostForTest,
} from "../codex-executable-location.js";
import { windowsAclTransportSeam, type WindowsAclRequest } from "../windows-acl-host.js";

// Mocked access rules answer at the request level. The real case empties the
// seam, so the product's own ACL host runs.
const fakeRequest = vi.fn(async (request: WindowsAclRequest): Promise<string> => {
  const currentSid = "S-1-5-21-100-200-300-1001";
  const paths = request.paths.map((path) => ({
    path, owner: currentSid, daclPresent: true,
    entries: [{ sid: currentSid, mask: 0x1f01ff, flags: 0, type: 0 }],
  }));
  return JSON.stringify({ id: request.id, result: { currentSid, paths, desktopPackage: request.skipPackage
    ? { status: "skipped" } : { status: "unavailable", reason: "mapping-not-found" } } });
});

beforeEach(() => {
  _resetDesktopPackageCacheForTest();
  _resetWindowsAclHostForTest();
  windowsAclTransportSeam.override = { request: fakeRequest, discard: () => {} };
});

const roots: string[] = [];
afterEach(async () => {
  _resetWindowsAclHostForTest();
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

// Stock Windows grants Authenticated Users FILE_ADD_SUBDIRECTORY on C:\, so this
// real probe reproduces the original refusal of every route on the system drive.
it.runIf(process.platform === "win32")("admits the real system command executable as a native route with real access rules", async () => {
  windowsAclTransportSeam.override = undefined;
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

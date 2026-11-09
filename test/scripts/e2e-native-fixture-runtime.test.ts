import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { ElectronApplication } from "playwright";
import { cleanupNativeFixture, closeNativeFixture, launchNativeFixture, nativeFixturePaths } from "../e2e/ui/native-fixture-runtime.js";

const { quit } = vi.hoisted(() => ({ quit: vi.fn() }));
vi.mock("../e2e/ui/seeded-electron.js", () => ({ REPO_ROOT: process.cwd(), quitElectron: quit }));
afterEach(() => { quit.mockReset(); });

it("cleans allocated runtime and build assets when acquisition fails", async () => {
  let allocated: { runtime: string; assets: string } | undefined;
  await expect(launchNativeFixture("ave-native-acquisition-", async paths => {
    allocated = paths;
    expect(existsSync(paths.runtime)).toBe(true);
    expect(existsSync(paths.assets)).toBe(true);
    throw new Error("Fixture build or launch failed");
  })).rejects.toThrow("Fixture build or launch failed");
  if (!allocated) throw new Error("Fixture paths were not allocated");
  expect(existsSync(allocated.runtime)).toBe(false);
  expect(existsSync(allocated.assets)).toBe(false);
});

it("preserves runtime files until the native process has exited", async () => {
  const child = { exitCode: null as number | null, signalCode: null };
  const app = { process: () => child as ChildProcess } as ElectronApplication;
  await launchNativeFixture("ave-native-lifetime-", async () => app);
  const paths = nativeFixturePaths(app);
  try {
    await expect(cleanupNativeFixture(app)).rejects.toThrow("Native fixture process must exit before runtime cleanup");
    expect(existsSync(paths.runtime)).toBe(true);
    expect(existsSync(paths.assets)).toBe(true);
  } finally {
    child.exitCode = 0;
    await cleanupNativeFixture(app);
  }
  expect(existsSync(paths.runtime)).toBe(false);
  expect(existsSync(paths.assets)).toBe(false);
});

it("terminates and cleans the fixture while surfacing disposal failures", async () => {
  const child = { exitCode: null as number | null, signalCode: null };
  const app = { process: () => child as ChildProcess } as ElectronApplication;
  await launchNativeFixture("ave-native-disposal-", async () => app);
  const paths = nativeFixturePaths(app);
  const failure = new Error("Fixture disposal failed");
  quit.mockImplementation(async () => { child.exitCode = 0; });
  await expect(closeNativeFixture(app, async () => { throw failure; })).rejects.toMatchObject({
    message: "Native fixture teardown failed", errors: [failure],
  });
  expect(quit).toHaveBeenCalledExactlyOnceWith(app);
  expect(existsSync(paths.runtime)).toBe(false);
  expect(existsSync(paths.assets)).toBe(false);
});

it("preserves diagnostics when termination fails", async () => {
  const child = { exitCode: null as number | null, signalCode: null };
  const app = { process: () => child as ChildProcess } as ElectronApplication;
  await launchNativeFixture("ave-native-termination-", async () => app);
  const paths = nativeFixturePaths(app);
  const failure = new Error("Native termination failed");
  quit.mockRejectedValue(failure);
  try {
    await expect(closeNativeFixture(app, async () => {})).rejects.toMatchObject({
      message: "Native fixture teardown failed", errors: [failure, expect.any(Error)],
    });
    expect(existsSync(paths.runtime)).toBe(true);
    expect(existsSync(paths.assets)).toBe(true);
  } finally {
    child.exitCode = 0;
    await cleanupNativeFixture(app);
  }
});

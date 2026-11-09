import { afterAll, afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import type { ElectronApplication } from "playwright";
import { cleanupNativeFixture, closeNativeFixture, launchNativeFixture, nativeFixturePaths } from "../e2e/ui/native-fixture-runtime.js";

const { quit, repoRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  return { quit: vi.fn(), repoRoot: mkdtempSync(join(tmpdir(), "ave-native-checkout-")) as string };
});
vi.mock("../e2e/ui/seeded-electron.js", () => ({ REPO_ROOT: repoRoot, quitElectron: quit }));
const outputDir = join(repoRoot, "test-results");
afterEach(() => { quit.mockReset(); });
afterAll(() => fs.rm(repoRoot, { recursive: true, force: true }));

it("keeps a live fixture's renderer when another invocation clears its default output", async () => {
  const child = { exitCode: null as number | null, signalCode: null };
  const app = { process: () => child as ChildProcess } as ElectronApplication;
  const outputDir = join(repoRoot, "parallel-capture-output");
  await launchNativeFixture("ave-native-parallel-", async ({ assets }) => {
    await fs.writeFile(join(assets, "renderer.js"), "window.fixtureReady = true;");
    return app;
  }, outputDir);
  const paths = nativeFixturePaths(app);
  try {
    await fs.rm(join(repoRoot, "test-results"), { recursive: true, force: true });
    expect(await fs.readFile(join(paths.assets, "renderer.js"), "utf8")).toBe("window.fixtureReady = true;");
    expect(dirname(paths.assets)).toBe(await fs.realpath(outputDir));
    await fs.writeFile(join(outputDir, "other-fixture.txt"), "owned by another fixture");
  } finally {
    child.exitCode = 0;
    await cleanupNativeFixture(app);
  }
  expect(existsSync(paths.assets)).toBe(false);
  expect(await fs.readFile(join(outputDir, "other-fixture.txt"), "utf8")).toBe("owned by another fixture");
});

it.each(["outside", "symlink"])("rejects %s output before launching a fixture", async kind => {
  const outside = await fs.mkdtemp(join(tmpdir(), "ave-native-outside-"));
  const outputDir = kind === "outside" ? outside : join(repoRoot, "linked-output");
  if (kind === "symlink") await fs.symlink(outside, outputDir, process.platform === "win32" ? "junction" : "dir");
  const child = { exitCode: null as number | null, signalCode: null };
  const app = { process: () => child as ChildProcess } as ElectronApplication;
  const launch = vi.fn(async () => app);
  try {
    await expect(launchNativeFixture("ave-native-output-", launch, outputDir)).rejects.toThrow("inside the checkout");
    expect(launch).not.toHaveBeenCalled();
  } finally {
    child.exitCode = 0;
    if (launch.mock.calls.length) await cleanupNativeFixture(app);
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it("resolves relative output against the fixture checkout", async () => {
  const child = { exitCode: null as number | null, signalCode: null };
  const app = { process: () => child as ChildProcess } as ElectronApplication;
  await launchNativeFixture("ave-native-relative-", async () => app, "relative-output");
  try {
    expect(dirname(nativeFixturePaths(app).assets)).toBe(await fs.realpath(join(repoRoot, "relative-output")));
  } finally {
    child.exitCode = 0;
    await cleanupNativeFixture(app);
  }
});

it("cleans allocated runtime and build assets when acquisition fails", async () => {
  let allocated: { runtime: string; assets: string } | undefined;
  await expect(launchNativeFixture("ave-native-acquisition-", async paths => {
    allocated = paths;
    expect(existsSync(paths.runtime)).toBe(true);
    expect(existsSync(paths.assets)).toBe(true);
    throw new Error("Fixture build or launch failed");
  }, outputDir)).rejects.toThrow("Fixture build or launch failed");
  if (!allocated) throw new Error("Fixture paths were not allocated");
  expect(existsSync(allocated.runtime)).toBe(false);
  expect(existsSync(allocated.assets)).toBe(false);
});

it("preserves runtime files until the native process has exited", async () => {
  const child = { exitCode: null as number | null, signalCode: null };
  const app = { process: () => child as ChildProcess } as ElectronApplication;
  await launchNativeFixture("ave-native-lifetime-", async () => app, outputDir);
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
  await launchNativeFixture("ave-native-disposal-", async () => app, outputDir);
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
  await launchNativeFixture("ave-native-termination-", async () => app, outputDir);
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

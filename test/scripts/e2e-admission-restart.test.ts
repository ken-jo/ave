import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ElectronApplication, Page } from "playwright";
import { deferred } from "../../src/__tests__/support/deferred.js";
import { admitFixturePlugins } from "../e2e/ui/admit-fixture-plugins.js";

const { launch, quit, openSettings, visible } = vi.hoisted(() => ({
  launch: vi.fn(), quit: vi.fn(), openSettings: vi.fn(), visible: vi.fn(),
}));
vi.mock("@playwright/test", () => ({ expect: () => ({ toBeVisible: visible }) }));
vi.mock("../e2e/ui/inline-settings.js", () => ({ openInlineSettings: openSettings }));
vi.mock("../e2e/ui/seeded-electron.js", () => ({
  MAIN_ENTRY: "/fixture/main.js", launchElectron: launch, quitElectron: quit,
  buildIsolatedElectronEnv: (env: unknown) => env,
}));

function createRestartFixture() {
  const locator = { click: vi.fn().mockResolvedValue(undefined), first: vi.fn() };
  locator.first.mockReturnValue(locator);
  const page = { getByTestId: vi.fn().mockReturnValue(locator) } as unknown as Page;
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const firstWindow = vi.fn().mockResolvedValue(page);
  const restarted = { process: () => child, firstWindow } as unknown as ElectronApplication;
  const original = {} as ElectronApplication;
  const context = { app: original, mainWindow: page, aveHome: "/fixture/home/.ave", userDataDir: "/fixture/profile", tempHome: "/fixture/home" };
  launch.mockResolvedValue(restarted);
  return { context, original, restarted, page, child, firstWindow };
}

beforeEach(() => {
  vi.resetAllMocks();
  quit.mockResolvedValue(undefined);
  openSettings.mockResolvedValue(undefined);
  visible.mockResolvedValue(undefined);
});

describe("admitted fixture restart ownership", () => {
  it("waits for the original exit and captures restarted output before readiness", async () => {
    const { context, original, restarted, page, child, firstWindow } = createRestartFixture();
    const stopped = deferred<void>();
    quit.mockImplementationOnce(() => stopped.promise);
    firstWindow.mockImplementation(async () => {
      expect(child.stdout.listenerCount("data")).toBe(1);
      expect(child.stderr.listenerCount("data")).toBe(1);
      return page;
    });
    const pending = admitFixturePlugins(context);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledExactlyOnceWith(original));
    expect(launch).not.toHaveBeenCalled();
    stopped.resolve();
    await expect(pending).resolves.toEqual({ app: restarted, mainWindow: page });
  });

  it("quits the restarted process when readiness fails", async () => {
    const { context, original, restarted, firstWindow } = createRestartFixture();
    const failure = new Error("Restarted window did not become ready");
    firstWindow.mockRejectedValue(failure);
    await expect(admitFixturePlugins(context)).rejects.toBe(failure);
    expect(quit.mock.calls).toEqual([[original], [restarted]]);
  });

  it("preserves both startup and teardown errors", async () => {
    const { context, restarted, firstWindow } = createRestartFixture();
    const startup = new Error("Restarted window did not become ready");
    const teardown = new Error("Restarted process did not exit");
    firstWindow.mockRejectedValue(startup);
    quit.mockImplementation(async app => { if (app === restarted) throw teardown; });
    await expect(admitFixturePlugins(context)).rejects.toMatchObject({
      message: "Fixture restart and teardown failed", errors: [startup, teardown],
    });
  });

  it("keeps a failed original shutdown from starting another process", async () => {
    const { context } = createRestartFixture();
    const failure = new Error("Original process did not exit");
    quit.mockRejectedValue(failure);
    await expect(admitFixturePlugins(context)).rejects.toBe(failure);
    expect(launch).not.toHaveBeenCalled();
  });
});

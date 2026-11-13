import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { EventEmitter } from "node:events";
import type { ElectronApplication } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchElectron, launchSeededElectron, quitElectron, teardownSeededElectron } from "../e2e/ui/seeded-electron.js";
const launcher = vi.hoisted(() => vi.fn());
const terminateTree = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: terminateTree }));
vi.mock("playwright", () => ({ _electron: { launch: launcher } }));
vi.mock("../e2e/ui/background-electron.js", () => ({ resolveE2eExecutable: () => undefined }));

async function application(exitCode: number | null = null, closed = exitCode !== null) {
  const child = Object.assign(new EventEmitter(), { exitCode, signalCode: null as NodeJS.Signals | null, kill: vi.fn() });
  const nativeApp = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const quit = nativeApp.quit;
  const evaluate = vi.fn(async (operation: (module: { app: typeof nativeApp }) => void) => operation({ app: nativeApp }));
  const close = vi.fn(async () => {});
  const process = vi.fn(() => child);
  const app = { process, evaluate, close } as unknown as ElectronApplication;
  launcher.mockResolvedValueOnce(app);
  await launchElectron({ env: {} });
  if (closed) child.emit("close", exitCode, null);
  return { app, child, nativeApp, quit, evaluate, close, process };
}

describe("native test application quit", () => {
  afterEach(() => vi.restoreAllMocks());
  it("waits for native exit before closing automation over the dying inspector", async () => {
    const runtime = await application();
    const quitting = quitElectron(runtime.app);
    await Promise.resolve();
    expect(runtime.quit).toHaveBeenCalledOnce();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.child.kill).not.toHaveBeenCalled();
    runtime.nativeApp.emit("will-quit");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.child.emit("close", 0, null);
    await quitting;
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("does not request a second quit after native cleanup but before process exit", async () => {
    const runtime = await application();
    runtime.quit.mockImplementation(() => runtime.nativeApp.emit("will-quit"));
    runtime.close.mockImplementation(async () => {
      if (runtime.child.exitCode === null) throw new Error("A second native quit cannot complete during inspector teardown");
    });
    const quitting = quitElectron(runtime.app);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    runtime.child.emit("close", 0, null);
    await quitting;
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(runtime.child.kill).not.toHaveBeenCalled();
  });

  it("does not miss an exit emitted during the quit request", async () => {
    const runtime = await application();
    runtime.quit.mockImplementation(() => {
      runtime.child.exitCode = 0;
      runtime.child.emit("exit", 0, null);
      runtime.child.emit("close", 0, null);
    });
    await quitElectron(runtime.app);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("still requires native exit when the quit response transport closes", async () => {
    const runtime = await application();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runtime.evaluate.mockRejectedValueOnce(new Error("Connection closed"));
    const quitting = quitElectron(runtime.app);
    await Promise.resolve();
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    runtime.child.emit("close", 0, null);
    await quitting;
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("does not hold native exit behind a pending quit response", async () => {
    const runtime = await application();
    runtime.evaluate.mockImplementationOnce(() => new Promise<void>(() => {}));
    const quitting = quitElectron(runtime.app);
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    runtime.child.emit("close", 0, null);
    await quitting;
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("reports a child-process error without waiting for the quit response", async () => {
    const runtime = await application();
    runtime.evaluate.mockImplementationOnce(() => new Promise<void>(() => {}));
    const quitting = quitElectron(runtime.app);
    const failure = new Error("Process wait failed");
    const rejected = expect(quitting).rejects.toThrow(failure.message);
    runtime.child.emit("error", failure);
    await rejected;
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("does not request quit again after the native process has exited", async () => {
    const runtime = await application(0);
    await quitElectron(runtime.app);
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
  it("accepts a process already closed by a spec after its automation implementation is disposed", async () => {
    const runtime = await application(0);
    runtime.process.mockImplementation(() => { throw new TypeError("Native implementation was disposed"); });
    await expect(quitElectron(runtime.app)).resolves.toBeUndefined();
    expect(runtime.process).toHaveBeenCalledOnce();
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(runtime.child.kill).not.toHaveBeenCalled();
  });

  it("exposes the launched process and waits for its pipes when startup fails", async () => {
    const runtime = await application();
    Object.assign(runtime.app, { firstWindow: vi.fn().mockRejectedValue(new Error("Window startup failed")) });
    launcher.mockResolvedValueOnce(runtime.app);
    const onLaunched = vi.fn();
    const starting = launchSeededElectron({ historyRows: [], onLaunched });
    const rejected = expect(starting).rejects.toThrow("Window startup failed");
    await vi.waitFor(() => expect(runtime.quit).toHaveBeenCalledOnce());
    expect(onLaunched).toHaveBeenCalledWith(runtime.app);
    runtime.nativeApp.emit("will-quit");
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.child.emit("close", 0, null);
    await rejected;
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});

describe("forced native fixture teardown", () => {
  afterEach(() => vi.restoreAllMocks());
  it("ends the owned tree rather than leaving pipe-holding descendants alive", async () => {
    const runtime = await application();
    const pid = 424242;
    Object.assign(runtime.child, { pid });
    const exited = (): true => {
      runtime.child.signalCode = "SIGKILL";
      runtime.child.emit("exit", null, "SIGKILL");
      runtime.child.emit("close", null, "SIGKILL");
      return true;
    };
    const kill = vi.spyOn(process, "kill").mockImplementation(exited);
    terminateTree.mockImplementationOnce((_command, _args, _options, callback) => { exited(); callback(null); });
    const userDataDir = mkdtempSync(join(tmpdir(), "owned-runtime-profile-"));
    const tempHome = mkdtempSync(join(tmpdir(), "owned-runtime-home-"));
    await teardownSeededElectron({ app: runtime.app, page: {} as Page, userDataDir, tempHome, aveHome: join(tempHome, ".ave") }, { terminate: true });
    if (process.platform === "win32") {
      expect(terminateTree).toHaveBeenCalledWith("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, expect.any(Function));
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
    }
    expect(runtime.child.kill).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
  it("cleans a POSIX group whose root exited before its inherited pipes closed", async () => {
    const runtime = await application(0, false);
    const pid = 424243;
    Object.assign(runtime.child, { pid });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      runtime.child.emit("close", 0, null);
      return true;
    });
    if (process.platform === "win32") runtime.child.emit("close", 0, null);
    const userDataDir = mkdtempSync(join(tmpdir(), "exited-runtime-profile-"));
    const tempHome = mkdtempSync(join(tmpdir(), "exited-runtime-home-"));
    await teardownSeededElectron({ app: runtime.app, page: {} as Page, userDataDir, tempHome, aveHome: join(tempHome, ".ave") }, { terminate: true });
    if (process.platform !== "win32") expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
    expect(runtime.close).toHaveBeenCalledOnce();
  });

});

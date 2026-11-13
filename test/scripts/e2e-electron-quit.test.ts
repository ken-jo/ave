import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { EventEmitter, once } from "node:events";
import type { ElectronApplication } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchElectron, launchSeededElectron, quitElectron, teardownSeededElectron } from "../e2e/ui/seeded-electron.js";
const launcher = vi.hoisted(() => vi.fn());
const terminateTree = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: terminateTree }));
vi.mock("playwright", () => ({ _electron: { launch: launcher } }));
vi.mock("../e2e/ui/background-electron.js", () => ({ resolveE2eExecutable: () => undefined }));

async function application(exitCode: number | null = null, closed = exitCode !== null) {
  const child = Object.assign(new EventEmitter(), { exitCode, signalCode: null as string | null, kill: vi.fn() });
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
  it("keeps the connection through cleanup and waits for native exit after releasing it", async () => {
    const runtime = await application();
    const quitting = quitElectron(runtime.app);
    await Promise.resolve();
    expect(runtime.quit).toHaveBeenCalledOnce();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.child.kill).not.toHaveBeenCalled();
    runtime.nativeApp.emit("will-quit");
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    runtime.child.emit("close", 0, null);
    await quitting;
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("releases the debugger when native cleanup is done but exit still needs disconnection", async () => {
    const runtime = await application();
    runtime.quit.mockImplementation(() => runtime.nativeApp.emit("will-quit"));
    runtime.close.mockImplementation(async () => {
      runtime.child.exitCode = 0;
      runtime.child.emit("exit", 0, null);
      runtime.child.emit("close", 0, null);
    });
    await quitElectron(runtime.app);
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
    expect(runtime.close).not.toHaveBeenCalled();
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
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("does not hold native exit behind a pending quit response", async () => {
    const runtime = await application();
    runtime.evaluate.mockImplementationOnce(() => new Promise<void>(() => {}));
    const quitting = quitElectron(runtime.app);
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    runtime.child.emit("close", 0, null);
    await quitting;
    expect(runtime.close).not.toHaveBeenCalled();
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

  it("does not reopen automation teardown after the native process has exited", async () => {
    const runtime = await application(0);
    await quitElectron(runtime.app);
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
  });
  it("does not close automation for a process terminated by signal", async () => {
    const runtime = await application();
    runtime.child.signalCode = "SIGKILL";
    runtime.child.emit("exit", null, "SIGKILL");
    runtime.child.emit("close", null, "SIGKILL");
    await quitElectron(runtime.app);
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.child.kill).not.toHaveBeenCalled();
  });

  it("accepts a process already closed by a spec after its automation implementation is disposed", async () => {
    const runtime = await application(0);
    runtime.process.mockImplementation(() => { throw new TypeError("Native implementation was disposed"); });
    await expect(quitElectron(runtime.app)).resolves.toBeUndefined();
    expect(runtime.process).toHaveBeenCalledOnce();
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.child.kill).not.toHaveBeenCalled();
  });

  it("completes from native closure when an in-flight context request cannot answer", async () => {
    const runtime = await application();
    runtime.close.mockImplementation(() => new Promise<void>(() => {}));
    let settled = false;
    const quitting = quitElectron(runtime.app).then(() => { settled = true; });
    runtime.nativeApp.emit("will-quit");
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    runtime.child.emit("close", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(runtime.quit).toHaveBeenCalledOnce();
    await quitting;
  });

  it("still waits for inherited pipes when the root has already exited", async () => {
    const runtime = await application(0, false);
    let settled = false;
    const quitting = quitElectron(runtime.app).then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.child.emit("close", 0, null);
    await quitting;
  });

  it("does not acknowledge a prevented quit or add another quit request", async () => {
    const runtime = await application();
    let settled = false;
    const quitting = quitElectron(runtime.app);
    void quitting.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(runtime.quit).toHaveBeenCalledOnce();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.child.kill).not.toHaveBeenCalled();
    const failure = new Error("Native quit remains blocked");
    const rejected = expect(quitting).rejects.toThrow(failure.message);
    runtime.child.emit("error", failure);
    await rejected;
  });

  it("reports an abnormal native exit instead of acknowledging clean shutdown", async () => {
    const runtime = await application();
    runtime.quit.mockImplementation(() => {
      runtime.nativeApp.emit("will-quit");
      runtime.child.exitCode = 2;
      runtime.child.emit("exit", 2, null);
      runtime.child.emit("close", 2, null);
    });
    await expect(quitElectron(runtime.app)).rejects.toThrow("Native application quit failed: exit=2, signal=null");
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.child.kill).not.toHaveBeenCalled();
  });
});

describe("native fixture startup ownership", () => {
  afterEach(() => vi.restoreAllMocks());
  it("exposes a child-close receipt before startup readiness can fail", async () => {
    const runtime = await application();
    Object.assign(runtime.app, { firstWindow: vi.fn().mockRejectedValue(new Error("Window startup failed")) });
    launcher.mockResolvedValueOnce(runtime.app);
    let closed = false;
    let receipt: Promise<void> | undefined;
    const onLaunched = vi.fn((app: ElectronApplication) => {
      receipt = once(app.process(), "close").then(() => { closed = true; });
    });
    const starting = launchSeededElectron({ historyRows: [], onLaunched });
    let startupSettled = false;
    void starting.then(() => { startupSettled = true; }, () => { startupSettled = true; });
    const rejected = expect(starting).rejects.toThrow("Window startup failed");
    await vi.waitFor(() => expect(runtime.quit).toHaveBeenCalledOnce());
    expect(onLaunched).toHaveBeenCalledWith(runtime.app);
    runtime.nativeApp.emit("will-quit");
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(startupSettled).toBe(false);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    runtime.child.emit("close", 0, null);
    await rejected;
    await receipt;
    expect(closed).toBe(true);
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
    expect(runtime.close).not.toHaveBeenCalled();
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
    expect(runtime.close).not.toHaveBeenCalled();
  });

});

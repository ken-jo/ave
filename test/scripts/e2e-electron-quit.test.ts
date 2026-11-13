import { EventEmitter } from "node:events";
import type { ElectronApplication } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchElectron, quitElectron } from "../e2e/ui/seeded-electron.js";
const launcher = vi.hoisted(() => vi.fn());
vi.mock("playwright", () => ({ _electron: { launch: launcher } }));
vi.mock("../e2e/ui/background-electron.js", () => ({ resolveE2eExecutable: () => undefined }));

async function application(exitCode: number | null = null) {
  const child = Object.assign(new EventEmitter(), { exitCode, signalCode: null as string | null, kill: vi.fn() });
  const nativeApp = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const quit = nativeApp.quit;
  const evaluate = vi.fn(async (operation: (module: { app: typeof nativeApp }) => void) => operation({ app: nativeApp }));
  const close = vi.fn(async () => {});
  const process = vi.fn(() => child);
  const app = { process, evaluate, close } as unknown as ElectronApplication;
  launcher.mockResolvedValueOnce(app);
  await launchElectron({ env: {} });
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
    await quitting;
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("releases the debugger when native cleanup is done but exit still needs disconnection", async () => {
    const runtime = await application();
    runtime.quit.mockImplementation(() => runtime.nativeApp.emit("will-quit"));
    runtime.close.mockImplementation(async () => {
      runtime.child.exitCode = 0;
      runtime.child.emit("exit", 0, null);
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
    await quitting;
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("does not hold native exit behind a pending quit response", async () => {
    const runtime = await application();
    runtime.evaluate.mockImplementationOnce(() => new Promise<void>(() => {}));
    const quitting = quitElectron(runtime.app);
    runtime.child.exitCode = 0;
    runtime.child.emit("exit", 0, null);
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
});

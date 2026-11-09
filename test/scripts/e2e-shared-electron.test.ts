import { describe, expect, it, vi } from "vitest";
import type { ElectronApplication } from "playwright";
import type { WorkerInfo } from "@playwright/test";
import { SharedElectronPool, SharedElectronSession } from "../e2e/ui/shared-electron.js";

function application() {
  const child = { exitCode: null as number | null, signalCode: null as string | null };
  const app = { process: () => child } as unknown as ElectronApplication;
  return { app, child };
}

function session() {
  const first = application();
  const second = application();
  const adapter = {
    launch: vi.fn().mockResolvedValueOnce(first.app).mockResolvedValueOnce(second.app),
    reset: vi.fn(async () => {}),
    assertClean: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const worker = { workerIndex: 3 } as WorkerInfo;
  return { first, second, adapter, worker, session: new SharedElectronSession(adapter, "scale=2;mode=cdp", worker) };
}

describe("shared native test application", () => {
  it("launches once and verifies the baseline before every test", async () => {
    const runtime = session();
    const recovery = vi.fn();
    expect(await runtime.session.prepare(recovery)).toBe(runtime.first.app);
    expect(await runtime.session.prepare(recovery)).toBe(runtime.first.app);
    expect(runtime.adapter.launch).toHaveBeenCalledExactlyOnceWith("scale=2;mode=cdp", runtime.worker);
    expect(runtime.adapter.reset).toHaveBeenCalledExactlyOnceWith(runtime.first.app);
    expect(runtime.adapter.assertClean).toHaveBeenCalledTimes(2);
    expect(recovery).not.toHaveBeenCalled();
    await runtime.session.close();
    await runtime.session.close();
    expect(runtime.adapter.close).toHaveBeenCalledExactlyOnceWith(runtime.first.app);
  });

  it.each(["exit", "signal", "reset", "assertion"])("replaces an unhealthy application after %s and reports the reason", async failure => {
    const runtime = session();
    const recovery = vi.fn();
    await runtime.session.prepare(recovery);
    if (failure === "exit") runtime.first.child.exitCode = 1;
    if (failure === "signal") runtime.first.child.signalCode = "SIGKILL";
    if (failure === "reset") runtime.adapter.reset.mockRejectedValueOnce(new Error("Reset failed"));
    if (failure === "assertion") runtime.adapter.assertClean.mockRejectedValueOnce(new Error("Guest storage is dirty"));
    expect(await runtime.session.prepare(recovery)).toBe(runtime.second.app);
    expect(recovery).toHaveBeenCalledOnce();
    expect(runtime.adapter.close).toHaveBeenCalledExactlyOnceWith(runtime.first.app);
    expect(runtime.adapter.launch).toHaveBeenCalledTimes(2);
    expect(runtime.adapter.assertClean).toHaveBeenLastCalledWith(runtime.second.app);
    await runtime.session.close();
  });

  it("fails before the test body when a replacement also has dirty state", async () => {
    const runtime = session();
    await runtime.session.prepare(vi.fn());
    runtime.adapter.assertClean.mockRejectedValue(new Error("Dirty registry"));
    await expect(runtime.session.prepare(vi.fn())).rejects.toThrow("Fresh test application failed its clean-state assertion");
    expect(runtime.adapter.launch).toHaveBeenCalledTimes(2);
    expect(runtime.adapter.close).toHaveBeenCalledTimes(2);
  });

  it("propagates cleanup failures instead of launching over a live dirty process", async () => {
    const runtime = session();
    await runtime.session.prepare(vi.fn());
    runtime.adapter.reset.mockRejectedValueOnce(new Error("Reset failed"));
    runtime.adapter.close.mockRejectedValueOnce(new Error("Still running"));
    await expect(runtime.session.prepare(vi.fn())).rejects.toThrow("Still running");
    expect(runtime.adapter.launch).toHaveBeenCalledOnce();
  });

  it("closes the dirty application even when the recovery observer throws", async () => {
    const runtime = session();
    await runtime.session.prepare(vi.fn());
    runtime.adapter.reset.mockRejectedValueOnce(new Error("Reset failed"));
    await expect(runtime.session.prepare(() => { throw new Error("Recovery rejected"); })).rejects.toThrow("Recovery rejected");
    expect(runtime.adapter.close).toHaveBeenCalledExactlyOnceWith(runtime.first.app);
    expect(runtime.adapter.launch).toHaveBeenCalledOnce();
  });
});

describe("shared native worker pool", () => {
  it("reuses a configuration and separates different launch keys", async () => {
    const runtime = session();
    const pool = new SharedElectronPool(runtime.worker);
    const first = pool.session(runtime.adapter, "scale=1");
    expect(pool.session(runtime.adapter, "scale=1")).toBe(first);
    const second = pool.session(runtime.adapter, "scale=2");
    expect(second).not.toBe(first);
    await first.prepare(vi.fn());
    await second.prepare(vi.fn());
    expect(runtime.adapter.launch.mock.calls.map(call => call[0])).toEqual(["scale=1", "scale=2"]);
    await pool.close();
    expect(runtime.adapter.close).toHaveBeenCalledTimes(2);
  });

  it("separates adapters with the same launch key", async () => {
    const first = session();
    const second = session();
    const pool = new SharedElectronPool(first.worker);
    const firstSession = pool.session(first.adapter, "");
    const secondSession = pool.session(second.adapter, "");
    expect(await firstSession.prepare(vi.fn())).toBe(first.first.app);
    expect(await secondSession.prepare(vi.fn())).toBe(second.first.app);
    await pool.close();
    expect(first.adapter.close).toHaveBeenCalledOnce();
    expect(second.adapter.close).toHaveBeenCalledOnce();
  });

  it("attempts every owned teardown and propagates failures", async () => {
    const first = session();
    const second = session();
    const pool = new SharedElectronPool(first.worker);
    await pool.session(first.adapter, "").prepare(vi.fn());
    await pool.session(second.adapter, "").prepare(vi.fn());
    first.adapter.close.mockRejectedValueOnce(new Error("Still running"));
    await expect(pool.close()).rejects.toThrow("Shared application pool teardown failed");
    expect(first.adapter.close).toHaveBeenCalledOnce();
    expect(second.adapter.close).toHaveBeenCalledOnce();
  });

  it("finishes one native shutdown before starting the next", async () => {
    const first = session();
    const second = session();
    const pool = new SharedElectronPool(first.worker);
    await pool.session(first.adapter, "").prepare(vi.fn());
    await pool.session(second.adapter, "").prepare(vi.fn());
    let release!: () => void;
    first.adapter.close.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const closing = pool.close();
    await vi.waitFor(() => expect(first.adapter.close).toHaveBeenCalledOnce());
    expect(second.adapter.close).not.toHaveBeenCalled();
    release();
    await closing;
    expect(second.adapter.close).toHaveBeenCalledOnce();
  });
});

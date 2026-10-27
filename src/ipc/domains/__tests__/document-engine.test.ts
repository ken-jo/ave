import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CHANNELS, isPublicChannel } from "../../../contract/app-contract.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import type { IpcDeps } from "../../types.js";
import type { DocumentEngineInstallationState } from "../../../shared/document-engine.js";

const mocks = vi.hoisted(() => ({
  session: {}, handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  state: vi.fn(), install: vi.fn(), uninstall: vi.fn(), stop: vi.fn(), initialize: vi.fn(), cleanup: vi.fn(),
}));
vi.mock("electron", () => ({ session: { defaultSession: mocks.session },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) } }));
vi.mock("../../../main/document-engine-installation.js", () => ({
  DocumentEngineInstallError: class extends Error { constructor(readonly code: string) { super(code); } },
  getDocumentEngineInstallationState: mocks.state,
  installDocumentEngine: mocks.install,
  uninstallDocumentEngine: mocks.uninstall,
  initializeDocumentEngineInstallationNetwork: mocks.initialize,
}));
vi.mock("../../../observation/document-engine-host.js", () => ({ stopHostDocumentEngineSessions: mocks.stop,
  cleanupStaleDocumentEngineRuntimes: mocks.cleanup }));
import { registerDocumentEngineHandlers } from "../document-engine.js";
import { DocumentEngineInstallError } from "../../../main/document-engine-installation.js";

const ABSENT: DocumentEngineInstallationState = { phase: "absent", version: "26.8.1", downloadBytes: 300_000_000,
  downloadedBytes: 0, installedBytes: 900_000_000 };
let event: IpcMainInvokeEvent;
let deps: IpcDeps;
let registered: boolean;
let audit: ReturnType<typeof vi.fn>;

function invoke(channel: string, sender = event, ...args: unknown[]) {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error("Missing document engine handler");
  return handler(sender, ...args);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  registered = true;
  const frame = { url: "file:///app/index.html", detached: false, isDestroyed: () => false };
  const sender = { mainFrame: frame, isDestroyed: () => false, getType: () => "window", session: mocks.session };
  event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  audit = vi.fn();
  deps = { getMainWindow: () => null,
    getAppWindows: () => registered ? [{ webContents: sender, isDestroyed: () => false }] : [],
    auditLogger: { log: audit }, singleHopNetworkFetch: vi.fn(),
  } as unknown as IpcDeps;
  mocks.state.mockResolvedValue(ABSENT);
  mocks.install.mockResolvedValue(undefined);
  mocks.uninstall.mockImplementation(async (beforeRemove?: () => Promise<void>) => { await beforeRemove?.(); });
  mocks.stop.mockResolvedValue(undefined);
  mocks.cleanup.mockResolvedValue(0);
  registerDocumentEngineHandlers(deps);
});
afterEach(() => { mocks.handlers.clear(); });

describe("optional document engine local installation", () => {
  it("keeps all installation channels private and binds the host network transport", () => {
    for (const channel of Object.values(CHANNELS.documentEngine)) expect(isPublicChannel(channel)).toBe(false);
    expect(mocks.initialize).toHaveBeenCalledWith(deps.singleHopNetworkFetch);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("refuses installation on a platform without engine confinement before any download starts", async () => {
    mocks.state.mockResolvedValue({ ...ABSENT, phase: "unsupported" });
    await expect(invoke(CHANNELS.documentEngine.install)).resolves.toEqual({ ok: false, error: "unsupported-platform" });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(await invoke(CHANNELS.documentEngine.status)).toEqual({ ok: true, state: { ...ABSENT, phase: "unsupported" } });
  });

  it.each(["guest", "subframe", "partition", "unregistered", "destroyed"])("refuses a %s sender before reading or changing installation state", async (kind) => {
    const sender = event.sender;
    let frame = event.senderFrame;
    if (kind === "guest") Object.assign(sender, { getType: () => "webview" });
    if (kind === "subframe") frame = { ...event.senderFrame } as never;
    if (kind === "partition") Object.assign(sender, { session: {} });
    if (kind === "unregistered") registered = false;
    if (kind === "destroyed") Object.assign(sender, { isDestroyed: () => true });
    const candidate = kind === "unregistered" ? event : { ...event, sender, senderFrame: frame } as IpcMainInvokeEvent;
    for (const channel of Object.values(CHANNELS.documentEngine)) {
      await expect(invoke(channel, candidate)).resolves.toEqual({ ok: false, error: "unauthorized" });
    }
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.uninstall).not.toHaveBeenCalled();
  });

  it("rejects every payload rather than accepting executable or download targets", async () => {
    for (const channel of Object.values(CHANNELS.documentEngine)) {
      await expect(invoke(channel, event, { path: "/tmp/other", url: "https://example.test/other" }))
        .resolves.toEqual({ ok: false, error: "bad-request" });
    }
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("returns an installation receipt while progress remains available and refuses overlapping mutations", async () => {
    const installing = deferred<void>();
    mocks.install.mockImplementation((progress, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      progress({ ...ABSENT, phase: "downloading", downloadedBytes: 42 });
      return installing.promise;
    });
    await expect(invoke(CHANNELS.documentEngine.install)).resolves.toEqual({ ok: true });
    expect(await invoke(CHANNELS.documentEngine.status)).toEqual({ ok: true, state: { ...ABSENT, phase: "downloading", downloadedBytes: 42 } });
    await expect(invoke(CHANNELS.documentEngine.install)).resolves.toEqual({ ok: false, error: "busy" });
    await expect(invoke(CHANNELS.documentEngine.uninstall)).resolves.toEqual({ ok: false, error: "busy" });
    mocks.state.mockResolvedValue({ ...ABSENT, phase: "ready" });
    installing.resolve();
    await vi.waitFor(async () => expect(await invoke(CHANNELS.documentEngine.status)).toMatchObject({ state: { phase: "ready" } }));
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("cancels the owned job and waits for cleanup before permitting a retry", async () => {
    const cleanup = deferred<void>();
    let signal: AbortSignal | undefined;
    mocks.install.mockImplementation((_progress, value) => {
      signal = value;
      return cleanup.promise.then(() => { throw new DOMException("Aborted", "AbortError"); });
    });
    await invoke(CHANNELS.documentEngine.install);
    let cancelled = false;
    const cancellation = invoke(CHANNELS.documentEngine.cancel).then(() => { cancelled = true; });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(false);
    expect(await invoke(CHANNELS.documentEngine.install)).toEqual({ ok: false, error: "busy" });
    cleanup.resolve();
    await cancellation;
    expect(await invoke(CHANNELS.documentEngine.status)).toMatchObject({ state: { phase: "error", error: "cancelled" } });
    mocks.install.mockResolvedValue(undefined);
    expect(await invoke(CHANNELS.documentEngine.install)).toEqual({ ok: true });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(2));
  });

  it("retains a failed signature state for explicit retry and never starts an already installed engine", async () => {
    mocks.install.mockRejectedValueOnce(new DocumentEngineInstallError("signature-failed", "Signature was refused"));
    await invoke(CHANNELS.documentEngine.install);
    await vi.waitFor(async () => expect(await invoke(CHANNELS.documentEngine.status)).toMatchObject({ state: { phase: "error", error: "signature-failed" } }));
    expect(audit).toHaveBeenCalled();
    mocks.state.mockResolvedValue({ ...ABSENT, phase: "ready" });
    expect(await invoke(CHANNELS.documentEngine.install)).toEqual({ ok: true });
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("ends every engine session before uninstalling and preserves files if shutdown fails", async () => {
    const stopped = deferred<void>();
    const removed = vi.fn();
    mocks.uninstall.mockImplementation(async (beforeRemove: () => Promise<void>) => { await beforeRemove(); removed(); });
    mocks.stop.mockReturnValueOnce(stopped.promise);
    const removing = invoke(CHANNELS.documentEngine.uninstall);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.uninstall).toHaveBeenCalledWith(mocks.stop);
    expect(removed).not.toHaveBeenCalled();
    stopped.resolve();
    await expect(removing).resolves.toEqual({ ok: true });
    expect(removed).toHaveBeenCalledOnce();
    mocks.stop.mockRejectedValueOnce(new Error("Process still alive"));
    await expect(invoke(CHANNELS.documentEngine.uninstall)).resolves.toEqual({ ok: false, error: "install-failed" });
    expect(removed).toHaveBeenCalledOnce();
  });
});

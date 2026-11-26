import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootHost } from "../../boot/host-runtime.js";
import type { HostResources } from "../host-resources.js";

const io = vi.hoisted(() => ({
  helperExists: vi.fn(),
  helperBytes: vi.fn(),
  spawnHelper: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  acquireHostInstanceLock: vi.fn(async () => {}),
  sharedBootstrap: vi.fn(),
}));

vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("node:path", async (importOriginal) => {
  const { simulatedDrivePath } = await import("../../__tests__/support/simulated-win32-drive.js");
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...simulatedDrivePath(actual), sep: actual.win32.sep };
});
vi.mock("../../permissions/generated/srt-win-build-receipts.js", () => ({ default: {} }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: io.helperExists,
    readFileSync: (file: Parameters<typeof fs.readFileSync>[0], options?: Parameters<typeof fs.readFileSync>[1]) => (
      typeof file === "string" && file.endsWith("ave-path-kind.exe") ? io.helperBytes(file) : Reflect.apply(fs.readFileSync, fs, [file, options])
    ),
    lstatSync: io.lstat,
    realpathSync: Object.assign(vi.fn(), { native: io.realpath }),
  };
});
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawnSync: io.spawnHelper }));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "C:\\profile",
    getPreferredSystemLanguages: () => ["en"],
  },
  powerMonitor: {},
}));
vi.mock("../host-instance-lock.js", () => ({ acquireHostInstanceLock: io.acquireHostInstanceLock }));
vi.mock("../../boot.js", () => ({ bootstrap: io.sharedBootstrap }));
vi.mock("../main-window-host.js", () => ({ closeMainWindowDocuments: vi.fn() }));
vi.mock("../device-code-dialog.js", () => ({ createDeviceCodePresentation: vi.fn() }));
vi.mock("../desktop-secret-encryption.js", () => ({ desktopSecretEncryption: {} }));
vi.mock("../browser/browser-capture-desktop.js", () => ({ browserCapturePixelRatio: vi.fn() }));
vi.mock("../browser/browser-guest-owner.js", () => ({ browserGuestOwnerWindow: vi.fn() }));
vi.mock("../../boot/steps/desktop-network-fetch.js", () => ({ createDesktopNetworkFetch: () => ({}) }));
vi.mock("../../boot/steps/desktop-release.js", () => ({ prepareDesktopRelease: vi.fn() }));
vi.mock("../idle-scheduler.js", () => ({ adaptPowerMonitor: vi.fn() }));
vi.mock("../main-window.js", () => ({ getAppWindows: vi.fn() }));
vi.mock("../global-shortcuts.js", () => ({ unregisterAllGlobalShortcuts: vi.fn() }));
vi.mock("../auth-window-service.js", () => ({
  openAuthWindow: vi.fn(), clearAuthPartition: vi.fn(), openOAuthInAuthWindow: vi.fn(),
}));
vi.mock("../oauth-login.js", () => ({ installOAuthLoginOpener: () => vi.fn() }));
vi.mock("../link-window-service.js", () => ({ openLinkWindow: vi.fn() }));
vi.mock("../auth-partition-viewer-service.js", () => ({ openAuthPartitionViewer: vi.fn() }));
vi.mock("../audio-capture-surface.js", () => ({ ElectronAudioCaptureSurface: vi.fn() }));
vi.mock("../floating-dock-surface.js", () => ({ ElectronFloatingDockSurface: vi.fn(), hostDockThemeSource: {} }));
vi.mock("../../boot/steps/plugin-runtime/host-api-factory.js", () => ({ peekFloatingDock: vi.fn() }));
vi.mock("../host-api/pick-folders.js", () => ({ pickFoldersForPlugin: vi.fn() }));
vi.mock("../browser/browser-workspace-desktop.js", () => ({ getBrowserWorkspaceService: vi.fn() }));
vi.mock("../../boot/desktop-relaunch.js", () => ({ relaunchDesktopHost: vi.fn() }));
vi.mock("../../data/node-secret-encryption.js", () => ({ createNodeSecretEncryption: () => ({}) }));
vi.mock("../corp-ca-runtime.js", () => ({ ensureCorporateCaInjected: vi.fn(async () => {}) }));
vi.mock("../persisted-corp-ca.js", () => ({ readPersistedCorpCaConfigSync: () => undefined }));
vi.mock("../../data/settings-store.js", () => ({
  settingsFilePath: (userDataPath: string) => win32.join(userDataPath, "settings.json"),
}));

const PROJECT_ROOT = "C:\\project";
const PACKAGED_RESOURCES = "C:\\bundle\\resources";
const BUILT_HELPER = Buffer.from("fresh build output");
const BUILT_HELPER_SHA256 = createHash("sha256").update(BUILT_HELPER).digest("hex");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Register after the native guard so the drive query can reach the mocked I/O.
  vi.doMock("../../shared/windows-native-host.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../../shared/windows-native-host.js")>(),
    runWindowsNative: (operation: () => unknown) => operation(),
  }));
  vi.stubGlobal("process", Object.create(process, {
    platform: { value: "win32" },
    resourcesPath: { value: PACKAGED_RESOURCES },
  }));
  io.helperExists.mockReturnValue(true);
  io.helperBytes.mockReturnValue(BUILT_HELPER);
  io.spawnHelper.mockReturnValue({ status: 0, stdout: Buffer.from("\\Device\\HarddiskVolume1") });
  io.lstat.mockReturnValue({ isSymbolicLink: () => false });
  io.realpath.mockImplementation((path: string) => path);
  io.sharedBootstrap.mockImplementation(async (
    _root: string, _window: unknown, _getWindow: unknown, _launch: unknown, host: BootHost,
  ) => host);
});

afterEach(() => {
  vi.doUnmock("../../shared/windows-native-host.js");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("desktop host resource startup", () => {
  it("refuses independently supplied checkout bytes before starting the unpackaged host", async () => {
    const { app } = await import("electron");
    Object.defineProperty(app, "isPackaged", { value: false });
    const { createDesktopBootHost } = await import("../../boot/desktop-host-runtime.js");
    vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", BUILT_HELPER_SHA256);
    io.helperBytes.mockReturnValue(Buffer.from("independently supplied executable"));
    io.lstat.mockClear();

    const start = vi.fn(() => createDesktopBootHost(PROJECT_ROOT));
    const boot = async () => (await start()).close();
    await expect(boot()).rejects.toThrow(/Windows folder classifier/u);
    expect(io.spawnHelper).not.toHaveBeenCalled();
    expect(io.lstat).not.toHaveBeenCalled();
  });

  it.each([false, true])("configures resources before early boot and host construction (packaged: %s)", async (isPackaged) => {
    if (!isPackaged) vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", BUILT_HELPER_SHA256);
    const { app } = await import("electron");
    const { desktopResourcePath } = await import("../desktop-resource-path.js");
    const { configureHostResources, getConfiguredHostResources } = await import("../host-resources.js");
    expect(getConfiguredHostResources()).toBeUndefined();
    Object.defineProperty(app, "isPackaged", { value: isPackaged });
    let resourcesAtEarlyBoot: HostResources | undefined;
    const runEarlyBootEnv = vi.fn(() => { resourcesAtEarlyBoot = getConfiguredHostResources(); });

    // Execute the entry's early statements without its app-wide startup side effects.
    const source = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
    const lastImport = '} from "./main/app-state.js";';
    const earlyBoot = "runEarlyBootEnv();";
    const start = source.indexOf(lastImport);
    const end = source.indexOf(earlyBoot, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    new Function(
      "app", "desktopResourcePath", "configureHostResources", "projectRoot", "createLogger", "execModeRequested", "runEarlyBootEnv",
      source.slice(start + lastImport.length, end + earlyBoot.length),
    )(app, desktopResourcePath, configureHostResources, PROJECT_ROOT, () => ({}), () => false, runEarlyBootEnv);

    const { bootstrap } = await import("../../desktop-boot.js");
    const expectedResources = { resourcePath: isPackaged ? PACKAGED_RESOURCES : win32.join(PROJECT_ROOT, "resources"), isPackaged };
    await expect(bootstrap(PROJECT_ROOT, null, () => null, "interactive")).resolves.toMatchObject(expectedResources);
    expect(resourcesAtEarlyBoot).toEqual(expectedResources);
    expect(runEarlyBootEnv).toHaveBeenCalledBefore(io.acquireHostInstanceLock);
    expect(io.acquireHostInstanceLock).toHaveBeenCalledBefore(io.helperExists);
    expect(io.helperExists).toHaveBeenCalledWith(win32.join(expectedResources.resourcePath, "windows-path-kind", process.arch, "ave-path-kind.exe"));
    expect(io.spawnHelper).toHaveBeenCalledBefore(io.realpath);
    expect(io.realpath).toHaveBeenCalledBefore(io.sharedBootstrap);
  });

  it.each([false, true])("builds the desktop host without global resources (packaged: %s)", async (isPackaged) => {
    if (!isPackaged) vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", BUILT_HELPER_SHA256);
    const { app } = await import("electron");
    const { createDesktopBootHost } = await import("../../boot/desktop-host-runtime.js");
    const { protectedControlEntryFor } = await import("../../permissions/sensitive-paths.js");
    const { getConfiguredHostResources } = await import("../host-resources.js");
    Object.defineProperty(app, "isPackaged", { value: isPackaged });
    const lexical = "C:\\profile\\settings.json";
    const canonical = "C:\\physical\\settings.json";
    io.realpath.mockImplementation((path: string) => path === lexical ? canonical : path);

    io.lstat.mockClear();
    const host = createDesktopBootHost(PROJECT_ROOT);
    const match = (path: string) => protectedControlEntryFor(path, undefined, { inspectHostFiles: false });
    try {
      const root = isPackaged ? PACKAGED_RESOURCES : win32.join(PROJECT_ROOT, "resources");
      expect(io.helperExists).toHaveBeenCalledExactlyOnceWith(win32.join(root, "windows-path-kind", process.arch, "ave-path-kind.exe"));
      expect(io.spawnHelper).toHaveBeenCalledBefore(io.lstat);
      expect(getConfiguredHostResources()).toBeUndefined();
      expect(match(lexical)).toBe("runtime-settings-file");
      expect(match(canonical)).toBe("runtime-settings-file");
    } finally { await host.close(); }
    expect(match(lexical)).toBeUndefined();
    expect(match(canonical)).toBeUndefined();
  });

  it("does no target I/O if the desktop host starts without global resources and the helper is missing", async () => {
    const { app } = await import("electron");
    const { createDesktopBootHost } = await import("../../boot/desktop-host-runtime.js");
    Object.defineProperty(app, "isPackaged", { value: true });
    io.helperExists.mockReturnValue(false);
    io.lstat.mockClear();
    const host = createDesktopBootHost(PROJECT_ROOT);
    await host.close();
    expect(io.helperExists).toHaveBeenCalledExactlyOnceWith(win32.join(PACKAGED_RESOURCES, "windows-path-kind", process.arch, "ave-path-kind.exe"));
    expect(io.spawnHelper).not.toHaveBeenCalled();
    expect(io.realpath).not.toHaveBeenCalled();
    expect(io.lstat).not.toHaveBeenCalled();
  });

  it("uses separate Node host locality decisions without global resources", async () => {
    const { createNodeBootHost } = await import("../../boot/node-host-runtime.js");
    const { getRuntimeSensitiveKeyPaths } = await import("../../permissions/sensitive-paths.js");
    const { getConfiguredHostResources } = await import("../host-resources.js");
    const key = "C:\\example\\private.key";
    const physical = "C:\\physical\\private.key";
    const binary = win32.join(PACKAGED_RESOURCES, "windows-path-kind", process.arch, "ave-path-kind.exe");
    vi.stubEnv("AVE_SECRET_KEY_FILE", key);
    io.realpath.mockImplementation((path: string) => path === key ? physical : path);

    const host = await createNodeBootHost({ userDataPath: "C:\\profile", resourcePath: PACKAGED_RESOURCES, isPackaged: true, keyFilePath: key });
    try {
      expect(io.helperExists.mock.calls).toEqual([[binary], [binary]]);
      expect(io.spawnHelper).toHaveBeenCalledBefore(io.lstat);
      expect(getRuntimeSensitiveKeyPaths()).toEqual([key, physical]);
      expect(getConfiguredHostResources()).toBeUndefined();
    } finally { await host.close(); }
  });

  it("refuses path admission before lookup when the configured helper is unavailable", async () => {
    const { configureHostResources } = await import("../host-resources.js");
    const { isWindowsPathKindHelperUnavailable } = await import("../windows-path-kind-launcher.js");
    const { admitLocalRoute } = await import("../../shared/local-path-io.js");
    configureHostResources({ resourcePath: PACKAGED_RESOURCES, isPackaged: true });
    io.helperExists.mockReturnValue(false);

    const admit = () => admitLocalRoute("C:\\profile");
    expect(admit).toThrow(expect.objectContaining({
      code: "ENETWORKSHAREPATH",
      cause: expect.toSatisfy(isWindowsPathKindHelperUnavailable),
    }));
    expect(io.helperExists).toHaveBeenCalledOnce();
    expect(io.spawnHelper).not.toHaveBeenCalled();
    expect(io.realpath).not.toHaveBeenCalled();
    expect(io.lstat).not.toHaveBeenCalled();
  });
});

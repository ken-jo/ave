// Chromium resolver overrides bypass the Node DNS checks used by the SSRF guard and must stay disabled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { setIsPackaged, _resetForTest } from "../../boot/dev-flags.js";

useChromiumRuntime();

const appended: Array<{ name: string; value?: string }> = [];

const mockedElectron = vi.hoisted(() => ({
  app: {
    commandLine: {
      appendSwitch: vi.fn(),
      appendArgument: vi.fn(),
    },
    disableHardwareAcceleration: vi.fn(),
    setName: vi.fn(),
    getVersion: () => "0.14.1",
    userAgentFallback: "",
    setAppUserModelId: vi.fn(),
    setToastActivatorCLSID: vi.fn(),
    getPath: vi.fn(() => ""),
    dock: { setIcon: vi.fn() },
    isPackaged: false,
  },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  shell: { readShortcutLink: vi.fn((): { toastActivatorClsid?: string } => ({})) },
  ensureWorkspaceCwd: vi.fn(() => "/tmp/ave-workspace"),
}));

vi.mock("electron", () => ({
  app: mockedElectron.app,
  protocol: mockedElectron.protocol,
  shell: mockedElectron.shell,
}));
vi.mock("../ensure-workspace-cwd.js", () => ({
  ensureWorkspaceCwd: mockedElectron.ensureWorkspaceCwd,
}));
vi.mock("../app-icon.js", () => ({ resolveAppIconPath: () => "/tmp/app-icon.png" }));

import { applyRuntimeAppIcon, runEarlyBootEnv } from "../early-boot-env.js";
import { buildPersistentBrowserUserAgent } from "../browser-user-agent.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { writeSettingsFile as writeSettings } from "./support/settings-file.js";


describe("runEarlyBootEnv", () => {
  it("keeps background tests out of the Dock while preserving ordinary icons", () => {
    setIsPackaged(false);
    setProcessPlatform("darwin");
    vi.stubEnv("AVE_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    applyRuntimeAppIcon();
    expect(mockedElectron.app.dock.setIcon).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "production");
    applyRuntimeAppIcon();
    expect(mockedElectron.app.dock.setIcon).toHaveBeenCalledWith("/tmp/app-icon.png");
  });
  let userDataPath: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    appended.length = 0;
    vi.clearAllMocks();
    mockedElectron.app.commandLine.appendSwitch.mockImplementation(
      (name: string, value?: string) => {
        appended.push({ name, value });
      },
    );
    userDataPath = mkdtempSync(join(tmpdir(), "early-boot-env-"));
    mockedElectron.app.getPath.mockReturnValue(userDataPath);
    // A settings file written by an older build, still carrying the removed manual host-resolver map. Anything that reads settings at boot will find a
    // syntactically valid map here — so the guard test below fails loudly if a reader and `appendSwitch` are ever reinstated.
    writeSettings(userDataPath, {
        llm: { provider: "openai", hostResolverMap: "10.0.0.10 internal-endpoint.example.com" },
      });
    // The WSL/ozone branch is the one command-line path that is exercised on every platform this suite runs on, so it doubles as proof that the
    // `appendSwitch` recorder above is live.
    setProcessPlatform("linux");
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
  });

  afterEach(async () => {
    _resetForTest();
    vi.unstubAllEnvs();
    setProcessPlatform(realPlatform);
    await cleanupTmpDir(userDataPath);
  });

  it("makes ensureWorkspaceCwd (the create-only home write) its first step", () => {
    runEarlyBootEnv();
    const first = mockedElectron.ensureWorkspaceCwd.mock.invocationCallOrder.at(-1)!;
    expect(first).toBeLessThan(mockedElectron.protocol.registerSchemesAsPrivileged.mock.invocationCallOrder.at(-1)!);
    expect(first).toBeLessThan(mockedElectron.app.setName.mock.invocationCallOrder.at(-1)!);
  });

  it("anchors the workspace cwd, registers protocol schemes, and pins the app identity", () => {
    runEarlyBootEnv();

    expect(mockedElectron.ensureWorkspaceCwd).toHaveBeenCalledOnce();
    // Electron takes the privileged schemes in one call.
    expect(mockedElectron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce();
    const schemes = mockedElectron.protocol.registerSchemesAsPrivileged.mock.calls[0]![0].map((entry: { scheme: string }) => entry.scheme);
    expect(schemes).toEqual(["ave-mcp-app", "ave-content"]);
    expect(schemes).not.toContain("ave-plugin");
    expect(mockedElectron.app.setName).toHaveBeenCalledWith("Ave");
    expect(mockedElectron.app.setAppUserModelId).toHaveBeenCalledWith("ai.agent-connector.ave.dev");
    // net.request and hostFetch use the default session, which takes this fallback.
    expect(mockedElectron.app.userAgentFallback).toBe(buildPersistentBrowserUserAgent());
    expect(mockedElectron.app.userAgentFallback).toMatch(/Safari\/537\.36 Ave\/0\.14\.1$/);
  });

  it("keeps the installed app's notification identity out of unpackaged runs on Windows", () => {
    setProcessPlatform("win32");
    runEarlyBootEnv();
    expect(mockedElectron.app.setAppUserModelId).toHaveBeenLastCalledWith("ai.agent-connector.ave.dev");
    expect(mockedElectron.app.setToastActivatorCLSID).toHaveBeenLastCalledWith("{3A31E029-A551-4866-84E0-3F814EE74B69}");

    mockedElectron.app.isPackaged = true;
    try {
      runEarlyBootEnv();
    } finally { mockedElectron.app.isPackaged = false; }
    expect(mockedElectron.app.setAppUserModelId).toHaveBeenLastCalledWith("ai.agent-connector.ave");
    expect(mockedElectron.app.setToastActivatorCLSID).toHaveBeenLastCalledWith("{62FD3EFB-B3D2-4235-9402-6979F52C0286}");
  });

  describe("a dev run's Electron.lnk", () => {
    const shortcutPath = () => join(userDataPath, "Microsoft", "Windows", "Start Menu", "Programs", "Electron.lnk");
    const writeShortcut = (clsid: string) => {
      mkdirSync(join(userDataPath, "Microsoft", "Windows", "Start Menu", "Programs"), { recursive: true });
      writeFileSync(shortcutPath(), "lnk");
      mockedElectron.shell.readShortcutLink.mockReturnValue({ toastActivatorClsid: clsid });
    };

    it("removes a shortcut that carries the installed app's toast activator before the dev CLSID is set", () => {
      setProcessPlatform("win32");
      writeShortcut("{62fd3efb-b3d2-4235-9402-6979f52c0286}");
      mockedElectron.app.setToastActivatorCLSID.mockImplementationOnce(() => {
        expect(existsSync(shortcutPath())).toBe(false);
      });
      runEarlyBootEnv();
      expect(existsSync(shortcutPath())).toBe(false);
      expect(mockedElectron.app.setToastActivatorCLSID).toHaveBeenCalledWith("{3A31E029-A551-4866-84E0-3F814EE74B69}");
    });

    it("keeps a shortcut with any other activator, and never touches it in a packaged run", () => {
      setProcessPlatform("win32");
      writeShortcut("{3A31E029-A551-4866-84E0-3F814EE74B69}");
      runEarlyBootEnv();
      expect(existsSync(shortcutPath())).toBe(true);

      writeShortcut("{62FD3EFB-B3D2-4235-9402-6979F52C0286}");
      mockedElectron.app.isPackaged = true;
      try {
        runEarlyBootEnv();
      } finally { mockedElectron.app.isPackaged = false; }
      expect(existsSync(shortcutPath())).toBe(true);
    });

    it("stops the dev boot when the shortcut cannot be read, rather than adopting its activator", () => {
      setProcessPlatform("win32");
      writeShortcut("{62FD3EFB-B3D2-4235-9402-6979F52C0286}");
      mockedElectron.shell.readShortcutLink.mockImplementationOnce(() => { throw new Error("unreadable"); });
      expect(() => runEarlyBootEnv()).toThrow(/Electron\.lnk/);
      expect(mockedElectron.app.setToastActivatorCLSID).not.toHaveBeenCalled();
    });
  });

  it("honors a persisted hardware-acceleration ON over the Windows/Linux default", () => {
    // The beforeEach seed has no `system.hardwareAcceleration`, so the Linux default (OFF) disables hardware acceleration for this launch.
    runEarlyBootEnv();
    expect(mockedElectron.app.disableHardwareAcceleration).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    writeSettings(userDataPath, { system: { hardwareAcceleration: true } });

    runEarlyBootEnv();
    expect(mockedElectron.app.disableHardwareAcceleration).not.toHaveBeenCalled();
  });

  it("reads the profile only after setName, so it finds the real settings file", () => {
    // `getPath("userData")` resolves off the app name. Reading it before `setName("Ave")` would point at the package-name directory, where the user's choice
    // does not exist — the toggle would silently do nothing.
    const order: string[] = [];
    mockedElectron.app.setName.mockImplementation(() => { order.push("setName"); });
    mockedElectron.app.getPath.mockImplementation(() => {
      order.push("getPath");
      return userDataPath;
    });

    runEarlyBootEnv();

    expect(order.indexOf("setName")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("getPath")).toBeGreaterThan(order.indexOf("setName"));
  });

  it("lets AVE_KEEP_GPU=1 override a persisted off", () => {
    writeSettings(userDataPath, { system: { hardwareAcceleration: false } });
    vi.stubEnv("AVE_KEEP_GPU", "1");

    runEarlyBootEnv();

    expect(mockedElectron.app.disableHardwareAcceleration).not.toHaveBeenCalled();
  });

  it("appends no host-resolver-rules switch even when a legacy map is persisted", () => {
    runEarlyBootEnv();

    // Plumbing proof: the WSL branch DID append, so an absent `host-resolver-rules` below is a real absence, not a dead recorder.
    expect(appended).toContainEqual({ name: "ozone-platform-hint", value: "wayland" });
    expect(appended.map((entry) => entry.name)).not.toContain("host-resolver-rules");
    expect(JSON.stringify(appended)).not.toContain("internal-endpoint.example.com");
  });
});

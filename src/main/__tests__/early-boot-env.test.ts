// Chromium resolver overrides bypass the Node DNS checks used by the SSRF guard and must stay disabled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

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
    dock: undefined,
    isPackaged: false,
  },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  ensureWorkspaceCwd: vi.fn(() => "/tmp/ave-workspace"),
}));

vi.mock("electron", () => ({
  app: mockedElectron.app,
  protocol: mockedElectron.protocol,
}));
vi.mock("../ensure-workspace-cwd.js", () => ({
  ensureWorkspaceCwd: mockedElectron.ensureWorkspaceCwd,
}));

import { runEarlyBootEnv } from "../early-boot-env.js";
import { buildPersistentBrowserUserAgent } from "../browser-user-agent.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { writeSettingsFile as writeSettings } from "./support/settings-file.js";


describe("runEarlyBootEnv", () => {
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
    vi.unstubAllEnvs();
    setProcessPlatform(realPlatform);
    await cleanupTmpDir(userDataPath);
  });

  it("anchors the workspace cwd, registers protocol schemes, and pins the app identity", () => {
    runEarlyBootEnv();

    expect(mockedElectron.ensureWorkspaceCwd).toHaveBeenCalledOnce();
    // Electron takes the privileged schemes in one call.
    expect(mockedElectron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce();
    expect(mockedElectron.protocol.registerSchemesAsPrivileged.mock.calls[0]![0].map((entry: { scheme: string }) => entry.scheme))
      .toEqual(["ave-plugin", "ave-mcp-app", "ave-content"]);
    expect(mockedElectron.app.setName).toHaveBeenCalledWith("Ave");
    expect(mockedElectron.app.setAppUserModelId).toHaveBeenCalledWith("ai.agent-connector.ave");
    // net.request and hostFetch use the default session, which takes this fallback.
    expect(mockedElectron.app.userAgentFallback).toBe(buildPersistentBrowserUserAgent());
    expect(mockedElectron.app.userAgentFallback).toMatch(/Safari\/537\.36 Ave\/0\.14\.1$/);
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

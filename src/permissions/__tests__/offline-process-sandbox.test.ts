import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("../asrt-sandbox.js", () => ({
  isOfflineProcessConfinementActive: vi.fn(() => true),
  getDefaultSensitiveReadDenyPaths: () => ["/private-service-secrets"],
  getDefaultSensitiveWriteDenyPaths: () => ["/private-service-control"],
  buildPerCommandSandboxCustomConfig: vi.fn(policy => ({ filesystem: policy })),
}));
vi.mock("../sandbox-capability.js", () => ({ detectSandboxCapability: vi.fn(() => ({
  kind: "asrt", confidence: "verified", confines: { filesystem: true, process: true, network: true },
})) }));
vi.mock("../../main/codex-executable-location.js", () => ({ assertCodexExecutableLocation: vi.fn(async () => {}) }));
vi.mock("../macos-sandbox-wrap.js", () => ({ hardenMacSandboxGitMetadata: (value: { argv: string[]; env: NodeJS.ProcessEnv }) => value }));
vi.mock("../linux-sandbox-wrap.js", () => ({ hardenLinuxSandboxWrap: (value: { argv: string[]; env: NodeJS.ProcessEnv }) => value }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: { getConfig: () => ({ bwrapPath: "/usr/bin/bwrap" }) } }));
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js", () => ({
  wrapCommandWithSandboxMacOS: vi.fn(() => "confined-native-command"),
}));
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js", () => ({
  wrapCommandWithSandboxLinux: vi.fn(async () => "bwrap --disable-userns --unshare-net -- /bin/sh -c command"),
  cleanupBwrapMountPoints: vi.fn(),
}));

import { wrapOfflineProcess } from "../offline-process-sandbox.js";
import { isOfflineProcessConfinementActive, buildPerCommandSandboxCustomConfig } from "../asrt-sandbox.js";
import { detectSandboxCapability } from "../sandbox-capability.js";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";

const HOST_PLATFORM = process.platform;
let root: string;
let runtime: string;
let input: string;
let output: string;
let ipc: string;

function request() {
  return { command: join(runtime, "engine"), args: ["--headless"], runtimeDirectories: [runtime],
    inputDirectory: input, outputDirectory: output, ipcDirectory: ipc,
    env: { HOME: output, SAL_USE_VCLPLUGIN: "svp", PATH: "/usr/bin:/bin" }, signal: new AbortController().signal };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(isOfflineProcessConfinementActive).mockReturnValue(true);
  vi.mocked(detectSandboxCapability).mockReturnValue({ kind: "asrt", confidence: "verified", platform: HOST_PLATFORM,
    reason: "native test boundary", confines: { filesystem: true, process: true, network: true } });
  vi.mocked(wrapCommandWithSandboxLinux).mockResolvedValue("bwrap --disable-userns --unshare-net -- /bin/sh -c command");
  root = await realpath(await mkdtemp(join(tmpdir(), "offline-process-policy-")));
  runtime = join(root, "runtime"); input = join(root, "input"); output = join(root, "output"); ipc = join(output, "ipc");
  await Promise.all([mkdir(runtime), mkdir(input), mkdir(ipc, { recursive: true })]);
});

afterEach(async () => { setProcessPlatform(HOST_PLATFORM); await rm(root, { recursive: true, force: true }); });

describe("offline process confinement", () => {
  it("hands the native profile no IP proxy exceptions and only its private local socket directory", async () => {
    setProcessPlatform("darwin");
    const wrapped = await wrapOfflineProcess(request());
    const native = vi.mocked(wrapCommandWithSandboxMacOS).mock.calls[0][0];
    expect(native).toMatchObject({ needsNetworkRestriction: true, allowUnixSockets: [ipc],
      allowAllUnixSockets: false, allowLocalBinding: false, allowAppleEvents: false });
    expect(native.httpProxyPort).toBeUndefined();
    expect(native.socksProxyPort).toBeUndefined();
    expect(native.readConfig?.denyOnly).toContain("/");
    expect(native.readConfig?.literalAllowWithinDeny).toContain(runtime);
    expect(native.writeConfig?.allowOnly).toEqual([output]);
    expect(native.writeConfig?.allowOnly).not.toContain(input);
    expect(native.writeConfig?.denyWithinAllow).toContain("/private-service-control");
    expect(buildPerCommandSandboxCustomConfig).toHaveBeenCalledWith(expect.objectContaining({ pinWriteRoots: true }));
    expect(wrapped.env.HOME).toBe(output);
    expect(wrapped.env.SAL_USE_VCLPLUGIN).toBe("svp");
  });

  it("uses an isolated network namespace with no bridge and releases native mount ownership once", async () => {
    setProcessPlatform("linux");
    const wrapped = await wrapOfflineProcess(request());
    expect(wrapCommandWithSandboxLinux).toHaveBeenCalledWith(expect.objectContaining({
      needsNetworkRestriction: true, allowAllUnixSockets: true, allowNestedUserNamespaces: false,
      bwrapPath: "/usr/bin/bwrap", enableWeakerNestedSandbox: false,
    }));
    const native = vi.mocked(wrapCommandWithSandboxLinux).mock.calls[0][0];
    expect(native.httpSocketPath).toBeUndefined();
    expect(native.socksSocketPath).toBeUndefined();
    wrapped.release(); wrapped.release();
    expect(cleanupBwrapMountPoints).toHaveBeenCalledTimes(1);
  });

  it("refuses a local-IPC backend that cannot disable new namespaces", async () => {
    setProcessPlatform("linux");
    vi.mocked(wrapCommandWithSandboxLinux).mockResolvedValue("bwrap --unshare-net -- /bin/sh -c command");
    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({ code: "engine-confinement-unavailable" });
    expect(cleanupBwrapMountPoints).toHaveBeenCalledTimes(1);
  });

  it("requires verified filesystem, process and network confinement without a host fallback", async () => {
    vi.mocked(detectSandboxCapability).mockReturnValue({ kind: "asrt", confidence: "verified", platform: HOST_PLATFORM,
      reason: "partial substrate", confines: { filesystem: true, process: false, network: true } });
    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({ code: "engine-confinement-unavailable" });
    expect(wrapCommandWithSandboxMacOS).not.toHaveBeenCalled();
    expect(wrapCommandWithSandboxLinux).not.toHaveBeenCalled();
  });

  it("rejects an input writable through the output root or an executable outside its authenticated closure", async () => {
    setProcessPlatform("darwin");
    await expect(wrapOfflineProcess({ ...request(), inputDirectory: output })).rejects.toThrow("overlap");
    await expect(wrapOfflineProcess({ ...request(), command: "/usr/local/bin/engine" })).rejects.toThrow("authenticated runtime");
    expect(wrapCommandWithSandboxMacOS).not.toHaveBeenCalled();
  });

  it("leaves the strict offline service unavailable on an unsupported platform", async () => {
    setProcessPlatform("win32");
    await expect(wrapOfflineProcess(request())).rejects.toMatchObject({ code: "engine-confinement-unavailable" });
  });
});

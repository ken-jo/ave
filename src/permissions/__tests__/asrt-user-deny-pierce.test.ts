vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { registerLinuxWrapperProgramFixtures } from "../../__tests__/support/linux-wrapper-programs.js";
import { configureHostResources } from "../../main/host-resources.js";
import { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { buildPolicyModel } from "../policy-model.js";
import { rankMxcFilesystem } from "../mxc-windows.js";
import { admitMxcExtensionFilesystem, buildPerCommandSandboxCustomConfig, getDefaultSensitiveReadDenyPaths, initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";

// The package wrap only: the session is set up through a stub manager, then each wrap is composed for the platform under test.
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: {
  setParentProxyRouter: () => undefined,
  initialize: async () => undefined,
  updateConfig: () => undefined,
  getConfig: () => undefined,
  reset: async () => undefined,
  wrapWithSandboxArgv: async () => ({
    argv: ["/bin/bash", "-c", "/configured/bwrap --new-session --die-with-parent --unshare-pid --ro-bind / / -- /bin/bash -c true"],
    env: process.env,
  }),
  cleanupAfterCommand: () => undefined,
  openInvocationListener: async () => ({ socketPath: "/configured/proxy.sock" }),
  closeInvocationListener: () => undefined,
} }));
vi.mock("../policy-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../policy-model.js")>();
  return { ...actual, buildPolicyModel: vi.fn(actual.buildPolicyModel) };
});
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  },
}));

const hostPlatform = process.platform;
// The Linux program fixtures move the cwd to the drive root on a Windows host, so the resources path is fixed at load.
const resources = resolve("resources");
// The Windows package wrap is the fallback when the container backend is not ready; it composes with host path facts only.
const platforms: NodeJS.Platform[] = hostPlatform === "win32" ? ["darwin", "linux", "win32"] : ["darwin", "linux"];

describe("a user's read deny beats a plugin's host pierce in the package wrap", () => {
  registerLinuxWrapperProgramFixtures();
  const certs = () => join(aveHome(), "certs");
  const corp = () => join(certs(), "corp");

  async function initializeWith(denyRead: string[]): Promise<void> {
    setProcessPlatform("linux");
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead });
  }

  function readFor(platform: NodeJS.Platform): string[] | undefined {
    setProcessPlatform(platform);
    return buildPerCommandSandboxCustomConfig({
      allowRead: [certs(), corp()], denyRead: getDefaultSensitiveReadDenyPaths(), floorPierces: [certs()],
    })?.filesystem?.allowRead?.map(entry => typeof entry === "string" ? entry : entry.path);
  }

  beforeEach(() => {
    configureHostResources({ resourcePath: resources, isPackaged: false });
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: aveHome(), sid: "S-1-5-21-100-200-300-1001" });
    mkdirSync(corp(), { recursive: true });
  });
  afterEach(async () => {
    setProcessPlatform("linux");
    try {
      await resetAsrtSandbox();
    } finally {
      setProcessPlatform(hostPlatform);
      _resetAveHomePrivacyForTest();
    }
  });

  const refusing = [
    { name: "at the pierce", rule: () => certs() },
    { name: "above the pierce", rule: () => aveHome() },
    { name: "a pattern matching the pierce", rule: () => join(aveHome(), "cert*"), pattern: true },
    { name: "a subtree pattern above the pierce", rule: () => join(aveHome(), "**"), pattern: true },
    { name: "a pattern over the pierce's contents", rule: () => join(certs(), "**"), pattern: true },
  ];
  // Linux and the Windows package wrap already refuse a read deny pattern over a grant before any grant is composed.
  const carried = (platform: NodeJS.Platform, pattern?: boolean): boolean => pattern === undefined || platform === "darwin";
  it.each(platforms.flatMap(platform => refusing.filter(entry => carried(platform, entry.pattern)).map(entry => ({ platform, ...entry }))))(
    "on $platform, refuses the launch when the user's deny is $name, naming the rule",
    async ({ platform, rule }) => {
      await initializeWith([rule()]);
      expect(() => readFor(platform)).toThrow(`Your read deny ${rule()} covers ${certs()}, which this launch needs to read; the launch is refused`);
    },
  );

  it.each(platforms)("on %s, keeps the pierce and drops the grant beneath a user's deny inside it", async (platform) => {
    await initializeWith([corp()]);
    vi.mocked(buildPolicyModel).mockClear();
    expect(readFor(platform)).toEqual([certs()]);
    const reasons = vi.mocked(buildPolicyModel).mock.results.flatMap(result => result.value.rows)
      .filter(row => row.access === "denied" && /corp$/u.test(row.path)).map(row => row.reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(["user-deny"]));
  });

  it.each(platforms)("on %s, keeps the pierce and its grants with no user deny", async (platform) => {
    await initializeWith([]);
    expect(readFor(platform)).toEqual([certs(), corp()]);
  });

  // The container backend states the user's denies as their own rows and refuses in the rank, on the admitted paths.
  describe.runIf(hostPlatform === "win32")("the container launch of a plugin child", () => {
    function grantsFor(): ReturnType<typeof rankMxcFilesystem> {
      setProcessPlatform("win32");
      return rankMxcFilesystem(admitMxcExtensionFilesystem({ allowRead: [certs(), corp()], allowWrite: [], floorPierces: [certs()] }).model);
    }

    it.each([
      { name: "at the pierce", rule: () => certs() },
      { name: "above the pierce", rule: () => aveHome() },
      { name: "a pattern matching the pierce", rule: () => join(aveHome(), "cert*") },
      { name: "a pattern over the pierce's contents", rule: () => join(certs(), "**") },
    ])("refuses the launch when the user's deny is $name, naming the rule", async ({ rule }) => {
      await initializeWith([rule()]);
      expect(grantsFor).toThrow(`Your read deny ${rule()} covers ${certs()}, which this launch needs to read; the launch is refused`);
    });

    it("keeps the pierce and denies a user's deny inside it", async () => {
      await initializeWith([corp()]);
      const grants = grantsFor();
      expect(grants.readonly).toEqual([certs()]);
      expect(grants.denied).toContain(corp());
    });
  });
});

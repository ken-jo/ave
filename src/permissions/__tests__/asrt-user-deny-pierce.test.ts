vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { registerLinuxWrapperProgramFixtures } from "../../__tests__/support/linux-wrapper-programs.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setLocale } from "../../i18n/index.js";
import { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { rankMxcFilesystem } from "../mxc-windows.js";
import { admitMxcExtensionFilesystem, initializeAsrtSandbox, resetAsrtSandbox, userDenyInsidePierceNotices } from "../asrt-sandbox.js";

// Seed session policy through a stub manager before ranking the container launch.
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

// Each test gets its own Ave home and workspace in a temp directory: without AVE_TEST_TMP_ROOT the run home lies under the
// account's own `.ave`, whose read boundary would withhold a workspace beside it, and no fixture belongs there.
let scratch = "";
let runHome: string | undefined;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(os.tmpdir(), "ave-pierce-")));
  runHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(scratch, "home");
});
afterEach(() => {
  if (runHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = runHome;
  rmSync(scratch, { recursive: true, force: true });
});

describe("a user's read deny in the container launch", () => {
  registerLinuxWrapperProgramFixtures();
  const certs = () => join(aveHome(), "certs");
  const corp = () => join(certs(), "corp");

  async function initializeWith(denyRead: string[]): Promise<void> {
    setProcessPlatform("linux");
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead });
  }

  beforeEach(() => {
    setLocale("en");
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

    it("keeps the holder notice available when ranking refuses a pierce", async () => {
      const hooks = join(scratch, ".config", "ave", "hooks");
      const hook = join(hooks, "fixture-hook");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(hook, "");
      vi.stubEnv("USERPROFILE", scratch);
      try {
        await initializeWith([corp(), hook]);
        setProcessPlatform("win32");
        expect(() => rankMxcFilesystem(admitMxcExtensionFilesystem({
          allowRead: [certs(), corp(), hook], allowWrite: [], floorPierces: [certs(), hook],
        }).model)).toThrow(`Your read deny ${hook} covers ${hook}`);

        expect(grantsFor().readonly).toEqual([certs()]);
        expect(userDenyInsidePierceNotices([certs()])).toEqual([
          `Your read deny ${corp()} applies inside ${certs()}, which this launch reads; the launch keeps the rest of it and cannot read what the deny matches.`,
        ]);
        expect(userDenyInsidePierceNotices([certs()])).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});

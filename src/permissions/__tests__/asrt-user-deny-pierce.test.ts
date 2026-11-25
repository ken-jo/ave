vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { registerLinuxWrapperProgramFixtures } from "../../__tests__/support/linux-wrapper-programs.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setLocale } from "../../i18n/index.js";
import { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { buildPolicyModel } from "../policy-model.js";
import { rankMxcFilesystem } from "../mxc-windows.js";
import { admitMxcExtensionFilesystem, buildPerCommandSandboxCustomConfig, getBuiltinShellReadPolicy, getDefaultSensitiveReadDenyPaths, initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { createAveHomeBoundarySnapshot } from "../ave-home-boundary-snapshot.js";
import { canonicalizePathForMatch, getConfiguredSessionReadPolicy } from "../sensitive-paths.js";

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

  const spelled = (entry: string | { readonly path: string }): string => typeof entry === "string" ? entry : entry.path;

  function configFor(platform: NodeJS.Platform): { readonly allowRead: string[]; readonly denyRead: string[] } {
    setProcessPlatform(platform);
    const filesystem = buildPerCommandSandboxCustomConfig({
      allowRead: [certs(), corp()], denyRead: getDefaultSensitiveReadDenyPaths(), floorPierces: [certs()],
    })?.filesystem;
    return { allowRead: (filesystem?.allowRead ?? []).map(spelled), denyRead: (filesystem?.denyRead ?? []).map(spelled) };
  }

  function readFor(platform: NodeJS.Platform): string[] {
    return configFor(platform).allowRead;
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

  const refusing = [
    { name: "at the pierce", rule: () => certs() },
    { name: "above the pierce", rule: () => aveHome() },
    { name: "a pattern matching the pierce", rule: () => join(aveHome(), "cert*"), pattern: true },
    { name: "a subtree pattern above the pierce", rule: () => join(aveHome(), "**"), pattern: true },
    { name: "a pattern over the pierce's contents", rule: () => join(certs(), "**"), pattern: true },
  ];
  // The Windows package wrap refuses a read deny pattern over a grant earlier, as an obligation it cannot enforce (glob-not-subtree).
  const carried = (platform: NodeJS.Platform, pattern?: boolean): boolean => pattern === undefined || platform !== "win32";
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

  // A character class has no exact reading in the shared grammar; read as any run, it still decides a deny that cannot reach the pierce.
  // Linux Git quarantine refuses every bracket deny on its own, so there only the home reference is composed.
  const bracketElsewhere = () => join(dirname(aveHome()), "unrelated-dir", "[ab].key");
  const bracketInside = () => join(corp(), "[ab].key");
  const composed = [
    ...platforms.filter(platform => platform !== "linux").map(platform => ({ platform, name: "a bracket pattern in another directory", rule: bracketElsewhere, restated: platform === "darwin" })),
    ...platforms.map(platform => ({ platform, name: "a home reference to another file", rule: () => "%USERPROFILE%/unrelated-secret", restated: false })),
    { platform: "darwin" as const, name: "a bracket pattern inside it", rule: bracketInside, restated: true },
  ];
  it.each(composed)("on $platform, keeps the pierce and its grants beside $name", async ({ platform, rule, restated }) => {
    await initializeWith([rule()]);
    const config = configFor(platform);
    expect(config.allowRead).toEqual([certs(), corp()]);
    // The macOS profile keeps a bracket deny as written and restates it after the allows, so it still holds beneath the pierce.
    if (restated) expect(config.denyRead).toContain(rule());
  });

  it.each([bracketElsewhere, bracketInside])("on linux, a bracket deny meets the Git quarantine refusal, not a user-deny refusal (%#)", async (rule) => {
    await initializeWith([rule()]);
    expect(() => readFor("linux")).toThrow("Linux Git quarantine cannot represent a filesystem deny pattern");
  });

  const undecided = [
    { name: "a bracket pattern that may match the pierce", rule: () => join(aveHome(), "[c]erts") },
    { name: "a bracket pattern that may match an ancestor", rule: () => join(dirname(aveHome()), `[${basename(aveHome()).slice(0, 1)}]${basename(aveHome()).slice(1)}`) },
    { name: "a bracket pattern inside the pierce", rule: () => join(corp(), "[ab].key") },
  ];
  it.each(platforms.flatMap(platform => undecided.slice(0, 2).map(entry => ({ platform, ...entry }))).filter(entry => entry.platform !== "win32"))(
    "on $platform, refuses the launch when it cannot tell whether $name covers it",
    async ({ platform, rule }) => {
      await initializeWith([rule()]);
      expect(() => readFor(platform)).toThrow(`Ave cannot tell whether your read deny ${rule()} covers ${certs()}, which this launch needs to read; the launch is refused`);
    },
  );

  // The Windows package wrap stamps a bracket deny over its whole static base, so one at, above or inside a grant is refused there first.
  it.runIf(platforms.includes("win32")).each(undecided)("on win32, refuses $name as an obligation the package wrap cannot enforce", async ({ rule }) => {
    await initializeWith([rule()]);
    expect(() => readFor("win32")).toThrow(`Windows sandbox obligations cannot be enforced: ${rule()} (glob-not-subtree)`);
  });

  it.runIf(platforms.includes("win32"))("on win32, expands a home reference before matching and refuses one at the pierce", async () => {
    const rule = `%USERPROFILE%/${basename(aveHome())}/certs`;
    await initializeWith([rule]);
    const home = vi.spyOn(os, "homedir").mockReturnValue(dirname(aveHome()));
    try {
      expect(() => readFor("win32")).toThrow(`Your read deny ${rule} covers ${certs()}, which this launch needs to read; the launch is refused`);
    } finally {
      home.mockRestore();
    }
  });

  it.each(platforms)("on %s, keeps the pierce and its grants with no user deny", async (platform) => {
    await initializeWith([]);
    expect(readFor(platform)).toEqual([certs(), corp()]);
  });

  // The macOS and Linux shell withholds the saved-session read under a user's deny instead of refusing every command, only where the deny can match.
  describe("the shell's saved-session read", () => {
    const shellPlatforms = ["darwin", "linux"] as const;
    const sessionRoot = () => getConfiguredSessionReadPolicy().allowRead[0]!;
    const workspace = () => canonicalizePathForMatch(join(dirname(aveHome()), "workspace"));
    const shellFor = (platform: NodeJS.Platform, sessionId = "session-a") => {
      setProcessPlatform(platform);
      return getBuiltinShellReadPolicy([workspace()], undefined, undefined, createAveHomeBoundarySnapshot(sessionId));
    };

    it.each(shellPlatforms)("on %s, keeps it and the working directory beside an unrelated bracket deny", async (platform) => {
      await initializeWith([bracketElsewhere()]);
      const policy = shellFor(platform);
      expect(policy.allowRead).toEqual([workspace(), sessionRoot()]);
      expect(policy.floorPierces).toEqual([sessionRoot()]);
    });
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

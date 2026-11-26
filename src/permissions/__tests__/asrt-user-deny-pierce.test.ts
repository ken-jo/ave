vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { policyHomeAnchors } from "../../shared/policy-home.js";
import { registerLinuxWrapperProgramFixtures } from "../../__tests__/support/linux-wrapper-programs.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setLocale } from "../../i18n/index.js";
import { _resetAveHomePrivacyForTest, aveHome, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { buildPolicyModel } from "../policy-model.js";
import { rankMxcFilesystem } from "../mxc-windows.js";
import { admitMxcExtensionFilesystem, buildPerCommandSandboxCustomConfig, getBuiltinShellReadPolicy, getDefaultSensitiveReadDenyPaths, initializeAsrtSandbox, resetAsrtSandbox, userDenyInsidePierceNotices } from "../asrt-sandbox.js";
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

  it.each(platforms)("on %s, names a user's deny inside the pierce once per session", async (platform) => {
    await initializeWith([corp()]);
    const notices = (sessionId: string): string[] => {
      setProcessPlatform(platform);
      const seen: string[] = [];
      createAveHomeBoundarySnapshot(sessionId).run(() => buildPerCommandSandboxCustomConfig({
        allowRead: [certs(), corp()], denyRead: getDefaultSensitiveReadDenyPaths(), floorPierces: [certs()],
      }, notice => seen.push(notice)));
      return seen;
    };
    const named = [`Your read deny ${corp()} applies inside ${certs()}, which this launch reads; the launch keeps the rest of it and cannot read what the deny matches.`];
    expect(notices("session-a")).toEqual(named);
    expect(notices("session-a")).toEqual([]);
    expect(notices("session-b")).toEqual(named);
  });

  it.each(platforms)("on %s, names a user's deny inside the pierce only once a wrap is admitted", async (platform) => {
    await initializeWith([corp()]);
    const notices = (): string[] => {
      setProcessPlatform(platform);
      const seen: string[] = [];
      createAveHomeBoundarySnapshot("session-a").run(() => buildPerCommandSandboxCustomConfig({
        allowRead: [certs(), corp()], denyRead: getDefaultSensitiveReadDenyPaths(), floorPierces: [certs()],
      }, notice => seen.push(notice)));
      return seen;
    };
    // The wrap fails after its read grants are composed, the last step before it is admitted.
    const model = vi.mocked(buildPolicyModel);
    const actual = model.getMockImplementation();
    if (actual === undefined) throw new Error("The policy model has no implementation");
    model.mockImplementation(input => {
      if (input.launchGrants.some(row => row.access === "ro")) throw new Error("wrap refused late");
      return actual(input);
    });
    try { expect(notices).toThrow("wrap refused late"); }
    finally { model.mockImplementation(actual); }
    expect(notices()).toEqual([`Your read deny ${corp()} applies inside ${certs()}, which this launch reads; the launch keeps the rest of it and cannot read what the deny matches.`]);
  });

  it.each(platforms)("on %s, names no deny beside the pierce", async (platform) => {
    await initializeWith([join(dirname(aveHome()), "unrelated-dir", "secret")]);
    setProcessPlatform(platform);
    const seen: string[] = [];
    buildPerCommandSandboxCustomConfig({ allowRead: [certs(), corp()], denyRead: getDefaultSensitiveReadDenyPaths(), floorPierces: [certs()] }, notice => seen.push(notice));
    expect(seen).toEqual([]);
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

  it("on darwin, says Ave cannot tell what a bracket deny inside the pierce withholds", async () => {
    await initializeWith([bracketInside()]);
    setProcessPlatform("darwin");
    const seen: string[] = [];
    buildPerCommandSandboxCustomConfig({ allowRead: [certs(), corp()], denyRead: getDefaultSensitiveReadDenyPaths(), floorPierces: [certs()] }, notice => seen.push(notice));
    expect(seen).toEqual([`Ave cannot tell whether your read deny ${bracketInside()} applies inside ${certs()}, which this launch reads; the launch keeps the rest of it and cannot read what the deny matches.`]);
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

  // The macOS and Linux shell withholds the saved-session read under a user's deny instead of refusing every command, and says so once per session.
  describe("the shell's saved-session read", () => {
    const shellPlatforms = ["darwin", "linux"] as const;
    const sessionRoot = () => String(getConfiguredSessionReadPolicy().allowRead[0]);
    const workspace = () => canonicalizePathForMatch(join(scratch, "workspace"));

    it("keeps every fixture path in its own temp directory, outside the account's Ave homes", () => {
      const within = (path: string, root: string) => {
        const rest = relative(root.toLowerCase(), resolve(path).toLowerCase());
        return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
      };
      const accountHomes = [String(inject("realAccountHome")), ...policyHomeAnchors()].map(home => resolve(home, ".ave"));
      for (const path of [aveHome(), sessionRoot(), workspace(), certs()]) {
        expect(within(path, scratch), path).toBe(true);
        expect(accountHomes.filter(home => within(path, home)), path).toEqual([]);
      }
    });
    const shellFor = (platform: NodeJS.Platform, sessionId = "session-a") => {
      setProcessPlatform(platform);
      return getBuiltinShellReadPolicy([workspace()], undefined, undefined, createAveHomeBoundarySnapshot(sessionId));
    };

    it.each(shellPlatforms)("on %s, keeps it and the working directory beside an unrelated bracket deny", async (platform) => {
      await initializeWith([bracketElsewhere()]);
      const policy = shellFor(platform);
      expect(policy.allowRead).toEqual([workspace(), sessionRoot()]);
      expect(policy.floorPierces).toEqual([sessionRoot()]);
      expect(policy.policyNotices).toEqual([]);
    });

    it.each(shellPlatforms)("on %s, withholds it under a user's deny and names the rule once per session", async (platform) => {
      const rule = resolve(sessionRoot());
      await initializeWith([rule]);
      const first = shellFor(platform);
      expect(first.allowRead).toEqual([workspace()]);
      expect(first.floorPierces).toEqual([]);
      expect(first.policyNotices).toEqual([
        `Your read deny ${rule} covers the saved-session store ${sessionRoot()}, so shell commands cannot read it.`,
      ]);
      expect(shellFor(platform).policyNotices).toEqual([]);
      expect(shellFor(platform, "session-b").policyNotices).toEqual(first.policyNotices);
    });

    it.each(shellPlatforms)("on %s, keeps it with a user's deny inside and names the rule once per session", async (platform) => {
      const inner = join(sessionRoot(), "private.jsonl");
      await initializeWith([inner]);
      const first = shellFor(platform);
      expect(first.allowRead).toEqual([workspace(), sessionRoot()]);
      expect(first.denyRead).toContain(inner);
      expect(first.policyNotices).toEqual([
        `Your read deny ${inner} applies inside the saved-session store ${sessionRoot()}, so shell commands cannot read what it matches.`,
      ]);
      expect(shellFor(platform).policyNotices).toEqual([]);
    });

    // A pattern rooted at or above the store still reaches files inside it.
    const reachingPatterns = [
      { name: "a subtree pattern rooted at the Ave home", rule: () => join(aveHome(), "**", "*.jsonl") },
      { name: "a subtree pattern rooted above the Ave home", rule: () => join(dirname(aveHome()), "**", "*.jsonl") },
      { name: "a one-level pattern rooted at the Ave home", rule: () => join(aveHome(), "*", "*.jsonl") },
    ];
    it.each(shellPlatforms.flatMap(platform => reachingPatterns.map(entry => ({ platform, ...entry }))))(
      "on $platform, keeps it beside $name and names the rule",
      async ({ platform, rule }) => {
        await initializeWith([rule()]);
        const policy = shellFor(platform);
        expect(policy.allowRead).toEqual([workspace(), sessionRoot()]);
        expect(policy.policyNotices).toEqual([
          `Your read deny ${rule()} applies inside the saved-session store ${sessionRoot()}, so shell commands cannot read what it matches.`,
        ]);
      },
    );

    // The package resolves a relative deny against the working directory and a leading ~ against the home, as Ave does.
    it.each(shellPlatforms)("on %s, names a relative pattern and a home pattern that reach into it", async (platform) => {
      vi.stubEnv("HOME", dirname(aveHome()));
      vi.stubEnv("USERPROFILE", dirname(aveHome()));
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(dirname(aveHome()));
      try {
        const rules = ["**/*.jsonl", `~/${basename(aveHome())}/**/*.jsonl`];
        await initializeWith(rules);
        expect(shellFor(platform).policyNotices).toEqual(rules.map(rule =>
          `Your read deny ${rule} applies inside the saved-session store ${sessionRoot()}, so shell commands cannot read what it matches.`));
      } finally {
        cwd.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it.each(shellPlatforms)("on %s, names no pattern that reaches only a sibling of the store", async (platform) => {
      await initializeWith([join(aveHome(), "unrelated-sibling", "**", "*.jsonl")]);
      expect(shellFor(platform).policyNotices).toEqual([]);
    });

    // A class matches one character, so none of these can reach the store.
    const classesElsewhere = [
      { name: "a class in a sibling of the Ave home", rule: () => join(dirname(aveHome()), "[Dd]ocuments", "secret") },
      { name: "a class spelling a dot directory", rule: () => join(dirname(aveHome()), "[.]ssh", "id_rsa") },
      { name: "a one-character class at the store's depth", rule: () => join(aveHome(), "[x]", "foo") },
    ];
    it.each(shellPlatforms.flatMap(platform => classesElsewhere.map(entry => ({ platform, ...entry }))))(
      "on $platform, names no deny with $name",
      async ({ platform, rule }) => {
        await initializeWith([rule()]);
        const policy = shellFor(platform);
        expect(policy.allowRead).toEqual([workspace(), sessionRoot()]);
        expect(policy.policyNotices).toEqual([]);
      },
    );

    it.each(shellPlatforms)("on %s, says Ave cannot tell when only a class lets a deny reach into it", async (platform) => {
      const rule = join(dirname(sessionRoot()), `[${basename(sessionRoot()).slice(0, 1)}]${basename(sessionRoot()).slice(1)}`, "private.jsonl");
      await initializeWith([rule]);
      const policy = shellFor(platform);
      expect(policy.allowRead).toEqual([workspace(), sessionRoot()]);
      expect(policy.policyNotices).toEqual([
        `Ave cannot tell whether your read deny ${rule} applies inside the saved-session store ${sessionRoot()}; shell commands cannot read what it matches.`,
      ]);
    });

    it("on darwin, withholds it under a bracket deny that may cover it and says Ave cannot tell", async () => {
      const rule = join(dirname(sessionRoot()), `[${basename(sessionRoot()).slice(0, 1)}]${basename(sessionRoot()).slice(1)}`);
      await initializeWith([rule]);
      const policy = shellFor("darwin");
      expect(policy.allowRead).toEqual([workspace()]);
      expect(policy.policyNotices).toEqual([
        `Ave cannot tell whether your read deny ${rule} covers the saved-session store ${sessionRoot()}, so shell commands cannot read it.`,
      ]);
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

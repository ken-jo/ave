// windows-permission
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { windowsPathKindHelperUnavailable } from "../../main/windows-path-kind-launcher.js";
import { configureHostResources } from "../../main/host-resources.js";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { revokeWorkspaceRoot } from "../../engine/turn/session.js";
import { _assertWindowsGrantBoundariesForTest, buildSandboxConfig } from "../../permissions/asrt-sandbox.js";
import { LlmRiskClassifier, RuleBasedRiskClassifier, type LlmReviewerProvider } from "../../permissions/reviewer/risk-classifier.js";
import { derivePluginChildEnvelope } from "../../plugins/isolation/out-of-process-plugin.js";
import { createPathCanonicalizer, createSensitivePathCheck } from "../../permissions/sensitive-paths.js";
import { createFilePathPolicy, createStageWorkspacesSkip } from "../../tools/file-access-policy.js";
import { admitLocalPath, localDriveExists, localFs, withLocalityDecision } from "../local-path-io.js";
import { resolveShellFilesystemPath, verifyLocalFilesystemChain } from "../shell-filesystem-path.js";
import { modelShellPath } from "../shell-native-path.js";
import { setWindowsDriveQueryForTest } from "../windows-drive-locality.js";

// The shared setup answers every drive as local; these checks read synthetic drive mappings.
vi.unmock("../windows-drive-locality.js");
vi.mock("../../permissions/workspace-authorized-roots.js", () => ({ listAuthorizedWorkspaceRoots: () => [] }));

const probes = vi.hoisted(() => ({ calls: [] as string[], links: new Map<string, string>(), realpaths: new Map<string, string>(), denied: new Set<string>() }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const key = (path: unknown) => String(path).replaceAll("\\", "/").toLowerCase();
  const wrap = <T extends (...args: never[]) => unknown>(operation: string, original: T) => (...args: Parameters<T>): unknown => {
    probes.calls.push(String(args[0]));
    const target = probes.links.get(key(args[0]));
    if (target !== undefined && operation === "lstatSync") {
      return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    }
    if (target !== undefined && operation === "readlinkSync") return target;
    if (operation === "realpathSync.native" && probes.denied.has(key(args[0]))) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    if (operation === "realpathSync.native" && probes.realpaths.has(key(args[0]))) return probes.realpaths.get(key(args[0]));
    return original(...args);
  };
  return { ...actual,
    realpathSync: Object.assign(wrap("realpathSync", actual.realpathSync), { native: wrap("realpathSync.native", actual.realpathSync.native) }),
    lstatSync: wrap("lstatSync", actual.lstatSync), statSync: wrap("statSync", actual.statSync),
    readlinkSync: wrap("readlinkSync", actual.readlinkSync), existsSync: wrap("existsSync", actual.existsSync),
    readdirSync: wrap("readdirSync", actual.readdirSync), openSync: wrap("openSync", actual.openSync),
  };
});
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => process.env.USERPROFILE ?? actual.homedir(),
    userInfo: () => ({ homedir: process.env.USERPROFILE, username: "alice", uid: -1, gid: -1, shell: null }),
  };
});

const SHARE = String.raw`\Device\Mup\;LanmanRedirector\;Z:0000000000012345\files.example\share`;
const mappings = new Map<string, string>();
const queries: string[] = [];
const touched = (drive: string) => probes.calls.filter(path => path.toUpperCase().startsWith(drive));
const networkError = expect.objectContaining({ code: "ENETWORKSHAREPATH" });

describe.runIf(process.platform === "win32")("drive locality is proven in each decision before any lookup", () => {
  let root: string;

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-locality-")));
    mappings.clear();
    queries.length = 0;
    setWindowsDriveQueryForTest(drive => {
      queries.push(drive);
      return mappings.get(drive) ?? String.raw`\Device\HarddiskVolume1`;
    });
    probes.calls.length = 0;
  });

  afterEach(() => {
    setWindowsDriveQueryForTest();
    probes.realpaths.clear();
    probes.links.clear();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  afterAll(() => setWindowsDriveQueryForTest());

  it("keeps a substitute over a share-pointing link opaque, so its root is never opened", () => {
    probes.links.set(join(root, "market").replaceAll("\\", "/").toLowerCase(), String.raw`\\files.example\share`);
    mappings.set("S:", `\\??\\${join(root, "market")}`);
    expect(() => verifyLocalFilesystemChain(String.raw`S:\project\notes.txt`)).toThrow(networkError);
    expect(touched("S:")).toEqual([]);
  });

  it("reads a drive mapping again in the next synchronous judgment", () => {
    expect(() => verifyLocalFilesystemChain(String.raw`K:\project\notes.txt`)).not.toThrow();
    mappings.set("K:", SHARE);
    probes.calls.length = 0;
    expect(() => verifyLocalFilesystemChain(String.raw`K:\project\notes.txt`)).toThrow(networkError);
    expect(touched("K:")).toEqual([]);
  });

  it("reads each drive once within one explicit decision", () => {
    const drive = root.slice(0, 2).toUpperCase();
    withLocalityDecision(() => {
      verifyLocalFilesystemChain(join(root, "a", "b"));
      resolveShellFilesystemPath(join(root, "a"), root);
    });
    expect(queries.filter(query => query === drive)).toHaveLength(1);
    verifyLocalFilesystemChain(join(root, "a", "b"));
    expect(queries.filter(query => query === drive)).toHaveLength(2);
  });

  it("retries an unexpected drive-query failure only in a new decision", () => {
    const failure = new Error("Drive query returned an invalid mapping");
    const drive = root.slice(0, 2).toUpperCase();
    const path = join(root, "notes.txt");
    const query = vi.fn<(drive: string) => string | null>()
      .mockImplementationOnce(() => { throw failure; })
      .mockReturnValue(String.raw`\Device\HarddiskVolume1`);
    setWindowsDriveQueryForTest(query);

    expect(() => withLocalityDecision(() => {
      expect(() => verifyLocalFilesystemChain(path)).toThrow(failure);
      expect(() => verifyLocalFilesystemChain(path)).toThrow(failure);
    })).toThrow(failure);
    expect(query.mock.calls).toEqual([[drive]]);
    expect(() => verifyLocalFilesystemChain(path)).not.toThrow();
    expect(query.mock.calls).toEqual([[drive], [drive]]);
  });

  it("refuses a whole judgment after a drive-query failure even when the operand catches it", () => {
    const drive = root.slice(0, 2).toUpperCase();
    const otherDrive = drive === "K:" ? "R:" : "K:";
    const failure = new Error("Drive query returned an invalid mapping");
    let fails = true;
    const query = vi.fn((letter: string) => {
      if (letter === otherDrive && fails) throw failure;
      return "\\Device\\HarddiskVolume1";
    });
    setWindowsDriveQueryForTest(query);

    expect(() => withLocalityDecision(() => {
      const verdict = admitLocalPath(root);
      expect(() => localDriveExists(otherDrive)).toThrow(failure);
      expect(() => localDriveExists(drive)).toThrow(failure);
      expect(() => localFs.lstat(verdict)).toThrow(failure);
    })).toThrow(failure);
    expect(query.mock.calls).toEqual([[drive], [otherDrive]]);

    fails = false;
    withLocalityDecision(() => {
      expect(localDriveExists(drive)).toBe(true);
      expect(localDriveExists(otherDrive)).toBe(true);
    });
    expect(query.mock.calls).toEqual([[drive], [otherDrive], [drive], [otherDrive]]);
  });

  it("refuses every operand when the drive classifier is unavailable", () => {
    const drive = root.slice(0, 2).toUpperCase();
    const other = drive === "K:" ? "R:" : "K:";
    const failure = windowsPathKindHelperUnavailable("The drive classifier did not answer");
    const query = vi.fn((letter: string) => {
      if (letter === other) throw failure;
      return "\\Device\\HarddiskVolume1";
    });
    setWindowsDriveQueryForTest(query);

    const refusal = expect.objectContaining({
      code: "ENETWORKSHAREPATH",
      path: `\\\\?\\GLOBALROOT\\??\\${other}`,
      cause: expect.toSatisfy((cause: unknown) => cause === failure),
    });
    expect(() => withLocalityDecision(() => {
      expect(localDriveExists(drive)).toBe(true);
      expect(() => localDriveExists(other)).toThrow(refusal);
      expect(() => localDriveExists(drive)).toThrow(refusal);
    })).toThrow(refusal);
    expect(query.mock.calls).toEqual([[drive], [other]]);
    expect(localDriveExists(drive)).toBe(true);
  });

  it("rechecks relocated sensitivity anchors when reusing file policy after an await", async () => {
    const home = join(root, "relocated");
    const drive = home.slice(0, 2).toUpperCase();
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
    const policy = createFilePathPolicy();
    const secret = join(home, "secrets", "entry.txt");
    expect(policy.admissionDenied(secret)).toBe("ave-home:secrets");
    expect(policy.sensitive(secret)).toBe("ave-home:secrets");

    await Promise.resolve();
    mappings.set(drive, SHARE);
    queries.length = 0;
    const remappedSecret = win32.join("\\\\files.example\\share", secret.slice(3));
    expect(policy.admissionDenied(remappedSecret)).toBe("ave-home:secrets");
    expect(policy.sensitive(remappedSecret)).toBe("ave-home:secrets");
    expect(queries).toContain(drive);
  });

  it("rechecks the stage workspace anchor and explicit root after a remap", async () => {
    const drive = root.slice(0, 2).toUpperCase();
    const home = join(root, "alias");
    const physicalHome = join(root, "physical");
    const oldStage = join(physicalHome, "worktrees", "example", "abcdefghijkl", "build");
    mkdirSync(oldStage, { recursive: true });
    const homeKey = home.replaceAll("\\", "/").toLowerCase();
    probes.links.set(homeKey, physicalHome);
    probes.realpaths.set(homeKey, physicalHome);
    vi.stubEnv("AVE_HOME", home);
    const lexicalFile = join(home, "worktrees", "example", "abcdefghijkl", "build", "notes.txt");
    const ordinary = createStageWorkspacesSkip(root);
    const explicit = createStageWorkspacesSkip(oldStage);
    const judge = () => withLocalityDecision(() => [ordinary(join(oldStage, "notes.txt")), explicit(lexicalFile)]);

    expect(judge()).toEqual([true, false]);
    await Promise.resolve();
    mappings.set(drive, SHARE);
    queries.length = 0;

    expect(judge()).toEqual([false, true]);
    expect(queries).toEqual([drive]);
  });

  it("proves one drive per Windows grant boundary batch, including a fresh recheck", async () => {
    const profile = join(root, "alice");
    mkdirSync(profile);
    vi.stubEnv("HOME", profile);
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("AVE_HOME", join(profile, "ave-data"));
    const paths = ["first", "second", "third"].map(name => join(root, name));
    for (const path of paths) mkdirSync(path);
    const drive = root.slice(0, 2).toUpperCase();

    _assertWindowsGrantBoundariesForTest(paths, paths.slice(1));
    expect(queries.filter(query => query === drive)).toHaveLength(1);

    await Promise.resolve();
    _assertWindowsGrantBoundariesForTest(paths, paths.slice(1));
    expect(queries.filter(query => query === drive)).toHaveLength(2);
  });

  it("proves one drive per live session revocation batch", () => {
    const removed = join(root, "removed");
    const preserved = join(removed, "preserved");
    const self = {
      sessionProjectRoot: null, sessionProjectName: null, sessionProjectIsDefault: false,
      sessionAdditionalDirectories: [removed, preserved],
      turnAdditionalDirectories: [join(removed, "nested"), join(preserved, "nested")],
      deps: {},
    };
    const result = revokeWorkspaceRoot(self as unknown as ConversationLoop, removed, { preserveRoots: [preserved] });

    expect(result).toEqual({ sessionDirectoriesRemoved: 1, turnDirectoriesRemoved: 1, projectRebound: false });
    expect(self.sessionAdditionalDirectories).toEqual([preserved]);
    expect(self.turnAdditionalDirectories).toEqual([join(preserved, "nested")]);
    expect(queries).toEqual([root.slice(0, 2).toUpperCase()]);
  });

  it("proves one drive per plugin grant batch", () => {
    const pluginDataDir = join(root, "plugin-data");
    mkdirSync(pluginDataDir);
    const chosen = (configKey: string) => ({ kind: "userChosenDirectory" as const, configKey, why: "Plugin work" });
    const configValue = vi.fn((key: string) => join(pluginDataDir, key));
    const result = derivePluginChildEnvelope({
      pluginId: "example", pluginRoot: join(root, "plugins", "example"), pluginDataDir,
      sandbox: { read: [chosen("first"), chosen("second")], write: [chosen("third")] },
      configValue,
    });

    expect(configValue.mock.calls).toEqual([["first"], ["second"], ["third"]]);
    expect(result.write).toContain(pluginDataDir);
    expect(queries.filter(query => query === root.slice(0, 2).toUpperCase())).toHaveLength(1);
  });

  it("proves one drive per reviewer prompt facts batch", async () => {
    const complete = vi.fn<LlmReviewerProvider["complete"]>()
      .mockResolvedValue({ text: '{"level":"low","reason":"test"}', tokensIn: 0, tokensOut: 0, costUsd: 0 });
    const rule = vi.spyOn(RuleBasedRiskClassifier.prototype, "classify").mockReturnValue({ level: "low", reason: "test" });
    try {
      await new LlmRiskClassifier({ complete }, "test").classify({
        toolName: "example", source: "builtin", category: "read", pathFields: ["files"],
        trustOrigin: "user-keyboard", finalInput: { files: ["first.txt", "second.txt", "third.txt"] },
        executionCwd: root, allowedDirectories: [], sensitivePathsAdjacent: [],
        sandboxCapability: { kind: "none", confidence: "verified", platform: "win32", reason: "none" },
      });
      expect(complete.mock.calls[0]?.[0].userPrompt).toContain('"declaredPathCount":3');
      expect(queries.filter(query => query === root.slice(0, 2).toUpperCase())).toHaveLength(1);
    } finally {
      rule.mockRestore();
    }
  });

  it("proves a listing's drive again for the first row after an await", async () => {
    const drive = root.slice(0, 2).toUpperCase();
    mkdirSync(join(root, "project"));
    const check = createSensitivePathCheck("read");
    withLocalityDecision(() => {
      check(join(root, "project", "a.txt"));
      check(join(root, "project", "b.txt"));
    });
    expect(queries.filter(query => query === drive)).toHaveLength(1);
    mappings.set(drive, SHARE);
    await Promise.resolve();
    probes.calls.length = 0;
    check(join(root, "project", "a.txt"));
    expect(queries.filter(query => query === drive)).toHaveLength(2);
    expect(touched(drive)).toEqual([]);
  });

  it("records no identity for a step its canonicalization cannot read", () => {
    mkdirSync(join(root, "locked"));
    const locked = join(root, "locked").replaceAll("\\", "/").toLowerCase();
    probes.denied.add(locked);
    const canonicalize = createPathCanonicalizer();
    const first = canonicalize(join(root, "locked", "notes.txt"));
    expect(first).toMatch(/^\/\/\?\/globalroot\//iu);
    probes.denied.clear();
    expect(canonicalize(join(root, "locked", "notes.txt"))).not.toMatch(/globalroot/iu);
  });

  it("models a Bash drive spelling without opening the drive", () => {
    mappings.set("J:", SHARE);
    expect(modelShellPath("/j/project/notes.txt", { dialect: "bash", location: root }).nativePath).toBe("j:/project/notes.txt");
    expect(() => resolveShellFilesystemPath("/j/project/notes.txt", root, { dialect: "bash" })).toThrow(networkError);
    expect(touched("J:")).toEqual([]);
  });

  it("stops a link walk at an extended drive target before following it", () => {
    mkdirSync(join(root, "real"));
    probes.links.set(join(root, "link").replaceAll("\\", "/").toLowerCase(), `\\\\?\\${join(root, "real")}`);
    expect(() => verifyLocalFilesystemChain(join(root, "link", "notes.txt"))).toThrow(networkError);
    expect(probes.calls.filter(path => path.startsWith("\\\\"))).toEqual([]);
  });

  it("proves a drive a link reaches before descending into it", () => {
    mappings.set("N:", SHARE);
    probes.links.set(join(root, "mapped").replaceAll("\\", "/").toLowerCase(), String.raw`N:\data`);
    expect(() => verifyLocalFilesystemChain(join(root, "mapped", "notes.txt"))).toThrow(networkError);
    expect(touched("N:")).toEqual([]);
  });

  it("builds no deny row and no write authority from a Documents folder on a mapped drive", () => {
    const home = join(root, "alice");
    mkdirSync(home);
    mkdirSync(join(root, "ave-home"));
    mkdirSync(join(root, "work"));
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("AVE_HOME", join(root, "ave-home"));
    mappings.set("M:", SHARE);
    probes.calls.length = 0;
    const config = buildSandboxConfig({
      allowWrite: [join(root, "work")], resolveWindowsDocumentsPath: () => String.raw`M:\Documents`,
      windows: { externalConfinement: true },
    });
    expect(config.filesystem.allowWrite).toEqual([]);
    const rows = (config.filesystem.denyWrite ?? []).map(row => typeof row === "string" ? row : row.path);
    expect(rows.filter(row => row.toUpperCase().startsWith("M:"))).toEqual([]);
    expect(touched("M:")).toEqual([]);
  });
});

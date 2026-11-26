// windows-permission
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { buildSandboxConfig } from "../../permissions/asrt-sandbox.js";
import { createPathCanonicalizer, createSensitivePathCheck } from "../../permissions/sensitive-paths.js";
import { openLocalityDecision, withLocalityDecision } from "../local-path-io.js";
import { resolveShellFilesystemPath, verifyLocalFilesystemChain } from "../shell-filesystem-path.js";
import { modelShellPath } from "../shell-native-path.js";
import { setWindowsDriveQueryForTest } from "../windows-drive-locality.js";

// The shared setup answers every drive as local; these checks read synthetic drive mappings.
vi.unmock("../windows-drive-locality.js");

const probes = vi.hoisted(() => ({ calls: [] as string[], links: new Map<string, string>(), denied: new Set<string>() }));
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
    return original(...args);
  };
  return { ...actual,
    realpathSync: Object.assign(wrap("realpathSync", actual.realpathSync), { native: wrap("realpathSync.native", actual.realpathSync.native) }),
    lstatSync: wrap("lstatSync", actual.lstatSync), statSync: wrap("statSync", actual.statSync),
    readlinkSync: wrap("readlinkSync", actual.readlinkSync), existsSync: wrap("existsSync", actual.existsSync),
    readdirSync: wrap("readdirSync", actual.readdirSync), openSync: wrap("openSync", actual.openSync),
  };
});
vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  userInfo: () => ({ homedir: process.env.USERPROFILE, username: "alice", uid: -1, gid: -1, shell: null }),
}));

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
    }, openLocalityDecision());
    expect(queries.filter(query => query === drive)).toHaveLength(1);
    verifyLocalFilesystemChain(join(root, "a", "b"));
    expect(queries.filter(query => query === drive)).toHaveLength(2);
  });

  it("proves a listing's drive again for the first row after an await", async () => {
    const drive = root.slice(0, 2).toUpperCase();
    mkdirSync(join(root, "project"));
    const check = createSensitivePathCheck("read");
    check(join(root, "project", "a.txt"));
    check(join(root, "project", "b.txt"));
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

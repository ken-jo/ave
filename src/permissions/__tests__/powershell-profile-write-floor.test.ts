import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { admitMxcExtensionFilesystem, buildSandboxConfig, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { rankMxcFilesystem } from "../mxc-windows.js";

const ENGINES = ["WindowsPowerShell", "PowerShell"];
const profilesIn = (documents: string): string[] => ENGINES.flatMap(engine => [
  join(documents, engine, "profile.ps1"), join(documents, engine, "Microsoft.PowerShell_profile.ps1"),
]);
const literalDeny = (path: string) => ({ path, literal: true });

vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  userInfo: () => ({ homedir: process.env.USERPROFILE, username: "alice", uid: -1, gid: -1, shell: null }),
}));

describe.skipIf(process.platform !== "win32")("Windows profile write floor", () => {
  let root: string;
  let documents: string;

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "profile-write-floor-")));
    const home = join(root, "alice");
    const aveHome = join(root, "ave-home");
    mkdirSync(home);
    mkdirSync(aveHome);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("AVE_HOME", aveHome);
    documents = join(root, "relocated", "Documents");
    for (const engine of ENGINES) mkdirSync(join(documents, engine), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps present and missing profiles protected inside a Documents grant", () => {
    const present = ENGINES.map(engine => join(documents, engine, "profile.ps1"));
    const missing = ENGINES.map(engine => join(documents, engine, "Microsoft.PowerShell_profile.ps1"));
    const adjacent = ENGINES.map(engine => join(documents, engine, "notes.ps1"));
    for (const path of [...present, ...adjacent]) writeFileSync(path, "");
    const resolveWindowsDocumentsPath = () => documents;

    const denyWrite = getDefaultSensitiveWriteDenyPaths(undefined, resolveWindowsDocumentsPath);
    const grants = rankMxcFilesystem({ allowWrite: [documents], allowRead: [], denyWrite, denyRead: [], protectedFloor: [] }, existsSync);
    expect(grants).toEqual({ readwrite: [documents], readonly: present, denied: missing });

    const config = buildSandboxConfig({ allowWrite: [documents], resolveWindowsDocumentsPath, windows: { externalConfinement: true } });
    expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining([...present, ...missing].map(literalDeny)));
    for (const path of adjacent) expect(config.filesystem.denyWrite).not.toContainEqual(literalDeny(path));

    const extension = admitMxcExtensionFilesystem({ allowWrite: [documents], allowRead: [], denyWrite }, {
      readRoots: [], writeRoots: [documents], hostStorageRoots: [],
    });
    expect(rankMxcFilesystem(extension.policy, existsSync)).toMatchObject({
      readwrite: [documents], readonly: expect.arrayContaining(present), denied: expect.arrayContaining(missing),
    });
  });

  it("retains the Documents spelling and its resolved alias for missing leaves", () => {
    const alias = join(root, "redirected-documents");
    symlinkSync(documents, alias, "junction");
    const denyWrite = getDefaultSensitiveWriteDenyPaths(undefined, () => alias);

    for (const path of [alias, documents]) {
      const profiles = ENGINES.flatMap(engine => [
        join(path, engine, "profile.ps1"), join(path, engine, "Microsoft.PowerShell_profile.ps1"),
      ]);
      expect(denyWrite).toEqual(expect.arrayContaining(profiles));
      expect(rankMxcFilesystem({ allowWrite: [path], allowRead: [], denyWrite, denyRead: [], protectedFloor: [] }, existsSync))
        .toEqual({ readwrite: [path], readonly: [], denied: profiles });
    }
  });

  it("protects a missing engine directory under a case-changed grant", () => {
    const defaultDocuments = join(root, "alice", "Documents");
    const adjacent = join(defaultDocuments, "work");
    mkdirSync(adjacent, { recursive: true });
    const denyWrite = getDefaultSensitiveWriteDenyPaths(undefined, () => defaultDocuments);
    const extension = admitMxcExtensionFilesystem({ allowRead: [], allowWrite: [defaultDocuments.toUpperCase(), adjacent], denyWrite }, {
      readRoots: [], writeRoots: [defaultDocuments], hostStorageRoots: [],
    });

    const grants = rankMxcFilesystem(extension.policy, existsSync);
    expect(grants.denied).toEqual(expect.arrayContaining(ENGINES.map(engine => join(defaultDocuments, engine))));
    expect(grants.readwrite).toContain(adjacent);
  });

  it("protects the absent physical target of an engine junction", () => {
    const linkedDocuments = join(root, "linked-documents");
    const targetParent = join(root, "writable-targets");
    const target = join(targetParent, "future-engine");
    const unrelated = join(targetParent, "work");
    mkdirSync(linkedDocuments);
    mkdirSync(unrelated, { recursive: true });
    const engine = join(linkedDocuments, "PowerShell");
    symlinkSync(target, engine, "junction");

    const { filesystem } = buildSandboxConfig({
      allowWrite: [targetParent, linkedDocuments], resolveWindowsDocumentsPath: () => linkedDocuments,
      windows: { externalConfinement: true },
    });
    const paths = (entries: typeof filesystem.denyWrite) => entries.map(entry => typeof entry === "string" ? entry : entry.path);
    const denyWrite = paths(filesystem.denyWrite);
    expect(denyWrite).toEqual(expect.arrayContaining([
      join(engine, "profile.ps1"), join(target, "profile.ps1"), join(target, "Microsoft.PowerShell_profile.ps1"),
    ]));
    const grants = rankMxcFilesystem({
      allowWrite: paths(filesystem.allowWrite), allowRead: [], denyWrite, denyRead: [], protectedFloor: [],
    }, existsSync);
    expect(grants.denied).toContain(target);
    expect(grants.readwrite).toContain(targetParent);
    expect(grants.denied.some(path => unrelated.startsWith(`${path}\\`))).toBe(false);
  });

  it("protects a configured Documents directory before it exists", () => {
    const parent = join(root, "configured");
    const missingDocuments = join(parent, "Documents");
    const defaultDocuments = join(root, "alice", "Documents");
    mkdirSync(parent);
    mkdirSync(defaultDocuments);
    const config = buildSandboxConfig({
      allowWrite: [parent, defaultDocuments], resolveWindowsDocumentsPath: () => missingDocuments,
      windows: { externalConfinement: true },
    });

    expect(config.filesystem.allowWrite).toContainEqual(expect.objectContaining({ path: parent, literal: true }));
    expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining([...profilesIn(missingDocuments), ...profilesIn(defaultDocuments)].map(literalDeny)));
  });

  it.each([
    { reason: "lookup error", resolveDocumentsPath: () => { throw new Error("Documents lookup failed"); } },
    { reason: "empty result", resolveDocumentsPath: () => "" },
  ])("withholds writes and protects default locations after a $reason", ({ resolveDocumentsPath }) => {
    const defaultDocuments = join(root, "alice", "Documents");
    mkdirSync(defaultDocuments);
    const config = buildSandboxConfig({
      allowWrite: [join(root, "relocated"), defaultDocuments], resolveWindowsDocumentsPath: resolveDocumentsPath,
      windows: { externalConfinement: true },
    });

    expect(config.filesystem.allowWrite).toEqual([]);
    expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining(profilesIn(defaultDocuments).map(literalDeny)));
  });

  it("protects default profile locations when Documents is outside local grants", () => {
    const denyWrite = getDefaultSensitiveWriteDenyPaths(undefined, () => "\\\\server\\share\\Documents");
    expect(denyWrite).toEqual(expect.arrayContaining(profilesIn(join(root, "alice", "Documents"))));
  });
});

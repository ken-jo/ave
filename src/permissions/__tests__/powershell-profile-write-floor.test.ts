import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { entryPaths } from "../../__tests__/support/filesystem-policy-paths.js";
import { admitMxcExtensionFilesystem, buildSandboxConfig, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { rankMxcRowsBySpelling } from "../mxc-windows.js";
import { rankMxcLists } from "../../__tests__/support/mxc-policy-rows.js";
import { resetWatchedRows, watchedProtectedRows } from "../windows-watched-rows.js";

const ENGINES = ["WindowsPowerShell", "PowerShell"];
const profilesIn = (documents: string): string[] => ENGINES.flatMap(engine => [
  join(documents, engine, "profile.ps1"), join(documents, engine, "Microsoft.PowerShell_profile.ps1"),
]);

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
    resetWatchedRows();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("stamps present profiles and watches missing ones inside a Documents grant", () => {
    const present = ENGINES.map(engine => join(documents, engine, "profile.ps1"));
    const missing = ENGINES.map(engine => join(documents, engine, "Microsoft.PowerShell_profile.ps1"));
    const adjacent = ENGINES.map(engine => join(documents, engine, "notes.ps1"));
    for (const path of [...present, ...adjacent]) writeFileSync(path, "");
    const resolveWindowsDocumentsPath = () => documents;

    const denyWrite = getDefaultSensitiveWriteDenyPaths(undefined, resolveWindowsDocumentsPath);
    const grants = rankMxcLists({ allowWrite: [documents], allowRead: [], denyWrite, denyRead: [], protectedFloor: [] }, existsSync);
    expect(grants).toEqual({ readwrite: [documents], readonly: present, denied: missing });

    const config = buildSandboxConfig({ allowWrite: [documents], resolveWindowsDocumentsPath, windows: { externalConfinement: true } });
    expect(entryPaths(config.filesystem.denyWrite)).toEqual(expect.arrayContaining(present));
    for (const path of missing) expect(entryPaths(config.filesystem.denyWrite)).not.toContain(path);
    expect(watchedProtectedRows()).toEqual(expect.arrayContaining(missing));
    for (const path of missing) expect(existsSync(path)).toBe(false);
    for (const path of adjacent) expect(entryPaths(config.filesystem.denyWrite)).not.toContain(path);

    const extension = admitMxcExtensionFilesystem({ allowWrite: [documents], allowRead: [], denyWrite }, {
      readRoots: [], writeRoots: [documents], hostStorageRoots: [],
    });
    expect(rankMxcRowsBySpelling(extension.model, existsSync)).toMatchObject({
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
      expect(rankMxcLists({ allowWrite: [path], allowRead: [], denyWrite, denyRead: [], protectedFloor: [] }, existsSync))
        .toEqual({ readwrite: [path], readonly: [], denied: profiles });
    }
    expect(() => buildSandboxConfig({
      allowWrite: [root], resolveWindowsDocumentsPath: () => alias, windows: { externalConfinement: true },
    })).toThrow(expect.objectContaining({
      code: "sandbox-obligation-unenforceable",
      rows: expect.arrayContaining([{ row: profilesIn(alias)[0], reason: "link-spelling" }]),
    }));
  });

  it("protects a missing engine directory under a case-changed grant", () => {
    const defaultDocuments = join(root, "alice", "Documents");
    const adjacent = join(defaultDocuments, "work");
    mkdirSync(adjacent, { recursive: true });
    const denyWrite = getDefaultSensitiveWriteDenyPaths(undefined, () => defaultDocuments);
    const extension = admitMxcExtensionFilesystem({ allowRead: [], allowWrite: [defaultDocuments.toUpperCase(), adjacent], denyWrite }, {
      readRoots: [], writeRoots: [defaultDocuments], hostStorageRoots: [],
    });

    const grants = rankMxcRowsBySpelling(extension.model, existsSync);
    expect(grants.denied).toEqual(expect.arrayContaining(ENGINES.map(engine => join(defaultDocuments, engine))));
    expect(grants.readwrite).toContain(adjacent);
  });

  it("refuses confinement when a profile deny crosses a dangling engine junction", () => {
    const linkedDocuments = join(root, "linked-documents");
    const targetParent = join(root, "writable-targets");
    const target = join(targetParent, "future-engine");
    mkdirSync(linkedDocuments);
    mkdirSync(targetParent);
    const engine = join(linkedDocuments, "PowerShell");
    symlinkSync(target, engine, "junction");

    expect(() => buildSandboxConfig({
      allowWrite: [targetParent, linkedDocuments], resolveWindowsDocumentsPath: () => linkedDocuments,
      windows: { externalConfinement: true },
    })).toThrow(expect.objectContaining({
      code: "sandbox-obligation-unenforceable",
      rows: expect.arrayContaining([{ row: join(engine, "profile.ps1"), reason: "link-spelling" }]),
    }));
  });

  it("watches the profiles of a configured Documents directory before it exists", () => {
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
    const rows = [...profilesIn(missingDocuments), ...profilesIn(defaultDocuments)];
    for (const row of rows) expect(entryPaths(config.filesystem.denyWrite)).not.toContain(row);
    expect(watchedProtectedRows()).toEqual(expect.arrayContaining(rows));
    expect(existsSync(missingDocuments)).toBe(false);
  });

  it.each([
    { reason: "lookup error", resolveDocumentsPath: () => { throw new Error("Documents lookup failed"); } },
    { reason: "empty result", resolveDocumentsPath: () => "" },
  ])("withholds writes and never stamps absent default locations after a $reason", ({ resolveDocumentsPath }) => {
    const defaultDocuments = join(root, "alice", "Documents");
    mkdirSync(defaultDocuments);
    const config = buildSandboxConfig({
      allowWrite: [join(root, "relocated"), defaultDocuments], resolveWindowsDocumentsPath: resolveDocumentsPath,
      windows: { externalConfinement: true },
    });

    expect(config.filesystem.allowWrite).toEqual([]);
    for (const row of profilesIn(defaultDocuments)) expect(entryPaths(config.filesystem.denyWrite)).not.toContain(row);
    for (const engine of ENGINES) expect(existsSync(join(defaultDocuments, engine))).toBe(false);
  });

  it("protects default profile locations when Documents is outside local grants", () => {
    const denyWrite = getDefaultSensitiveWriteDenyPaths(undefined, () => "\\\\server\\share\\Documents");
    expect(denyWrite).toEqual(expect.arrayContaining(profilesIn(join(root, "alice", "Documents"))));
  });
});

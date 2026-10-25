import { canCreateSymlinks } from "../../../__tests__/support/symlink-capability.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeVolume, marketplaceRefusal as refused, nodeFolders, TEST_FOLDER_LIMITS, writeFolderFiles } from "../../__tests__/fixtures/folder-fs.js";
import { folderService } from "../../__tests__/fixtures/folder-service.js";
import { descriptorText } from "../../__tests__/fixtures/package-files.js";

const skill = (name: string) => descriptorText("skill", name, "1.0.0", { entry: "SKILL.md" });
const index = `${JSON.stringify({ schemaVersion: 2, name: "team", displayName: "Team tools", packages: [{ kind: "skill", name: "alpha", path: "skills/alpha" }] })}\n`;
const SKILL = "---\nname: note\ndescription: A note skill\n---\nWrite notes.\n";

let root: string;
let folder: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-folder-view-"));
  folder = join(mkdtempSync(join(tmpdir(), "ave-folder-view-source-")), "market");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(folder), { recursive: true, force: true });
});

function localVolume() {
  return new FakeVolume(process.platform, { drives: { [tmpdir().slice(0, 2).toUpperCase()]: "\\Device\\HarddiskVolume1" } });
}

async function addLocalMarket(volume?: FakeVolume) {
  const files = {
    "marketplace.json": index,
    "skills/alpha/ave-package.json": skill("alpha"),
    "skills/alpha/SKILL.md": "Write alpha.\n",
  };
  if (volume) for (const [path, contents] of Object.entries(files)) volume.file(join(folder, path), contents);
  else writeFolderFiles(folder, files);
  const folders = volume ? { ...nodeFolders(), fs: volume } : nodeFolders();
  const harness = await folderService({ root, folders });
  const preview = await harness.service.previewSource({ input: folder, auth: "none" });
  if (preview.type !== "marketplace") throw new Error(`expected a marketplace preview, got ${preview.type}`);
  const view = await harness.service.addSource({ previewId: preview.previewId, id: "team" });
  return { harness, preview, view };
}

function windowsVolume() {
  const drives: Record<string, string> = { "C:": "\\Device\\HarddiskVolume3", "Z:": "\\Device\\HarddiskVolume4" };
  const volume = new FakeVolume("win32", { drives });
  return { volume, drives };
}

async function windowsService(volume: FakeVolume, now?: () => Date) {
  return folderService({ root, folders: { fs: volume, platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example", ...(now ? { now } : {}) });
}

async function addLocalDrive(volume: FakeVolume, now?: () => Date) {
  volume.file("Z:\\m\\SKILL.md", SKILL);
  const harness = await windowsService(volume, now);
  const preview = await harness.service.previewSource({ input: "Z:\\m", auth: "none" });
  if (preview.type === "confirm") throw new Error("a local drive needs no confirmation");
  await harness.service.addSource({ previewId: preview.previewId, id: "notes" });
  return harness;
}

const SHARE = "\\Device\\Mup\\;LanmanRedirector\\;Z:000000000001a2b3\\files.corp\\share";

describe("folder badges (§18.4.8)", () => {
  it("shows Local folder on the preview, the row and every package card of a folder on this computer", async () => {
    const { harness, preview, view } = await addLocalMarket();
    try {
      expect(preview.badges).toEqual(["local-folder"]);
      expect(view.badges).toEqual(["local-folder"]);
      const catalog = await harness.service.catalog({ sourceId: "team" });
      expect(catalog.entries.map((item) => item.sourceBadges)).toEqual([["local-folder"]]);
      const sources = await harness.service.listSources();
      for (const item of sources.filter((candidate) => candidate.transport === "git")) expect(item.badges).not.toContain("local-folder");
    } finally {
      harness.service.close();
    }
  });

  it("shows Network folder for a share read after network-folder was confirmed", async () => {
    const { volume } = windowsVolume();
    volume.file("\\\\files.corp\\share\\m\\SKILL.md", SKILL);
    const harness = await windowsService(volume);
    try {
      const preview = await harness.service.previewSource({ input: "\\\\files.corp\\share\\m", auth: "none", acknowledge: ["network-folder"] });
      if (preview.type === "confirm") throw new Error("the confirmation was carried");
      expect(preview.badges).toEqual(["network-folder"]);
      const view = await harness.service.addSource({ previewId: preview.previewId, id: "notes" });
      expect(view.badges).toEqual(["network-folder"]);
    } finally {
      harness.service.close();
    }
  });
});

describe("folder badges when the folder or its classifier changes (§18.4.8)", () => {
  it("marks only that folder when its classifier cannot run, and keeps every row and package listed", async () => {
    let clock = Date.parse("2026-10-02T00:00:00.000Z");
    const { volume } = windowsVolume();
    const harness = await addLocalDrive(volume, () => new Date(clock));
    try {
      const healthy = volume.queryDosDevice.bind(volume);
      volume.queryDosDevice = async () => {
        throw new Error("Windows folder classifier is missing: C:\\Ave\\resources\\windows-path-kind\\x64\\ave-path-kind.exe. Reinstall Ave.");
      };
      clock += 60_001;
      const sources = await harness.service.listSources();
      expect(sources.find((item) => item.id === "notes")!.badges).toEqual(["folder-unclassified"]);
      expect(sources.filter((item) => item.transport === "git").length).toBeGreaterThan(0);
      const catalog = await harness.service.catalog({});
      expect(catalog.entries.filter((item) => item.key.sourceId === "notes").map((item) => item.sourceBadges)).toEqual([["folder-unclassified"]]);

      volume.queryDosDevice = healthy;
      expect((await harness.service.listSources()).find((item) => item.id === "notes")!.badges).toEqual(["local-folder"]);
    } finally {
      harness.service.close();
    }
  });

  it("says a drive now on a share the source was never allowed for is not allowed, rather than claiming consent", async () => {
    let clock = Date.parse("2026-10-02T00:00:00.000Z");
    const { volume, drives } = windowsVolume();
    const harness = await addLocalDrive(volume, () => new Date(clock));
    try {
      drives["Z:"] = SHARE;
      clock += 60_000;
      expect((await harness.service.listSources()).find((item) => item.id === "notes")!.badges).toEqual(["network-folder-unconfirmed"]);
    } finally {
      harness.service.close();
    }
  });
});

describe("package provenance of a folder (§18.4.8)", () => {
  it("names the folder, when it was read and the digest of what the package installs", async () => {
    const { harness, view } = await addLocalMarket(localVolume());
    try {
      const detail = await harness.service.detail({ sourceId: "team", kind: "skill", name: "alpha" });
      const snapshot = (await harness.syncer.readSnapshot("team"))!;
      expect(detail.provenance.repository).toBeNull();
      expect(detail.provenance.folder).toEqual({
        path: view.path,
        readAt: view.lastSyncAt,
        contents: snapshot.packages[0]!.treeSha256,
      });
      expect(detail.provenance.folder!.contents).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      harness.service.close();
    }
  });
});

describe("revealFolder (§18.9)", () => {
  it("answers a folder source's canonical path, null for a git source, and refuses an unknown id", async () => {
    const { harness, view } = await addLocalMarket(localVolume());
    try {
      await expect(harness.service.revealFolder("team")).resolves.toBe(view.path);
      const git = (await harness.service.listSources()).find((item) => item.transport === "git");
      expect(git).toBeDefined();
      await expect(harness.service.revealFolder(git!.id)).resolves.toBeNull();
      expect(await refused(harness.service.revealFolder("nowhere"))).toMatchObject({ code: "SOURCE_ID_INVALID" });
    } finally {
      harness.service.close();
    }
  });

  it("says the folder is gone instead of opening nothing", async () => {
    const volume = localVolume();
    const { harness, view } = await addLocalMarket(volume);
    try {
      volume.remove(folder);
      expect(await refused(harness.service.revealFolder("team"))).toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "not-found", path: view.path } });
    } finally {
      harness.service.close();
    }
  });

  it.skipIf(!canCreateSymlinks())("says the folder moved when its path now leads to another folder, instead of showing that one", async () => {
    const { harness, view } = await addLocalMarket();
    try {
      const elsewhere = join(dirname(folder), "elsewhere");
      mkdirSync(elsewhere);
      rmSync(folder, { recursive: true, force: true });
      symlinkSync(elsewhere, folder, "dir");
      expect(await refused(harness.service.revealFolder("team"))).toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "moved", path: view.path } });
    } finally {
      harness.service.close();
    }
  });

  it("says the folder moved when a different directory was made at its path, as a refresh says", async () => {
    const { harness, view } = await addLocalMarket();
    try {
      renameSync(folder, join(dirname(folder), "old"));
      mkdirSync(folder);
      const refreshed = (await harness.service.refresh("team")).find((item) => item.id === "team")!;
      expect(refreshed.status).toMatchObject({ state: "unreachable", code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "moved" } });
      expect(await refused(harness.service.revealFolder("team"))).toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "moved", path: view.path, target: view.path } });
    } finally {
      harness.service.close();
    }
  });

  it("classifies the drive again as its last step, so a remap during the walk is refused, not shown", async () => {
    const { volume, drives } = windowsVolume();
    const harness = await addLocalDrive(volume);
    try {
      const lstat = volume.lstat.bind(volume);
      volume.lstat = async (path) => {
        const answer = await lstat(path);
        if (path === "Z:\\m") drives["Z:"] = SHARE;
        return answer;
      };
      expect(await refused(harness.service.revealFolder("notes"))).toMatchObject({ code: "SOURCE_CONFIRMATION_REQUIRED", detail: { reason: "network-folder", server: "files.corp" } });
    } finally {
      harness.service.close();
    }
  });

  it("does not touch a drive that now maps to a share the source was never allowed to read", async () => {
    const { volume, drives } = windowsVolume();
    volume.file("Z:\\m\\SKILL.md", SKILL);
    const harness = await windowsService(volume);
    try {
      const preview = await harness.service.previewSource({ input: "Z:\\m", auth: "none" });
      if (preview.type === "confirm") throw new Error("a local drive needs no confirmation");
      expect(preview.badges).toEqual(["local-folder"]);
      await harness.service.addSource({ previewId: preview.previewId, id: "notes" });
      await expect(harness.service.revealFolder("notes")).resolves.toBe("Z:\\m");

      drives["Z:"] = "\\Device\\Mup\\;LanmanRedirector\\;Z:000000000001a2b3\\files.corp\\share";
      volume.calls.length = 0;
      const error = await refused(harness.service.revealFolder("notes"));
      expect(error).toMatchObject({ code: "SOURCE_CONFIRMATION_REQUIRED", detail: { reason: "network-folder", server: "files.corp" } });
      expect(volume.calls).toEqual([{ op: "queryDosDevice", path: "Z:" }]);
    } finally {
      harness.service.close();
    }
  });
});

describe("a folder source an earlier build stored under a credential-shaped id (§18.8)", () => {
  // Assembled here so no whole token sits in the source.
  const TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;

  async function storeUnderToken(harness: Awaited<ReturnType<typeof windowsService>>, volume: FakeVolume) {
    harness.service.close();
    const marketplaces = join(root, "marketplaces");
    const list = join(marketplaces, "sources.json");
    writeFileSync(list, readFileSync(list, "utf8").replaceAll('"notes"', JSON.stringify(TOKEN)));
    const moved = join(marketplaces, TOKEN);
    renameSync(join(marketplaces, "notes"), moved);
    for (const file of readdirSync(join(moved, "snapshots"))) {
      const path = join(moved, "snapshots", file);
      writeFileSync(path, readFileSync(path, "utf8").replace('"sourceId":"notes"', `"sourceId":${JSON.stringify(TOKEN)}`));
    }
    return windowsService(volume);
  }

  it("lists its row by handle with no badge, asking nothing of its folder, and refuses to show the folder", async () => {
    const { volume } = windowsVolume();
    const harness = await storeUnderToken(await addLocalDrive(volume), volume);
    try {
      volume.calls.length = 0;
      const row = (await harness.service.listSources()).find((item) => item.status.state === "id-holds-credential")!;
      expect(row).toMatchObject({ transport: "folder", badges: [] });
      expect(row.id).toMatch(/^ave-legacy-[0-9a-f]{32}$/u);
      expect(volume.calls).toEqual([]);
      for (const id of [row.id, TOKEN]) {
        expect(await refused(harness.service.revealFolder(id)), id).toMatchObject({ code: "SOURCE_ID_INVALID", detail: { reason: "stored-id-holds-credential" } });
      }
      expect(volume.calls).toEqual([]);
    } finally {
      harness.service.close();
    }
  });

  it("names it by its row's handle when the same folder is added again, so Show <id> opens that row", async () => {
    const { volume } = windowsVolume();
    const harness = await storeUnderToken(await addLocalDrive(volume), volume);
    try {
      const handle = (await harness.service.listSources()).find((item) => item.status.state === "id-holds-credential")!.id;
      const preview = await harness.service.previewSource({ input: "Z:\\m", auth: "none" });
      if (preview.type === "confirm") throw new Error("a local drive needs no confirmation");
      const error = await refused(harness.service.addSource({ previewId: preview.previewId, id: "again" }));
      expect(error).toMatchObject({ code: "SOURCE_ID_TAKEN", detail: { reason: "folder-already-added", existingId: handle } });
      expect(error.message).toContain(handle);
      expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toContain(TOKEN);
    } finally {
      harness.service.close();
    }
  });
});

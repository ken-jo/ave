/**
 * Reading a folder source (design §18.4.2, §18.4.3, §18.8): its revision
 * covers every package's files, no git command runs, and a failed background
 * read keeps its reason through the Sources status after a reload.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { translate } from "../../../i18n/translate.js";
import { sourceStatusDetail } from "../../../ui/renderer/tabs/git-marketplace/labels.js";
import { FakeVolume, nodeFolders, TEST_FOLDER_LIMITS, writeFolderFiles } from "../../__tests__/fixtures/folder-fs.js";
import { folderService } from "../../__tests__/fixtures/folder-service.js";

const skill = (name: string) => `${JSON.stringify({ schemaVersion: 2, kind: "skill", name, version: "1.0.0", minAppVersion: "0.12.0", payload: { entry: "SKILL.md" } })}\n`;
const index = (packages: unknown[]) => `${JSON.stringify({ schemaVersion: 2, name: "team", displayName: "Team tools", packages })}\n`;

let root: string;
let folder: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-folder-sync-"));
  folder = join(mkdtempSync(join(tmpdir(), "ave-folder-source-")), "market");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(folder), { recursive: true, force: true });
});


async function addMarket() {
  const harness = await folderService({ root, folders: nodeFolders() });
  const preview = await harness.service.previewSource({ input: folder, auth: "none" });
  if (preview.type !== "marketplace") throw new Error(`expected a marketplace preview, got ${preview.type}`);
  const view = await harness.service.addSource({ previewId: preview.previewId, id: "team" });
  return { harness, view };
}

describe("folder source reads", () => {
  it("pins a local- revision that changes when a package's SKILL.md is edited, and runs no git command", async () => {
    writeFolderFiles(folder, {
      "marketplace.2.json": index([{ kind: "skill", name: "alpha", path: "skills/alpha" }]),
      "skills/alpha/ave-package.json": skill("alpha"),
      "skills/alpha/SKILL.md": "Write alpha.\n",
    });
    const { harness, view } = await addMarket();
    expect(view).toMatchObject({ id: "team", transport: "folder", url: null, status: { state: "up-to-date" }, packageCount: 1 });
    const first = view.pinnedCommit!;
    expect(first).toMatch(/^local-[0-9a-f]{64}$/u);

    // Unchanged: the same revision, the same snapshot.
    await expect(harness.syncer.sync("team")).resolves.toEqual({ status: "ok", pinnedCommit: first, changed: false });

    // The index and the descriptor do not change; only the package's own file does.
    writeFolderFiles(folder, { "skills/alpha/SKILL.md": "Write alpha, better.\n" });
    const edited = await harness.syncer.sync("team");
    expect(edited).toMatchObject({ status: "ok", changed: true });
    expect(edited.pinnedCommit).not.toBe(first);
    const snapshot = (await harness.syncer.readSnapshot("team"))!;
    expect(snapshot.commit).toBe(edited.pinnedCommit);
    expect(snapshot.packages[0]!.versions[0]!.commit).toBe(edited.pinnedCommit);
    expect(snapshot.packages[0]!.treeSha256).toMatch(/^[0-9a-f]{64}$/u);
    // The snapshot is named by its revision, and the previous one is kept as the previous pin.
    expect(readdirSync(join(root, "marketplaces", "team", "snapshots")).sort()).toEqual([`${first}.json`, `${edited.pinnedCommit}.json`].sort());

    expect(harness.gitCalls).toEqual([]);
    expect(harness.fetches).toEqual([]);
    harness.service.close();
  });

  it("serves only the version in the folder, and keeps other listed versions out of the plan", async () => {
    writeFolderFiles(folder, {
      "marketplace.2.json": index([{
        kind: "skill",
        name: "alpha",
        path: "skills/alpha",
        latest: "1.0.0",
        versions: [
          { version: "1.0.0", commit: "a".repeat(40), minAppVersion: "0.12.0", publishedAt: "2026-09-01T00:00:00.000Z" },
          { version: "0.9.0", commit: "b".repeat(40), minAppVersion: "0.12.0", publishedAt: "2026-08-01T00:00:00.000Z" },
        ],
      }]),
      "skills/alpha/ave-package.json": skill("alpha"),
      "skills/alpha/SKILL.md": "Write alpha.\n",
    });
    const { harness } = await addMarket();
    const snapshot = (await harness.syncer.readSnapshot("team"))!;
    expect(snapshot.packages[0]!.versions.map((version) => version.version)).toEqual(["1.0.0"]);
    expect(snapshot.packages[0]!.versions[0]!.commit).toBe(snapshot.commit);
    harness.service.close();
  });

  it("persists a background read's permission failure with its reason, and renders it after a reload", async () => {
    const volume = new FakeVolume("linux")
      .file("/srv/team/marketplace.2.json", index([{ kind: "skill", name: "alpha", path: "skills/alpha" }]))
      .file("/srv/team/skills/alpha/ave-package.json", skill("alpha"))
      .file("/srv/team/skills/alpha/SKILL.md", "Write alpha.\n");
    const folders = { fs: volume, platform: "linux" as const, limits: TEST_FOLDER_LIMITS };
    const first = await folderService({ root, folders });
    const preview = await first.service.previewSource({ input: "/srv/team", auth: "none" });
    if (preview.type === "confirm") throw new Error("a local folder needs no confirmation");
    await first.service.addSource({ previewId: preview.previewId, id: "team" });
    const pinned = (await first.registry.readState("team")).pinnedCommit;

    volume.fail("/srv/team", "EACCES");
    const failed = await first.syncer.sync("team");
    expect(failed).toMatchObject({ status: "failed", code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "permission", path: "/srv/team" }, pinnedCommit: pinned });
    first.service.close();

    // A new service over the same files: the reason comes back from the state file.
    const reloaded = await folderService({ root, folders });
    const [, row] = await reloaded.service.listSources();
    expect(row).toMatchObject({
      id: "team",
      pinnedCommit: pinned,
      status: { state: "unreachable", code: "SOURCE_LOCAL_UNREADABLE", cached: true, detail: { reason: "permission", path: "/srv/team" } },
    });
    const sentence = sourceStatusDetail((key, vars) => translate("en", key, vars), row!);
    expect(sentence).toBe(translate("en", "gitMarketplace.error.localUnreadable.permission", { path: "/srv/team", message: "EACCES: /srv/team" }));
    // The last good snapshot is still served.
    await expect(reloaded.syncer.readSnapshot("team")).resolves.toMatchObject({ commit: pinned });
    reloaded.service.close();
    expect(reloaded.gitCalls).toEqual([]);
  });

  it("keeps a sync's broken-classifier failure as classifier-unavailable, read nothing, and renders reinstall advice after a reload", async () => {
    const volume = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3" } })
      .file("C:\\team\\marketplace.2.json", index([{ kind: "skill", name: "alpha", path: "skills/alpha" }]))
      .file("C:\\team\\skills\\alpha\\ave-package.json", skill("alpha"))
      .file("C:\\team\\skills\\alpha\\SKILL.md", "Write alpha.\n");
    const folders = { fs: volume, platform: "win32" as const, limits: TEST_FOLDER_LIMITS };
    const first = await folderService({ root, folders, home: "C:\\Users\\example" });
    const preview = await first.service.previewSource({ input: "C:\\team", auth: "none" });
    if (preview.type === "confirm") throw new Error("a local drive needs no confirmation");
    await first.service.addSource({ previewId: preview.previewId, id: "team" });

    volume.queryDosDevice = async () => {
      throw new Error("the Windows folder classifier failed for C:: spawn EACCES. Reinstall Ave.");
    };
    const before = volume.calls.length;
    const failed = await first.syncer.sync("team");
    expect(failed).toMatchObject({ status: "failed", code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "classifier-unavailable", path: "C:\\team" } });
    expect(volume.calls.slice(before)).toEqual([]);
    first.service.close();

    const reloaded = await folderService({ root, folders, home: "C:\\Users\\example" });
    const [, row] = await reloaded.service.listSources();
    expect(row).toMatchObject({ status: { state: "unreachable", code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "classifier-unavailable", path: "C:\\team" } } });
    expect(sourceStatusDetail((key, vars) => translate("ko", key, vars), row!)).toBe(
      "Ave의 폴더 분류 도구가 없거나 손상되어 C:\\team이(가) 다른 컴퓨터에 있는지 알 수 없습니다. Ave를 다시 설치하세요.",
    );
    reloaded.service.close();
  });

  it("refuses to read a stored folder whose path now leads elsewhere, as moved, without reading the new target", async () => {
    const volume = new FakeVolume("linux").file("/srv/team/SKILL.md", "---\nname: note\ndescription: Note\n---\nBody.\n").file("/srv/other/SKILL.md", "---\nname: other\ndescription: Other\n---\nOTHER.\n");
    const folders = { fs: volume, platform: "linux" as const, limits: TEST_FOLDER_LIMITS };
    const harness = await folderService({ root, folders });
    const preview = await harness.service.previewSource({ input: "/srv/team", auth: "none" });
    if (preview.type === "confirm") throw new Error("a local folder needs no confirmation");
    await harness.service.addSource({ previewId: preview.previewId, id: "note" });
    volume.remove("/srv/team").link("/srv/team", "other");
    volume.calls.length = 0;
    const moved = await harness.syncer.sync("note");
    expect(moved).toMatchObject({ status: "failed", code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "moved", path: "/srv/team", target: "/srv/other" } });
    expect(volume.paths("open")).toEqual([]);

    // Another directory at the same path (a different identity) is moved too.
    volume.remove("/srv/team").file("/srv/team/SKILL.md", "---\nname: note\ndescription: Note\n---\nREPLACED.\n");
    volume.calls.length = 0;
    await expect(harness.syncer.sync("note")).resolves.toMatchObject({ status: "failed", detail: { reason: "moved", path: "/srv/team", target: "/srv/team" } });
    expect(volume.paths("open")).toEqual([]);
    harness.service.close();
  });
});

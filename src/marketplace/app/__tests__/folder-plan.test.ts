/** Folder installs consume the reviewed capture even if source files change afterward. */
import AdmZip from "adm-zip";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFolders, writeFolderFiles } from "../../__tests__/fixtures/folder-fs.js";
import { folderService, type FolderServiceHarness } from "../../__tests__/fixtures/folder-service.js";
import { sha256Hex as sha } from "../../__tests__/fixtures/package-files.js";

const ENTRY_JS = "export default { planned: true };\n";
const auth = { capabilities: ["notes:read"], networkAccess: { allowedDomains: ["api.example.com"] }, requires: { minAppVersion: "0.14.0", hostProtocol: "4" } };
const pluginJson = (extension: Record<string, unknown> = { entry: "dist/index.js" }) =>
  `${JSON.stringify({ name: "alpha", version: "1.0.0", description: "alpha", extensions: { "ai.agent-connector.ave": { displayName: "alpha", ...extension, ...auth } } }, null, 2)}\n`;
const pluginDescriptor = (artifact: Record<string, unknown>) =>
  `${JSON.stringify({ schemaVersion: 2, kind: "plugin", name: "alpha", version: "1.0.0", minAppVersion: "0.14.0", hostProtocol: "4", payload: { authority: auth, artifact } })}\n`;
const skillDescriptor = `${JSON.stringify({ schemaVersion: 2, kind: "skill", name: "notes", version: "1.0.0", minAppVersion: "0.12.0", payload: { entry: "SKILL.md" } })}\n`;
const index = `${JSON.stringify({
  schemaVersion: 2,
  name: "team",
  displayName: "Team tools",
  packages: [{ kind: "plugin", name: "alpha", path: "plugins/alpha" }, { kind: "skill", name: "notes", path: "skills/notes" }],
})}\n`;
const SKILL = "---\nname: notes\ndescription: Notes\n---\nPlanned body.\n";
const RELEASE = { release: { repo: "acme/alpha", sha256: sha("never fetched") } };

let root: string;
let folder: string;
let harness: FolderServiceHarness;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ave-folder-plan-"));
  folder = join(mkdtempSync(join(tmpdir(), "ave-folder-plan-src-")), "market");
  writeFolderFiles(folder, {
    "marketplace.json": index,
    "plugins/alpha/ave-package.json": pluginDescriptor(RELEASE),
    "plugins/alpha/plugin.json": pluginJson(),
    "plugins/alpha/dist/index.js": ENTRY_JS,
    "plugins/alpha/src/index.ts": "export default {};\n",
    "plugins/alpha/package.json": "{}\n",
    "skills/notes/ave-package.json": skillDescriptor,
    "skills/notes/SKILL.md": SKILL,
  });
  harness = await folderService({ root, folders: nodeFolders() });
  const preview = await harness.service.previewSource({ input: folder, auth: "none" });
  if (preview.type !== "marketplace") throw new Error(`expected a marketplace preview, got ${preview.type}`);
  await harness.service.addSource({ previewId: preview.previewId, id: "team" });
});
afterEach(() => {
  harness.service.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dirname(folder), { recursive: true, force: true });
});


const zipText = (zip: Buffer) => Object.fromEntries(new AdmZip(zip).getEntries().map((entry) => [entry.entryName, entry.getData().toString("utf8")]));
const captures = () => readdirSync(harness.workRoot).filter((name) => name.startsWith("folder-plan-"));

describe("folder plans install what was captured", () => {
  it("installs the plugin's planned bytes after dist/index.js was edited, and lists the unbuilt entries", async () => {
    const plan = await harness.service.planInstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    expect(plan.notInstalled).toEqual(["package.json", "src/"]);
    expect(plan.rungs.map((rung) => rung.rung)).toEqual(["folder"]);
    expect(plan.snapshotCommit).toMatch(/^local-[0-9a-f]{64}$/u);
    expect(captures()).toHaveLength(1);

    writeFolderFiles(folder, { "plugins/alpha/dist/index.js": "export default { edited: true };\n" });
    const result = await harness.service.executeInstall(plan.planId);
    expect(result).toMatchObject({ version: "1.0.0", action: { action: "install" }, rungs: [{ rung: "folder", outcome: "used" }] });
    const [staged] = harness.plugins;
    expect(staged).toMatchObject({ rung: "folder", notInstalled: ["package.json", "src/"] });
    expect(zipText(staged!.zipBuffer)).toEqual({ "dist/index.js": ENTRY_JS, "plugin.json": pluginJson() });
    expect(harness.fetches).toEqual([]);
    expect(harness.gitCalls).toEqual([]);
    expect(captures()).toEqual([]);
  });

  it("installs the skill's planned SKILL.md after the file was edited", async () => {
    const plan = await harness.service.planInstall({ sourceId: "team", kind: "skill", name: "notes" });
    writeFolderFiles(folder, { "skills/notes/SKILL.md": SKILL.replace("Planned body.", "Edited body.") });
    await harness.service.executeInstall(plan.planId);
    const [staged] = harness.content;
    expect(Object.fromEntries(staged!.files.map((file) => [file.path, file.data.toString("utf8")]))).toMatchObject({ "SKILL.md": SKILL });
    expect(captures()).toEqual([]);
  });

  it("re-reads the folder for the plan: an edit made before planning is what the plan installs", async () => {
    writeFolderFiles(folder, { "plugins/alpha/dist/index.js": "export default { before: true };\n" });
    const plan = await harness.service.planInstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    await harness.service.executeInstall(plan.planId);
    expect(zipText(harness.plugins[0]!.zipBuffer)["dist/index.js"]).toBe("export default { before: true };\n");
  });

  it("keeps the executable bit of a built file where the system has one (not on Windows)", async () => {
    writeFolderFiles(folder, { "plugins/alpha/dist/run.sh": "#!/bin/sh\n" });
    chmodSync(join(folder, "plugins/alpha/dist/run.sh"), 0o755);
    const plan = await harness.service.planInstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    await harness.service.executeInstall(plan.planId);
    const entry = new AdmZip(harness.plugins[0]!.zipBuffer).getEntry("dist/run.sh")!;
    expect((entry.attr >>> 16) & 0o111).toBe(process.platform === "win32" ? 0 : 0o111);
  });
});

describe("the folder rung refuses", () => {
  it("a process entry: it requires a pinned artifact", async () => {
    // Folder admission rejects process entries before manifest validation.
    writeFolderFiles(folder, { "plugins/alpha/plugin.json": pluginJson({ process: { command: "./dist/plugin" }, tools: [] }) });
    const plan = await harness.service.planInstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    await expect(harness.service.executeInstall(plan.planId)).rejects.toMatchObject({ code: "process-entry-requires-pinned-artifact" });
    expect(harness.plugins).toEqual([]);
    expect(harness.fetches).toEqual([]);
    expect(captures()).toEqual([]);
  });

  it("a folder with no plugin.json, as folder-has-no-build", async () => {
    rmSync(join(folder, "plugins/alpha/plugin.json"));
    const plan = await harness.service.planInstall({ sourceId: "team", kind: "plugin", name: "alpha" });
    await expect(harness.service.executeInstall(plan.planId)).rejects.toMatchObject({
      code: "NO_INSTALLABLE_ARTIFACT",
      detail: { reason: "folder-has-no-build", name: "alpha" },
      rungs: [{ rung: "folder", outcome: "failed", code: "NO_INSTALLABLE_ARTIFACT" }],
    });
    expect(harness.fetches).toEqual([]);
  });
});

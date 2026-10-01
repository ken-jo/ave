/**
 * A folder that is one package, added directly (design §18.4.7): its version
 * is synthesized from its files, and `allowDirectInstall: false` refuses it at
 * the preview, the add and the plan — for a git URL alike.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeVolume, TEST_FOLDER_LIMITS } from "../../__tests__/fixtures/folder-fs.js";
import { folderService } from "../../__tests__/fixtures/folder-service.js";
import { FIXTURE_POLICY_PATH, policyLoad, policySource } from "../../__tests__/fixtures/policy.js";

const SKILL = (body: string) => `---\nname: note\ndescription: A note skill\n---\n${body}\n`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-folder-direct-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function volume(body = "Write notes.") {
  return new FakeVolume("linux").file("/opt/note/SKILL.md", SKILL(body));
}

describe("a direct folder package", () => {
  it("is previewed and added with a version synthesized from its files, and installs from the folder", async () => {
    const fs = volume();
    const harness = await folderService({ root, folders: { fs, platform: "linux", limits: TEST_FOLDER_LIMITS } });
    const preview = await harness.service.previewSource({ input: "/opt/note", auth: "none" });
    expect(preview).toMatchObject({ type: "package", transport: "folder", path: "/opt/note", url: null, kind: "skill", name: "note" });
    if (preview.type !== "package") throw new Error("expected a package preview");
    expect(preview.version).toMatch(/^0\.0\.0\+t[0-9a-f]{12}$/u);
    const view = await harness.service.addSource({ previewId: preview.previewId, id: "note" });
    expect(view).toMatchObject({ id: "note", origin: "direct", transport: "folder", path: "/opt/note" });
    const plan = await harness.service.planInstall({ sourceId: "note", kind: "skill", name: "note" });
    expect(plan.version).toBe(preview.version);
    await harness.service.executeInstall(plan.planId);
    expect(harness.content.map((staged) => staged.plan.version)).toEqual([preview.version]);
    expect(harness.gitCalls).toEqual([]);
    harness.service.close();
  });

  it("gets another version when its files change", async () => {
    const first = await folderService({ root, folders: { fs: volume("one"), platform: "linux", limits: TEST_FOLDER_LIMITS } });
    const a = await first.service.previewSource({ input: "/opt/note", auth: "none" });
    first.service.close();
    const second = await folderService({ root, folders: { fs: volume("two"), platform: "linux", limits: TEST_FOLDER_LIMITS } });
    const b = await second.service.previewSource({ input: "/opt/note", auth: "none" });
    second.service.close();
    expect(a).toMatchObject({ type: "package" });
    expect(b).toMatchObject({ type: "package" });
    expect((a as { version: string }).version).not.toBe((b as { version: string }).version);
  });
});

describe("allowDirectInstall: false (§12)", () => {
  it("refuses a direct folder at the preview once it is found to be one package, and leaves marketplace folders alone", async () => {
    const fs = volume().file("/opt/market/marketplace.2.json", `${JSON.stringify({ schemaVersion: 2, name: "team", displayName: "Team", packages: [] })}\n`);
    const harness = await folderService({ root, folders: { fs, platform: "linux", limits: TEST_FOLDER_LIMITS }, policy: policySource({ allowDirectInstall: false }) });
    await expect(harness.service.previewSource({ input: "/opt/note", auth: "none" })).rejects.toMatchObject({
      code: "SOURCE_POLICY_BLOCKED",
      detail: { reason: "direct-install-blocked", target: "/opt/note", policyPath: FIXTURE_POLICY_PATH },
    });
    await expect(harness.service.previewSource({ input: "/opt/market", auth: "none" })).resolves.toMatchObject({ type: "marketplace", transport: "folder" });
    harness.service.close();
  });

  it("refuses the add and the plan of a direct folder once the policy turns it off", async () => {
    const policy = policySource();
    const harness = await folderService({ root, folders: { fs: volume(), platform: "linux", limits: TEST_FOLDER_LIMITS }, policy });
    const preview = await harness.service.previewSource({ input: "/opt/note", auth: "none" });
    if (preview.type !== "package") throw new Error("expected a package preview");
    policy.change(policyLoad({ allowDirectInstall: false }));
    await expect(harness.service.addSource({ previewId: preview.previewId, id: "note" })).rejects.toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "direct-install-blocked" } });

    // Added while it was allowed, then turned off: the plan refuses.
    policy.change(policyLoad());
    const again = await harness.service.previewSource({ input: "/opt/note", auth: "none" });
    if (again.type !== "package") throw new Error("expected a package preview");
    await harness.service.addSource({ previewId: again.previewId, id: "note" });
    policy.change(policyLoad({ allowDirectInstall: false }));
    await expect(harness.service.planInstall({ sourceId: "note", kind: "skill", name: "note" })).rejects.toMatchObject({
      code: "SOURCE_POLICY_BLOCKED",
      detail: { reason: "direct-install-blocked", target: "/opt/note" },
    });
    expect(harness.content).toEqual([]);
    harness.service.close();
  });
});

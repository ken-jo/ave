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
    const fs = volume().file("/opt/market/marketplace.json", `${JSON.stringify({ schemaVersion: 2, name: "team", displayName: "Team", packages: [] })}\n`);
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

describe("a direct agent plugin under the renamed extension key", () => {
  it("is refused at the preview naming both keys, for the manifest key and for the package folder", async () => {
    const top = { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "legacy", version: "1.0.0", description: "A legacy bundle" };
    const fs = new FakeVolume("linux")
      .file("/opt/legacy/plugin.json", JSON.stringify({ ...top, extensions: { "ai.agent-connector.ave": { displayName: "Legacy" } } }))
      .file("/opt/moved/plugin.json", JSON.stringify(top))
      .file("/opt/moved/ai.agent-connector.ave/routines.json", JSON.stringify({ version: 1, templates: [] }));
    const harness = await folderService({ root, folders: { fs, platform: "linux", limits: TEST_FOLDER_LIMITS } });
    try {
      const key = harness.service.previewSource({ input: "/opt/legacy", auth: "none" });
      await expect(key).rejects.toMatchObject({ code: "SOURCE_INDEX_INVALID" });
      await expect(key).rejects.toThrow("extensions.ai.agent-connector.ave was renamed to extensions.ai.agent-connector.ave; update the manifest");
      const folder = harness.service.previewSource({ input: "/opt/moved", auth: "none" });
      await expect(folder).rejects.toMatchObject({ code: "SOURCE_INDEX_INVALID" });
      await expect(folder).rejects.toThrow("ai.agent-connector.ave/ was renamed to ai.agent-connector.ave/; move ai.agent-connector.ave/routines.json there");
    } finally {
      harness.service.close();
    }
  });
});

describe("a read failure inside a direct bundle keeps its own reason (§18.4.5, §18.8)", () => {
  const INNER = "---\nname: inner\ndescription: inner skill\n---\nBody\n";
  /** A direct agent-plugin bundle at C:\m whose skills link to `link`, with the classifier answering `Z:` as given. */
  function bundle(link: string | null, z: "broken" | "network") {
    const fs = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3", "Z:": "\\Device\\Mup\;LanmanRedirector\\files\\share" } })
      .file("C:\\m\\plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "bundle", version: "1.0.0", description: "A bundle" }))
      .file("C:\\m\\skills\\inner\\SKILL.md", INNER);
    if (link) fs.link("C:\\m\\skills\\other", link);
    const query = fs.queryDosDevice.bind(fs);
    fs.queryDosDevice = async (drive) => {
      if (drive === "Z:" && z === "broken") throw new Error("helper launch failed after an earlier successful classification");
      return query(drive);
    };
    return fs;
  }
  const harnessOf = (fs: FakeVolume) => folderService({ root, folders: { fs, platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });

  it("previews a bundle whose link needs a broken classifier as classifier-unavailable, not as an invalid index", async () => {
    const harness = await harnessOf(bundle("Z:\\other", "broken"));
    try {
      await expect(harness.service.previewSource({ input: "C:\\m", auth: "none" })).rejects.toMatchObject({
        code: "SOURCE_LOCAL_UNREADABLE",
        detail: { reason: "classifier-unavailable", path: "Z:\\other" },
      });
    } finally {
      harness.service.close();
    }
  });

  it("previews a bundle linking to a share as link-to-network with its detail", async () => {
    const harness = await harnessOf(bundle("Z:\\other", "network"));
    try {
      await expect(harness.service.previewSource({ input: "C:\\m", auth: "none" })).rejects.toMatchObject({
        code: "CONTENT_RULE_VIOLATION",
        detail: { reason: "link-to-network", path: "skills/other", target: "Z:\\other" },
      });
    } finally {
      harness.service.close();
    }
  });

  it("keeps classifier-unavailable as a sync's stored result when the bundle gains such a link", async () => {
    const fs = bundle(null, "broken");
    const harness = await harnessOf(fs);
    try {
      const preview = await harness.service.previewSource({ input: "C:\\m", auth: "none" });
      if (preview.type === "confirm") throw new Error("a local drive needs no confirmation");
      await harness.service.addSource({ previewId: preview.previewId, id: "bundle" });
      fs.link("C:\\m\\skills\\other", "Z:\\other");
      const result = await harness.syncer.sync("bundle");
      expect(result).toMatchObject({ status: "failed", code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "classifier-unavailable", path: "Z:\\other" } });
      expect((await harness.registry.readState("bundle")).lastSync).toMatchObject({
        result: "SOURCE_LOCAL_UNREADABLE",
        detail: { reason: "classifier-unavailable", path: "Z:\\other" },
      });
    } finally {
      harness.service.close();
    }
  });

  it.each([
    ["a file the package installs", "C:\\team\\skills\\inner\\notes.md", "Z:\\notes.md"],
    ["the package's descriptor", "C:\\team\\skills\\inner\\ave-package.json", "Z:\\ave-package.json"],
  ])("fails a marketplace sync when %s links through a broken classifier, instead of dropping that package", async (_what, at, target) => {
    const index = { schemaVersion: 2, name: "team", displayName: "Team", packages: [{ kind: "skill", name: "inner", path: "skills/inner" }] };
    const descriptor = { schemaVersion: 2, kind: "skill", name: "inner", version: "1.0.0", minAppVersion: "0.12.0", payload: { entry: "SKILL.md" } };
    const fs = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3" } })
      .file("C:\\team\\marketplace.json", JSON.stringify(index))
      .file("C:\\team\\skills\\inner\\ave-package.json", JSON.stringify(descriptor))
      .file("C:\\team\\skills\\inner\\SKILL.md", INNER);
    const harness = await harnessOf(fs);
    try {
      const preview = await harness.service.previewSource({ input: "C:\\team", auth: "none" });
      if (preview.type === "confirm") throw new Error("a local drive needs no confirmation");
      await harness.service.addSource({ previewId: preview.previewId, id: "team" });
      if (at.endsWith("ave-package.json")) fs.remove(at);
      fs.link(at, target);
      fs.queryDosDevice = async (drive) => {
        if (drive === "Z:") throw new Error("helper timed out");
        return "\\Device\\HarddiskVolume3";
      };
      await expect(harness.syncer.sync("team")).resolves.toMatchObject({
        status: "failed",
        code: "SOURCE_LOCAL_UNREADABLE",
        detail: { reason: "classifier-unavailable", path: target },
      });
    } finally {
      harness.service.close();
    }
  });
});

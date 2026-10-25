import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeVolume, TEST_FOLDER_LIMITS } from "../../__tests__/fixtures/folder-fs.js";
import { folderService } from "../../__tests__/fixtures/folder-service.js";
import { policySource } from "../../__tests__/fixtures/policy.js";
import { isMarketplaceError } from "../../errors.js";
import { parseSourcePattern } from "../../net/source-url.js";
import { EMPTY_MARKETPLACE_POLICY, folderPolicyBlock, type MarketplacePolicy } from "../policy.js";
import { folderRelation } from "../registry.js";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nBody.\n`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-folder-identity-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function added(volume: FakeVolume, inputs: string[]) {
  const harness = await folderService({ root, folders: { fs: volume, platform: volume.platform, limits: TEST_FOLDER_LIMITS } });
  const outcomes: Array<{ input: string; id?: string; path?: string | null; error?: string }> = [];
  for (const [index, input] of inputs.entries()) {
    try {
      const preview = await harness.service.previewSource({ input, auth: "none" });
      if (preview.type === "confirm") throw new Error(`${input} asked for a confirmation`);
      const view = await harness.service.addSource({ previewId: preview.previewId, id: `folder-${index + 1}` });
      outcomes.push({ input, id: view.id, path: view.path });
    } catch (error) {
      if (!isMarketplaceError(error)) throw error;
      outcomes.push({ input, error: `${error.code}: ${error.message}` });
    }
  }
  harness.service.close();
  return outcomes;
}

function policy(overrides: Partial<MarketplacePolicy>): MarketplacePolicy {
  return { ...EMPTY_MARKETPLACE_POLICY, ...overrides };
}

describe("a case-sensitive volume on macOS (APFS can be either)", () => {
  const volume = () => new FakeVolume("darwin", { caseSensitive: true })
    .file("/Approved/Tools/SKILL.md", SKILL("upper"))
    .file("/approved/tools/SKILL.md", SKILL("lower"));

  it("keeps /Approved/Tools and /approved/tools as two sources", async () => {
    const outcomes = await added(volume(), ["/Approved/Tools", "/approved/tools"]);
    expect(outcomes).toEqual([
      { input: "/Approved/Tools", id: "folder-1", path: "/Approved/Tools" },
      { input: "/approved/tools", id: "folder-2", path: "/approved/tools" },
    ]);
  });

  it("admits only the spelling an allow pattern names, and blocks every spelling a block pattern names", () => {
    const allow = policy({ allow: [parseSourcePattern("path:/Approved/Tools")] });
    expect(folderPolicyBlock(allow, "/Approved/Tools")).toBeNull();
    expect(folderPolicyBlock(allow, "/approved/tools")).toEqual({ reason: "not-in-allow-list" });
    const block = policy({ block: [parseSourcePattern("path:/tmp/*")] });
    expect(folderPolicyBlock(block, "/TMP/x")).toEqual({ reason: "blocked-by-pattern", pattern: "path:/tmp/*" });
    expect(folderPolicyBlock(block, "/tmp/x")).toEqual({ reason: "blocked-by-pattern", pattern: "path:/tmp/*" });
  });

  it("refuses the allow-listed folder's other spelling when previewed", async () => {
    const harness = await folderService({
      root,
      folders: { fs: volume(), platform: "darwin", limits: TEST_FOLDER_LIMITS },
      policy: policySource({ allow: [parseSourcePattern("path:/Approved/Tools")] }),
    });
    await expect(harness.service.previewSource({ input: "/Approved/Tools", auth: "none" })).resolves.toMatchObject({ type: "package", name: "upper" });
    await expect(harness.service.previewSource({ input: "/approved/tools", auth: "none" })).rejects.toMatchObject({
      code: "SOURCE_POLICY_BLOCKED",
      detail: { reason: "not-in-allow-list", target: "/approved/tools" },
    });
    harness.service.close();
  });
});

describe("a case-insensitive volume", () => {
  it("reads two spellings of one folder as one source: the walk's on-disk spelling is the canonical path", async () => {
    const volume = new FakeVolume("darwin", { caseSensitive: false }).file("/Approved/Tools/SKILL.md", SKILL("tools"));
    const outcomes = await added(volume, ["/Approved/Tools", "/approved/TOOLS"]);
    expect(outcomes[0]).toEqual({ input: "/Approved/Tools", id: "folder-1", path: "/Approved/Tools" });
    expect(outcomes[1]!.error).toMatch(/^SOURCE_ID_TAKEN: this folder is already added as folder-1/u);
  });

  it("reads one directory reached by two paths as one source through equal dev and ino", async () => {
    const volume = new FakeVolume("darwin", { caseSensitive: false }).file("/Approved/Tools/SKILL.md", SKILL("tools")).alias("/Volumes/mirror", "/Approved/Tools");
    const outcomes = await added(volume, ["/Approved/Tools", "/Volumes/mirror"]);
    expect(outcomes[0]).toMatchObject({ id: "folder-1" });
    expect(outcomes[1]!.error).toMatch(/^SOURCE_ID_TAKEN: this folder is already added as folder-1/u);
  });

  it("refuses a folder inside or containing a source: nesting would list packages twice", async () => {
    const volume = new FakeVolume("linux")
      .file("/m/SKILL.md", SKILL("outer"))
      .file("/m/inner/SKILL.md", SKILL("inner"))
      .file("/n/x/SKILL.md", SKILL("nested"))
      .file("/n/SKILL.md", SKILL("parent"));
    const outcomes = await added(volume, ["/m", "/m/inner", "/n/x", "/n"]);
    expect(outcomes.map((item) => item.error?.replace(/:.*/u, "") ?? item.id)).toEqual(["folder-1", "SOURCE_ID_TAKEN", "folder-3", "SOURCE_ID_TAKEN"]);
    expect(outcomes[1]!.error).toContain("lies inside folder-1");
    expect(outcomes[3]!.error).toContain("contains folder-3");
  });
});

describe("nesting through an alias, judged by dev and ino", () => {
  const volume = () => new FakeVolume("darwin")
    .file("/m/SKILL.md", SKILL("outer"))
    .file("/m/child/SKILL.md", SKILL("inner"))
    .alias("/Volumes/alias", "/m");

  it("refuses a folder whose ancestor, reached by another path, is a source", async () => {
    const outcomes = await added(volume(), ["/m", "/Volumes/alias/child"]);
    expect(outcomes[0]).toMatchObject({ id: "folder-1", path: "/m" });
    expect(outcomes[1]!.error).toMatch(/^SOURCE_ID_TAKEN: this folder lies inside folder-1/u);
  });

  it("refuses a folder that is among a source's recorded ancestors, reached by another path", async () => {
    const outcomes = await added(volume(), ["/Volumes/alias/child", "/m"]);
    expect(outcomes[0]).toMatchObject({ id: "folder-1", path: "/Volumes/alias/child" });
    expect(outcomes[1]!.error).toMatch(/^SOURCE_ID_TAKEN: this folder contains folder-1/u);
  });
});

describe("folderRelation", () => {
  it("compares canonical paths component by component, byte for byte", () => {
    expect(folderRelation("/a/b", "/a/b", "linux")).toBe("same");
    expect(folderRelation("/a/b/c", "/a/b", "linux")).toBe("inside");
    expect(folderRelation("/a", "/a/b", "linux")).toBe("contains");
    expect(folderRelation("/a/bc", "/a/b", "linux")).toBeNull();
    expect(folderRelation("/A/b", "/a/b", "linux")).toBeNull();
    expect(folderRelation("C:\\m\\x", "C:\\m", "win32")).toBe("inside");
    expect(folderRelation("\\\\s\\share\\m", "C:\\m", "win32")).toBeNull();
  });
});

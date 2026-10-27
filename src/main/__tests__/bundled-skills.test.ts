import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillStore } from "../skill-store.js";

describe("packaged directory skills", () => {
  it("discovers, loads and reads the shipped editing script without writing to the user home", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "ave-bundled-skills-"));
    try {
      const store = new SkillStore({ userDir, bundledDir: resolve("resources/skills") });
      expect(store.listCatalogSync().some((skill) => skill.name === "xlsx-edit")).toBe(true);
      const skill = await store.load("xlsx-edit");
      expect(skill?.resources.map((resource) => resource.path)).toEqual(["scripts/edit-xlsx.py"]);
      expect((await store.list()).map((item) => item.name)).toEqual(["xlsx-edit"]);
      const resource = await store.readUserResource(skill!, "scripts/edit-xlsx.py");
      expect(resource.bytes).toBeGreaterThan(1000);
      await expect(store.readUserResource(skill!, "../../report-writing.md")).rejects.toThrow();
      mkdirSync(join(userDir, "xlsx-edit"));
      writeFileSync(join(userDir, "xlsx-edit", "SKILL.md"), "---\nname: xlsx-edit\ndescription: User editing workflow\n---\nCustom body");
      expect((await store.load("xlsx-edit"))?.body).toBe("Custom body");
      expect(store.listCatalogSync().find((item) => item.name === "xlsx-edit")?.description).toBe("User editing workflow");
      expect((await store.list()).filter((item) => item.name === "xlsx-edit")).toHaveLength(1);
    } finally {
      rmSync(userDir, { recursive: true, force: true });
    }
  });
});

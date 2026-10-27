import { withTempDirectory } from "./support/temp-directory.js";
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillStore, SKILL_MAX_BODY_BYTES } from "../skill-store.js";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

function pluginGeneration(pluginId: string, generationId: string, body: string): ActivePluginGeneration {
  const fingerprint = (generationId === "g1" ? "a" : "b").repeat(64);
  return {
    pluginId,
    pluginVersion: generationId === "g1" ? "1.0.0" : "2.0.0",
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: pluginId,
      ownerVersion: generationId === "g1" ? "1.0.0" : "2.0.0",
      kind: "skill",
      localId: "checkin",
      path: "skills/checkin",
      fingerprint,
      files: [{
        path: "skills/checkin/SKILL.md",
        content: `---\nname: checkin\ndescription: Checkin guidance\n---\n${body}`,
        sha256: fingerprint,
      }],
    }],
  };
}

describe("SkillStore — C2 traversal & allowlist", () => {
  it("keeps same-local-id plugin Skills distinct without filesystem copies", withTempDirectory("ave-skills-", async (dir) => {
    const store = new SkillStore({ userDir: dir });
    store.publishPluginGeneration(pluginGeneration("plugin-one", "g1", "one"));
    store.publishPluginGeneration(pluginGeneration("plugin-two", "g1", "two"));
    const one = await store.load("plugin:plugin-one:checkin");
    const two = await store.load("plugin:plugin-two:checkin");
    expect(one?.body).toBe("one");
    expect(two?.body).toBe("two");
    expect(one?.filePath).toBe("plugin://plugin-one/checkin/SKILL.md");
    expect(one?.approvalKey).not.toBe(two?.approvalKey);
    expect(store.listCatalogSync().map((entry) => entry.name)).toEqual([
      "plugin:plugin-one:checkin",
      "plugin:plugin-two:checkin",
    ]);
  }));

  it("invalidates a plugin Skill cache identity on generation/content change", withTempDirectory("ave-skills-", async (dir) => {
    const store = new SkillStore({ userDir: dir });
    store.publishPluginGeneration(pluginGeneration("plugin-one", "g1", "old"));
    const old = await store.load("plugin:plugin-one:checkin");
    store.publishPluginGeneration(pluginGeneration("plugin-one", "g2", "new"));
    const current = await store.load("plugin:plugin-one:checkin");
    expect(current?.body).toBe("new");
    expect(current?.approvalKey).not.toBe(old?.approvalKey);
    store.removePluginGeneration("plugin-one", "g1");
    expect(await store.load("plugin:plugin-one:checkin")).toBe(current);
    store.removePluginGeneration("plugin-one", "g2");
    expect(await store.load("plugin:plugin-one:checkin")).toBeNull();
  }));

  it("rejects symlinks pointing outside the skills directory", async () => {
    // Symlink creation on Windows requires admin/dev-mode; skip if it errors.
    const dir = mkdtempSync(join(tmpdir(), "ave-skills-"));
    const outside = mkdtempSync(join(tmpdir(), "ave-evil-"));
    try {
      writeFileSync(
        join(outside, "secret.md"),
        "---\nname: evil\n---\nshould-not-be-loaded",
        "utf-8",
      );
      try {
        symlinkSync(
          join(outside, "secret.md"),
          join(dir, "evil.md"),
          // Type "file" is the right kind on Windows; ignored on POSIX.
          platform() === "win32" ? ("file" as const) : undefined,
        );
      } catch {
        // Symlinks unsupported on this CI runner — pass the test as a no-op rather than fail; the production code path is still exercised by the other allowlist tests below.
        return;
      }
      const store = new SkillStore({ userDir: dir });
      const all = await store.list();
      // Only the BUILTIN_SKILLS should appear; the symlinked entry is dropped.
      expect(all.find((s) => s.name === "evil")).toBeUndefined();
    } finally {
      await cleanupTmpDir(dir);
      await cleanupTmpDir(outside);
    }
  });

  it("rejects filenames that don't match the allowlist", withTempDirectory("ave-skills-", async (dir) => {
    // Filenames with `.` (other than the .md extension), spaces, etc are rejected. We use a name with a leading dot so the allowlist check (^[a-zA-Z0-9_-]+$) misses it.
    writeFileSync(join(dir, ".sneaky.md"), "---\nname: x\n---\nbody", "utf-8");
    writeFileSync(
      join(dir, "good-skill.md"),
      "---\nname: good-skill\n---\nbody",
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });
    const all = await store.list();
    // Built-ins + good-skill = ≥1, but no entry whose name is "x".
    expect(all.find((s) => s.name === "x")).toBeUndefined();
    expect(all.find((s) => s.name === "good-skill")).toBeDefined();
  }));

  it("rejects frontmatter `name:` outside the allowlist", withTempDirectory("ave-skills-", async (dir) => {
    writeFileSync(
      join(dir, "valid-file.md"),
      "---\nname: ../../../etc/passwd\n---\nbody",
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });
    const all = await store.list();
    expect(all.find((s) => s.name.includes(".."))).toBeUndefined();
  }));

  it("rejects frontmatter `name:` that does not match the skill file id", withTempDirectory("ave-skills-", async (dir) => {
    writeFileSync(
      join(dir, "actual-id.md"),
      "---\nname: other-id\n---\nbody",
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });
    const all = await store.list();
    expect(all.find((s) => s.name === "other-id")).toBeUndefined();
    expect(store.listCatalogSync()).toEqual([]);
    expect(await store.load("actual-id")).toBeNull();
  }));

  it("rejects bodies larger than the SKILL_MAX_BODY_BYTES cap", withTempDirectory("ave-skills-", async (dir) => {
    const huge = "x".repeat(SKILL_MAX_BODY_BYTES + 1);
    writeFileSync(
      join(dir, "huge.md"),
      `---\nname: huge\n---\n${huge}`,
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });
    const all = await store.list();
    expect(all.find((s) => s.name === "huge")).toBeUndefined();
  }));

  it("packages built-in staff-perspective skills as files under resources/skills/", async () => {
    // Parse shipped skill files through SkillStore before seeding them into editable user storage.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const repoRoot = resolvePath(here, "../../..");
    const resourcesSkillsDir = resolvePath(repoRoot, "resources", "skills");
    const store = new SkillStore({ userDir: resourcesSkillsDir });
    const all = await store.list();
    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "data-summary",
        "decision-record",
        "email-polish",
        "meeting-minutes",
        "report-writing",
        "xlsx-edit",
      ].sort(),
    );
    for (const skill of all) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(skill.body, "utf-8"),
        `built-in skill '${skill.name}' body exceeds SKILL_MAX_BODY_BYTES`,
      ).toBeLessThanOrEqual(SKILL_MAX_BODY_BYTES);
    }
  });

  it("returns a lightweight catalog without exposing skill bodies", withTempDirectory("ave-skills-", async (dir) => {
    writeFileSync(
      join(dir, "brief.md"),
      "---\nname: brief\ndescription: Short brief\n---\nSECRET BODY",
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });
    const catalog = store.listCatalogSync();
    expect(catalog).toEqual([{
      name: "brief",
      description: "Short brief",
      triggers: [],
    }]);
    expect(JSON.stringify(catalog)).not.toContain("SECRET BODY");
  }));

  it("catalog reads only frontmatter and keeps metadata for oversized bodies", withTempDirectory("ave-skills-", async (dir) => {
    writeFileSync(
      join(dir, "huge.md"),
      `---\nname: huge\ndescription: Huge but discoverable\n---\n${"x".repeat(SKILL_MAX_BODY_BYTES + 1)}`,
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });
    const catalog = store.listCatalogSync();
    expect(catalog).toEqual([{ name: "huge", description: "Huge but discoverable", triggers: [] }]);
    expect(JSON.stringify(catalog)).not.toContain("x".repeat(100));
  }));

  it("loads agent-platform directory skills from <name>/SKILL.md", withTempDirectory("ave-skills-", async (dir) => {
    mkdirSync(join(dir, "git-release"), { recursive: true });
    writeFileSync(
      join(dir, "git-release", "SKILL.md"),
      "---\nname: git-release\ndescription: Create releases\n---\n## Release\nShip it.",
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("git-release");
    expect(skill?.description).toBe("Create releases");
    expect(skill?.body).toContain("Ship it.");
  }));

  it("refuses ambiguous skill_load when both directory and flat-file ids exist", withTempDirectory("ave-skills-", async (dir) => {
    mkdirSync(join(dir, "duplicate"), { recursive: true });
    writeFileSync(
      join(dir, "duplicate", "SKILL.md"),
      "---\nname: duplicate\ndescription: directory\n---\ndirectory body",
      "utf-8",
    );
    writeFileSync(
      join(dir, "duplicate.md"),
      "---\nname: duplicate\ndescription: flat\n---\nflat body",
      "utf-8",
    );
    const store = new SkillStore({ userDir: dir });

    expect(await store.load("duplicate")).toBeNull();
  }));
});

// Paths a bundled-resource read must refuse. Backslash/UNC/drive forms use a doubled backslash on purpose — `"a\b.md"` is the BACKSPACE escape and would
// only exercise the control-character branch, never the backslash rule.
const BAD_RESOURCE_PATHS = [
  "../SKILL.md",
  "../../etc/passwd",
  "/etc/passwd",
  "a\\b.md",
  "\\\\server\\share\\x.md",
  "C:\\Windows\\win.ini",
  "a\nb.md",
  "x.md:stream",
  "a<b.md",
  "a>b.md",
  "",
  "./x.md",
  "a/b/c/d/e.md",
];

describe("SkillStore — bundled resources (stage-3)", () => {
  function makeDirSkill(root: string, name: string, body = "guidance"): string {
    const skillDir = join(root, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}`);
    return skillDir;
  }

  it("lists bundled files as a manifest and reads one on demand", withTempDirectory("ave-skills-", async (dir) => {
    const skillDir = makeDirSkill(dir, "guide");
    mkdirSync(join(skillDir, "references"));
    writeFileSync(join(skillDir, "references", "api.md"), "# API reference");
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("guide");
    expect(skill?.resources.map((r) => r.path)).toEqual(["references/api.md"]);
    const read = await store.readUserResource(skill!, "references/api.md");
    expect(read.content).toBe("# API reference");
    expect(read.bytes).toBeGreaterThan(0);
  }));

  it("never lists SKILL.md itself as a resource and refuses to read it", withTempDirectory("ave-skills-", async (dir) => {
    makeDirSkill(dir, "guide");
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("guide");
    expect(skill?.resources).toEqual([]);
    await expect(store.readUserResource(skill!, "SKILL.md")).rejects.toThrow();
  }));

  it("rejects traversal, absolute, backslash and control-character resource paths", withTempDirectory("ave-skills-", async (dir) => {
    makeDirSkill(dir, "guide");
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("guide");
    for (const bad of BAD_RESOURCE_PATHS) {
      await expect(store.readUserResource(skill!, bad)).rejects.toThrow();
    }
  }));

  it("refuses resources for a FLAT skill so it cannot read its siblings", withTempDirectory("ave-skills-", async (dir) => {
    // A flat skill's parent directory IS the shared skills root; treating it as a bundle root would expose every sibling skill's bytes.
    writeFileSync(join(dir, "flat.md"), "---\nname: flat\ndescription: d\n---\nbody");
    makeDirSkill(dir, "secret", "SECRET BODY");
    const store = new SkillStore({ userDir: dir });
    const flat = await store.load("flat");
    expect(flat?.resources).toEqual([]);
    await expect(store.readUserResource(flat!, "secret/SKILL.md")).rejects.toThrow();
  }));

  it("refuses a flat skill literally named SKILL.md at the skills root", withTempDirectory("ave-skills-", async (dir) => {
    // Regression: gating on `basename(filePath) === "SKILL.md"` alone let a flat `<root>/SKILL.md` skill (name "SKILL") pass, making the SHARED skills root
    // its bundle root — one approval then read every sibling.
    writeFileSync(join(dir, "SKILL.md"), "---\nname: SKILL\ndescription: d\n---\nattacker");
    makeDirSkill(dir, "secret", "SECRET BODY");
    const store = new SkillStore({ userDir: dir });
    const attacker = await store.load("SKILL");
    expect(attacker?.resources).toEqual([]);
    await expect(store.readUserResource(attacker!, "secret/SKILL.md")).rejects.toThrow();
    await expect(store.readUserResource(attacker!, "secret/references/x.md")).rejects.toThrow();
  }));

  it("does not duplicate entries when a bundled directory symlink loops", withTempDirectory("ave-skills-", async (dir) => {
    const skillDir = makeDirSkill(dir, "guide");
    writeFileSync(join(skillDir, "api.md"), "API");
    let looped = false;
    try {
      symlinkSync(skillDir, join(skillDir, "loop"), "dir");
      looped = true;
    } catch {
      // Symlink creation needs privilege on Windows.
    }
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("guide");
    const paths = skill?.resources.map((r) => r.path) ?? [];
    expect(new Set(paths).size).toBe(paths.length);
    if (looped) expect(paths.filter((p) => p === "api.md")).toHaveLength(1);
  }));

  it("refuses a binary resource instead of returning lossy text", withTempDirectory("ave-skills-", async (dir) => {
    const skillDir = makeDirSkill(dir, "guide");
    writeFileSync(join(skillDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("guide");
    await expect(store.readUserResource(skill!, "logo.png")).rejects.toThrow(/not UTF-8 text/);
  }));

  it("keeps a legitimate '..'-prefixed filename readable", withTempDirectory("ave-skills-", async (dir) => {
    const skillDir = makeDirSkill(dir, "guide");
    writeFileSync(join(skillDir, "..notes.md"), "dotted");
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("guide");
    expect(skill?.resources.map((r) => r.path)).toContain("..notes.md");
    expect((await store.readUserResource(skill!, "..notes.md")).content).toBe("dotted");
  }));

  it("skips a bundled filename carrying control characters", withTempDirectory("ave-skills-", async (dir) => {
    const skillDir = makeDirSkill(dir, "guide");
    let planted = false;
    try {
      // A newline in a filename would inject extra lines into the trusted overlay.
      writeFileSync(join(skillDir, "ok\nevil.md"), "x");
      planted = true;
    } catch {
      // Windows refuses such filenames outright — the guard is then moot.
    }
    const store = new SkillStore({ userDir: dir });
    const skill = await store.load("guide");
    if (planted) {
      expect(skill?.resources.some((r) => r.path.includes("\n"))).toBe(false);
    }
    expect(skill).not.toBeNull();
  }));

  it("rejects a bundled symlink whose target escapes the skill directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-skills-"));
    const outside = mkdtempSync(join(tmpdir(), "ave-evil-"));
    try {
      const skillDir = makeDirSkill(dir, "guide");
      writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
      let linked = false;
      try {
        symlinkSync(join(outside, "secret.txt"), join(skillDir, "leak.txt"));
        linked = true;
      } catch {
        // Symlink creation needs privilege on Windows.
      }
      if (linked) {
        const store = new SkillStore({ userDir: dir });
        const skill = await store.load("guide");
        expect(skill?.resources.some((r) => r.path === "leak.txt")).toBe(false);
        await expect(store.readUserResource(skill!, "leak.txt")).rejects.toThrow();
      }
    } finally {
      await cleanupTmpDir(dir);
      await cleanupTmpDir(outside);
    }
  });

  it("serves plugin resources from verified memory and refuses unknown paths", withTempDirectory("ave-skills-", async (dir) => {
    const generation = pluginGeneration("plugin-one", "g1", "body");
    const contribution = generation.contributions[0] as { files: Array<{ path: string; content: string; sha256: string }> };
    contribution.files = [
      ...contribution.files,
      { path: "skills/checkin/references/policy.md", content: "POLICY", sha256: "c".repeat(64) },
    ];
    const store = new SkillStore({ userDir: dir });
    store.publishPluginGeneration(generation);
    const skill = store.loadPluginGeneration(generation, "plugin:plugin-one:checkin");
    expect(skill?.resources.map((r) => r.path)).toEqual(["references/policy.md"]);
    const read = store.readPluginResource(generation, "plugin:plugin-one:checkin", "references/policy.md");
    expect(read?.content).toBe("POLICY");
    expect(
      store.readPluginResource(generation, "plugin:plugin-one:checkin", "references/missing.md"),
    ).toBeNull();
    expect(
      store.readPluginResource(generation, "plugin:plugin-one:checkin", "SKILL.md"),
    ).toBeNull();
    expect(() =>
      store.readPluginResource(generation, "plugin:plugin-one:checkin", "../../escape.md"),
    ).toThrow();
  }));
});

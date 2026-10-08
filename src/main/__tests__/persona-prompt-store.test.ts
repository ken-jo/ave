import { afterEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonaPromptStore,
  parsePersonaPromptFrontmatter,
  renderPersonaPromptFile,
} from "../persona-prompt-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const tempDirs: string[] = [];

function makeStore() {
  const rootDir = mkdtempSync(join(tmpdir(), "persona-prompts-"));
  const userDir = join(rootDir, "prompts");
  mkdirSync(userDir, { recursive: true });
  tempDirs.push(rootDir);
  return { rootDir, userDir, store: new PersonaPromptStore({ userDir }) };
}

describe("PersonaPromptStore", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await cleanupTmpDir(dir);
    }
  });

  it("saves, lists, and deletes prompt markdown files", async () => {
    const { store } = makeStore();

    await store.save({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Review carefully.",
    });

    await expect(store.list()).resolves.toMatchObject([
      {
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Review carefully.",
      },
    ]);
    await expect(store.get("reviewer")).resolves.toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Review carefully.",
    });
    await expect(store.delete("reviewer")).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("uses the prompts feature namespace for the default user directory", async () => {
    const prevAveHome = process.env.AVE_HOME;
    const rootDir = mkdtempSync(join(tmpdir(), "persona-prompts-home-"));
    tempDirs.push(rootDir);
    process.env.AVE_HOME = rootDir;
    try {
      const store = new PersonaPromptStore();
      await store.save({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Review carefully.",
      });

      expect(readFileSync(join(rootDir, "prompts", "reviewer.md"), "utf-8")).toContain(
        "Review carefully.",
      );
    } finally {
      if (prevAveHome === undefined) {
        delete process.env.AVE_HOME;
      } else {
        process.env.AVE_HOME = prevAveHome;
      }
    }
  });

  it("rejects reserved or unsafe ids", async () => {
    const { store } = makeStore();

    await expect(store.save({
      id: "default",
      name: "Default",
      systemPromptAdd: "Override.",
    })).rejects.toThrow("invalid persona prompt id");
    await expect(store.save({
      id: "../escape",
      name: "Escape",
      systemPromptAdd: "Escape.",
    })).rejects.toThrow("invalid persona prompt id");
  });

  it("replaces existing linked prompt path without overwriting the linked target", async () => {
    const { rootDir, userDir, store } = makeStore();
    const externalPath = join(rootDir, "outside.md");
    const promptPath = join(userDir, "reviewer.md");
    writeFileSync(externalPath, "outside original", "utf-8");
    linkSync(externalPath, promptPath);

    await store.save({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Saved prompt body.",
    });

    expect(readFileSync(externalPath, "utf-8")).toBe("outside original");
    expect(readFileSync(promptPath, "utf-8")).toContain("Saved prompt body.");
  });

  it("replaces an existing symlink prompt path without overwriting the symlink target", async () => {
    if (process.platform === "win32") return;
    const { rootDir, userDir, store } = makeStore();
    const externalPath = join(rootDir, "outside.md");
    const promptPath = join(userDir, "reviewer.md");
    writeFileSync(externalPath, "outside original", "utf-8");
    symlinkSync(externalPath, promptPath);

    await store.save({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Saved prompt body.",
    });

    expect(readFileSync(externalPath, "utf-8")).toBe("outside original");
    expect(readFileSync(promptPath, "utf-8")).toContain("Saved prompt body.");
  });

  it("parses and renders frontmatter used by seeded prompts", () => {
    const raw = renderPersonaPromptFile({
      id: "summarizer",
      name: "요약가",
      description: "Summarize",
      systemPromptAdd: "Summarize professionally.",
    });

    expect(parsePersonaPromptFrontmatter(raw)).toEqual({
      fm: { id: "summarizer", name: "요약가", description: "Summarize" },
      body: "Summarize professionally.\n",
    });
  });

  it("ignores invalid markdown prompt entries during list", async () => {
    const { userDir, store } = makeStore();
    writeFileSync(join(userDir, "bad.md"), "---\nid: default\nname: Bad\n---\nBody", "utf-8");

    await expect(store.list()).resolves.toEqual([]);
  });

  it("keeps package personas addressable and read-only without shadowing local ids", async () => {
    const { userDir, store } = makeStore();
    await store.save({ id: "reviewer", name: "My reviewer", systemPromptAdd: "Local body" });
    const installed = (name: string, version: string) => ({
      name, version,
      content: {
        kind: "agent-plugin" as const,
        components: { skills: [], mcpServers: {}, prompts: [
          { name: "reviewer", kind: "persona" as const, digest: "a".repeat(64) },
          { name: "draft", kind: "template" as const, digest: "b".repeat(64) },
        ], agents: [], routineTemplates: [], hooks: [] },
        files: [
          { path: "ai.agent-connector.ave/prompts/reviewer.md", data: Buffer.from("---\nname: reviewer\ndescription: Reviews\nkind: persona\n---\nPackage body") },
          { path: "ai.agent-connector.ave/prompts/draft.md", data: Buffer.from("---\nname: draft\ndescription: Draft text\nkind: template\nargumentHint: Topic\n---\nDraft {args}") },
        ],
      },
    });
    store.setInstalledAgentPlugins([installed("first", "1.0.0"), installed("second", "2.0.0")]);
    expect((await store.get("reviewer"))?.systemPromptAdd).toBe("Local body");
    expect((await store.get("agent-plugin:first:reviewer"))?.origin).toEqual({ kind: "agent-plugin", package: "first", version: "1.0.0" });
    expect((await store.get("agent-plugin:second:reviewer"))?.name).toBe("reviewer (second)");
    expect((await store.list()).map((prompt) => prompt.id)).toHaveLength(3);
    expect(store.listTemplates()).toMatchObject([
      { id: "agent-plugin:first:draft", argumentHint: "Topic", body: "Draft {args}" },
      { id: "agent-plugin:second:draft", argumentHint: "Topic", body: "Draft {args}" },
    ]);
    await expect(store.save({ id: "agent-plugin:first:reviewer", name: "x", systemPromptAdd: "x" })).rejects.toThrow("invalid persona prompt id");
    await expect(store.delete("agent-plugin:first:reviewer")).rejects.toThrow("invalid persona prompt id");
    rmSync(userDir, { recursive: true });
    expect((await store.list()).map((prompt) => prompt.id)).toEqual([
      "agent-plugin:first:reviewer", "agent-plugin:second:reviewer",
    ]);
    store.setInstalledAgentPlugins([]);
    expect(await store.get("agent-plugin:first:reviewer")).toBeNull();
    expect(store.listTemplates()).toEqual([]);
  });
});

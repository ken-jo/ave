import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  CUSTOM_COMMAND_MAX_BYTES,
  expandCustomCommand,
  listCustomCommands,
  loadCustomCommand,
} from "../custom-commands.js";

const originalHome = process.env.AVE_HOME;
let root: string;
let project: string;
let userDir: string;
let projectDir: string;

async function command(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ave-custom-commands-"));
  process.env.AVE_HOME = join(root, "home");
  project = join(root, "project");
  userDir = join(root, "home", "commands");
  projectDir = join(project, ".ave", "commands");
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = originalHome;
  await cleanupTmpDir(root);
});

describe("custom command files", () => {
  it("lists personal and project commands with their frontmatter", async () => {
    await command(userDir, "standup", "---\ndescription: \"Daily notes\"\n---\nSummarize today.");
    await command(projectDir, "review", "---\ndescription: Review a PR\nargument-hint: <pr>\n---\nReview $ARGUMENTS.");
    expect(await listCustomCommands(project)).toEqual([
      { name: "review", scope: "project", description: "Review a PR", argumentHint: "<pr>" },
      { name: "standup", scope: "user", description: "Daily notes" },
    ]);
  });

  it("lets the project file win a name clash", async () => {
    await command(userDir, "review", "personal body");
    await command(projectDir, "review", "project body");
    expect(await loadCustomCommand("review", project)).toMatchObject({ scope: "project", body: "project body" });
    expect((await listCustomCommands(project)).map((entry) => entry.scope)).toEqual(["project"]);
  });

  it("reads only personal commands when the session has no project", async () => {
    await command(userDir, "standup", "Summarize today.");
    expect(await loadCustomCommand("standup", undefined)).toMatchObject({ scope: "user", body: "Summarize today." });
  });

  it("skips names it cannot type, empty bodies, oversized files and links out of the directory", async () => {
    await command(projectDir, "Bad Name", "body");
    await command(projectDir, "empty", "---\ndescription: nothing\n---\n   ");
    await command(projectDir, "huge", "x".repeat(CUSTOM_COMMAND_MAX_BYTES + 1));
    const outside = join(root, "secret.md");
    await writeFile(outside, "outside body");
    await symlink(outside, join(projectDir, "escape.md"));
    expect(await listCustomCommands(project)).toEqual([]);
    for (const name of ["Bad Name", "empty", "huge", "escape", "../secret"]) {
      expect(await loadCustomCommand(name, project)).toBeNull();
    }
  });

  it("answers no command when neither directory exists", async () => {
    expect(await listCustomCommands(project)).toEqual([]);
    expect(await loadCustomCommand("anything", project)).toBeNull();
  });
});

describe("expandCustomCommand", () => {
  it("replaces both placeholder spellings", () => {
    expect(expandCustomCommand("Fix $ARGUMENTS then {args}", "#12")).toBe("Fix #12 then #12");
  });

  it("does not interpret replacement patterns in the arguments", () => {
    expect(expandCustomCommand("Echo $ARGUMENTS", "$& and $1")).toBe("Echo $& and $1");
  });

  it("appends arguments a body has no placeholder for, and leaves the body alone without them", () => {
    expect(expandCustomCommand("Summarize today.", "briefly")).toBe("Summarize today.\n\nARGUMENTS: briefly");
    expect(expandCustomCommand("Summarize today.", "")).toBe("Summarize today.");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalFileEvidence, inferExecutedPaths, readTerminalReviewText } from "../changed-file-evidence.js";
import type { TerminalBlockSummary } from "../../../shared/terminal-blocks.js";

let directory: string;
let evidence: TerminalFileEvidence;
function block(command: string, id = 1, startedAt = Date.now() + 1_000): TerminalBlockSummary {
  return { id, command, cwd: directory, startedAt, endedAt: null, exitCode: null,
    status: "running", source: "osc133", outputChars: 0, truncated: false };
}
async function file(name: string, content = "echo changed\n"): Promise<string> {
  const path = join(directory, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return realpath(path);
}
async function changed(name: string, content?: string): Promise<string> {
  const path = await file(name, content);
  await evidence.recordWrite("session-a", path, null);
  return path;
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ave-file-evidence-")));
  evidence = new TerminalFileEvidence();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("host execution provenance", () => {
  it.each(["./run.sh", "bash ./run.sh", "bash -o errexit ./run.sh", "bash -e ./run.sh", "source ./run.sh", ". ./run.sh"])("identifies a literal executable or sourced path: %s", async (command) => {
    const path = await changed("run.sh");
    const result = await evidence.snapshot(directory, [block(command)]);
    expect(result.warnings[0]?.files).toEqual([path]);
    expect(result.files[0]?.lastUsed?.command).toBe(command);
  });

  it("keeps unrelated and user-created files out of execution evidence", async () => {
    await changed("changed.sh");
    await file("user.sh");
    const result = await evidence.snapshot(directory, [block("./user.sh")]);
    expect(result.warnings).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.lastUsed).toBeNull();
  });

  it("does not call a script argument to a data command an execution", async () => {
    await changed("run.sh");
    const result = await evidence.snapshot(directory, [block("cat ./run.sh")]);
    expect(result.warnings).toEqual([]);
  });

  it("resolves symlink aliases to the physical changed path", async () => {
    const path = await file("physical/run.sh");
    const alias = join(directory, "alias.sh");
    await symlink(path, alias);
    await evidence.recordWrite("session-a", alias, null);
    const result = await evidence.snapshot(directory, [block("bash alias.sh")]);
    expect(result.files.map(item => item.path)).toEqual([path]);
    expect(result.warnings[0]?.files).toEqual([path]);
  });

  it("follows static shell sources from a direct script", async () => {
    const nested = await changed("nested.sh");
    await file("run.sh", "#!/bin/sh\nsource ./nested.sh\n");
    expect((await evidence.snapshot(directory, [block("./run.sh")])).warnings[0]?.files).toEqual([nested]);
  });

  it("matches the selected make target, its prerequisite recipes and the makefile", async () => {
    const makefile = await changed("Makefile", "build: prepare\n\tbash build.sh\nprepare:\n\tbash prepare.sh\nother:\n\tbash other.sh\n");
    const build = await changed("build.sh");
    const prepare = await changed("prepare.sh");
    await changed("other.sh");
    const result = await evidence.snapshot(directory, [block("make build")]);
    expect(result.warnings[0]?.files).toEqual([makefile, prepare, build]);
  });

  it("matches explicit makefiles and the default target", async () => {
    const makefile = await changed("tasks.mk", "build:\n\t./build.sh\n");
    const script = await changed("build.sh");
    expect((await evidence.snapshot(directory, [block("make -f tasks.mk")])).warnings[0]?.files).toEqual([makefile, script]);
  });

  it.each(["npm run build", "npm --silent run build", "pnpm run build", "yarn build", "bun run build"])("matches package scripts and referenced scripts: %s", async (command) => {
    const manifest = await changed("package.json", JSON.stringify({ scripts: { build: "node scripts/build.js" } }));
    const script = await changed("scripts/build.js", "console.log('done');\n");
    expect((await evidence.snapshot(directory, [block(command)])).warnings[0]?.files).toEqual([manifest, script]);
  });

  it("follows nested package scripts and lifecycle scripts without looping", async () => {
    await file("package.json", JSON.stringify({ scripts: { build: "npm run nested", prebuild: "./pre.sh", nested: "./build.sh && npm run build" } }));
    const pre = await changed("pre.sh");
    const script = await changed("build.sh");
    expect((await evidence.snapshot(directory, [block("npm run build")])).warnings[0]?.files).toEqual([pre, script]);
  });

  it("resolves local executable links inside package scripts", async () => {
    const entry = await changed("node_modules/tool/bin/run.js", "console.log('run');\n");
    await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
    await symlink(entry, join(directory, "node_modules/.bin/tool"));
    await file("package.json", JSON.stringify({ scripts: { build: "tool" } }));
    expect((await evidence.snapshot(directory, [block("npm run build")])).warnings[0]?.files).toEqual([entry]);
  });

  it("discloses dynamic shell indirection without pretending to identify the target", async () => {
    await changed("run.sh");
    expect(await inferExecutedPaths("bash \"$SCRIPT\"", directory)).toEqual({ paths: [], unresolved: true });
    expect((await evidence.snapshot(directory, [block("bash \"$SCRIPT\"")])).warnings).toEqual([]);
  });

  it("discloses combined shell command-string flags", async () => {
    await changed("run.sh");
    expect(await inferExecutedPaths('bash -lc "exec ./run.sh"', directory)).toEqual({ paths: [], unresolved: true });
    expect((await evidence.snapshot(directory, [block('bash -lc "exec ./run.sh"')])).warnings).toEqual([]);
  });

  it("discloses dynamic make recipes and does not claim unrelated files", async () => {
    const makefile = await changed("Makefile", "build:\n\tbash $(SCRIPT)\n");
    await changed("run.sh");
    expect(await inferExecutedPaths("make build", directory)).toEqual({ paths: [makefile], unresolved: true });
    expect((await evidence.snapshot(directory, [block("make build")])).warnings).toEqual([{ blockId: 1, command: "make build", files: [makefile] }]);
  });

  it("lists every changed file for as long as the session runs, with the diff following the current content", async () => {
    const path = await changed("run.sh");
    await changed("other.sh");
    expect((await evidence.snapshot(directory, [])).files.map(item => item.path)).toEqual([path, join(directory, "other.sh")]);
    await writeFile(path, "echo changed again\n");
    const again = await evidence.snapshot(directory, []);
    expect(again.files).toHaveLength(2);
    expect(again.files[0]?.diff).toEqual({ before: "", after: "echo changed again\n" });
    expect(Object.keys(again.files[0]!).sort()).toEqual(["diff", "lastUsed", "path", "sessionIds"]);
  });

  it("retains provenance through delete and restore", async () => {
    const path = await changed("run.sh");
    await unlink(path);
    const removed = (await evidence.snapshot(directory, [])).files[0];
    expect(removed?.path).toBe(path);
    expect(removed?.diff).toBeUndefined();
    await writeFile(path, "echo restored\n");
    expect((await evidence.snapshot(directory, [block("./run.sh")])).warnings[0]?.files).toEqual([path]);
  });

  it("retains the historical path and the destination after an attributed rename", async () => {
    const old = await changed("old.sh");
    const destination = join(directory, "renamed.sh");
    await rename(old, destination);
    await evidence.recordWrite("session-a", destination);
    const result = await evidence.snapshot(directory, [block("./renamed.sh")]);
    expect(result.files.map(item => item.path)).toEqual([old, destination]);
    expect(result.warnings[0]?.files).toEqual([destination]);
  });

  it("records each contributing session without duplicate physical paths", async () => {
    const path = await changed("run.sh");
    await evidence.recordWrite("session-b", path);
    expect((await evidence.snapshot(directory, [])).files[0]?.sessionIds).toEqual(["session-a", "session-b"]);
  });

  it("does not retroactively attribute commands preceding an agent write", async () => {
    await changed("run.sh");
    expect((await evidence.snapshot(directory, [block("./run.sh", 1, 1)])).warnings).toEqual([]);
  });

  it("keeps command evidence scoped to terminal incarnations", async () => {
    await file("run.sh");
    const command = block("./run.sh");
    expect((await evidence.snapshot(directory, [command], "first")).warnings).toEqual([]);
    const path = join(directory, "run.sh");
    await evidence.recordWrite("session-a", path);
    expect((await evidence.snapshot(directory, [command], "second")).warnings[0]?.files).toEqual([path]);
    expect((await evidence.snapshot(directory, [command], "first")).warnings).toEqual([]);
  });

  it("returns a bounded real baseline and the current contents", async () => {
    const path = await file("run.sh", "after\n");
    await evidence.recordWrite("session-a", path, "before\n");
    const snapshot = await evidence.snapshot(directory, []);
    expect(snapshot.files[0]?.diff).toEqual({ before: "before\n", after: await readFile(path, "utf8") });
    await writeFile(path, Buffer.from([0, 1]));
    expect((await evidence.snapshot(directory, [])).files[0]?.diff).toBeUndefined();
  });

  it("keeps an unknown baseline explicitly unavailable", async () => {
    const path = await file("run.sh");
    await evidence.recordWrite("session-a", path);
    expect((await evidence.snapshot(directory, [])).files[0]?.diff).toBeUndefined();
  });

  it.each(["pnpm exec tool", "bun x tool", "npm exec -- tool", "npx --no-install tool"])("matches local bin entry points through an execution wrapper: %s", async (command) => {
    const entry = await changed("node_modules/tool/run", "#!/bin/sh\n. ./nested.sh\n");
    const nested = await changed("nested.sh");
    await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
    await symlink(entry, join(directory, "node_modules/.bin/tool"));
    const result = await evidence.snapshot(directory, [block(command)]);
    expect(result.warnings[0]?.files).toEqual([entry, nested]);
  });

  it("matches an inline make target recipe", async () => {
    const makefile = await changed("Makefile", "run: ; node run.js\n");
    const script = await changed("run.js", "console.log('done');\n");
    expect((await evidence.snapshot(directory, [block("make run")])).warnings[0]?.files).toEqual([makefile, script]);
  });

  it("discloses unsupported option shapes", async () => {
    await changed("run.sh");
    expect((await inferExecutedPaths("bash --unknown value ./run.sh", directory)).unresolved).toBe(true);
    expect((await inferExecutedPaths("npm --unknown value run build", directory)).unresolved).toBe(true);
  });

  it("an inaccessible replacement does not suppress other tracked files", async () => {
    const bad = await changed("bad.sh");
    const good = await changed("good.sh");
    await unlink(bad);
    await symlink(bad, bad);
    const result = await evidence.snapshot(directory, [block("./bad.sh && ./good.sh")]);
    expect(result.files.find(item => item.path === bad)?.diff).toBeUndefined();
    expect(result.files.find(item => item.path === good)?.diff).toEqual({ before: "", after: "echo changed\n" });
    expect((await inferExecutedPaths("./bad.sh && ./good.sh", directory)).unresolved).toBe(true);
    expect(result.warnings[0]?.files).toEqual([good]);
  });

  it("warns only on a concrete match: no warning for prompt internals, plain commands or unresolved indirection", async () => {
    await changed("run.sh");
    await file("Makefile", "build:\n\techo user makefile\n");
    const commands = ["clear", "ls", "echo hi", "cd scripts", "$RUN_SCRIPT", "bash \"$SCRIPT\"",
      "precmd_functions=(${precmd_functions:#*starship*}); PROMPT='demo % '", "make build"];
    const result = await evidence.snapshot(directory, commands.map((command, index) => block(command, index + 1)));
    expect(result.warnings).toEqual([]);
    expect(result.files[0]?.lastUsed).toBeNull();
  });

  it("keeps one warning per matching block and none for the commands between them", async () => {
    const makefile = await changed("Makefile", "build:\n\techo build\n");
    const result = await evidence.snapshot(directory, [block("make build", 1), block("clear", 2), block("ls", 3), block("make build", 4)]);
    expect(result.warnings.map(warning => [warning.blockId, warning.files])).toEqual([[1, [makefile]], [4, [makefile]]]);
    expect(result.cwd).toBe(directory);
    expect(result.latestBlockId).toBe(4);
    expect((await evidence.snapshot(directory, [])).latestBlockId).toBeNull();
  });

  it("caps text reads and distinguishes absent files from unavailable text", async () => {
    const oversized = await file("large", "x".repeat(1_048_577));
    expect(await readTerminalReviewText(oversized)).toBeUndefined();
    expect(await readTerminalReviewText(join(directory, "absent"))).toBeNull();
  });
});

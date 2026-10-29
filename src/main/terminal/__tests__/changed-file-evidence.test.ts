import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { link, mkdtemp, mkdir, open as openFile, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalFileEvidence, inferExecutedPaths, readTerminalReviewText, writtenFileIdentity, type WrittenFileIdentity } from "../changed-file-evidence.js";
import type { TerminalBlockSummary } from "../../../shared/terminal-blocks.js";
import { reviewChange as change } from "../../../__tests__/support/terminal-session-fixtures.js";


// Pass-through fs, with a hook that runs before each path call, to replay filesystem races deterministically.
type HookedCall = "lstat" | "open" | "realpath";
const fsHooks = vi.hoisted(() => ({ before: null as null | ((call: HookedCall, path: string) => Promise<void>) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const hooked = (name: HookedCall) => async (path: unknown, ...rest: unknown[]) => {
    if (fsHooks.before && typeof path === "string") await fsHooks.before(name, path);
    return (actual[name] as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  return { ...actual, lstat: hooked("lstat"), open: hooked("open"), realpath: hooked("realpath") };
});

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
/** What a writer's own descriptor reports for the file it just wrote at `path`. */
async function heldIdentity(path: string): Promise<WrittenFileIdentity | undefined> {
  const handle = await openFile(path, "r");
  try { return writtenFileIdentity(await handle.stat({ bigint: true })); } finally { await handle.close(); }
}
/** Writes `content` through a descriptor and reports that descriptor's identity, as an agent file tool does. */
async function writeOwned(path: string, content: string): Promise<WrittenFileIdentity | undefined> {
  const handle = await openFile(path, "w");
  try { await handle.writeFile(content); return writtenFileIdentity(await handle.stat({ bigint: true })); } finally { await handle.close(); }
}
async function changed(name: string, content?: string): Promise<string> {
  const path = await file(name, content);
  await evidence.recordWrite("session-a", path, null, await heldIdentity(path));
  return path;
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ave-file-evidence-")));
  evidence = new TerminalFileEvidence();
});
afterEach(async () => { fsHooks.before = null; await rm(directory, { recursive: true, force: true }); });

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
    // Only files this terminal's commands used are listed.
    expect(result.files).toEqual([]);
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
    await evidence.recordWrite("session-a", alias, null, await heldIdentity(alias));
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

  it("lists only the changed files this terminal's commands used, with the review following the current content", async () => {
    const path = await changed("run.sh");
    await changed("other.sh");
    expect((await evidence.snapshot(directory, [])).files).toEqual([]);
    expect((await evidence.snapshot(directory, [block("./run.sh")])).files.map(item => item.path)).toEqual([path]);
    await writeFile(path, "echo changed again\n");
    const again = await evidence.snapshot(directory, [block("./run.sh", 2)]);
    expect(again.files).toHaveLength(1);
    expect(change(again.files[0])).toEqual({ operation: "create", hunks: [["", "echo changed again\n"]] });
    expect(again.files[0]?.review).toMatchObject({ path, added: 1, removed: 0, countsKnown: true, referenceable: false });
    expect(Object.keys(again.files[0]!).sort()).toEqual(["lastUsed", "path", "review", "sessionIds"]);
  });

  it("retains provenance through delete and restore", async () => {
    const path = await changed("run.sh");
    await unlink(path);
    expect((await evidence.snapshot(directory, [block("./run.sh")])).files).toEqual([]);
    await writeFile(path, "echo restored\n");
    const restored = await evidence.snapshot(directory, [block("./run.sh", 2)]);
    expect(restored.warnings[0]?.files).toEqual([path]);
    // The user's recreated file is not the one the agent wrote.
    expect(restored.files[0]?.review).toBeUndefined();
  });

  it("retains the historical path and the destination after an attributed rename", async () => {
    const old = await changed("old.sh");
    const destination = join(directory, "renamed.sh");
    await rename(old, destination);
    await evidence.recordWrite("session-a", destination, undefined, await heldIdentity(destination));
    const result = await evidence.snapshot(directory, [block("./renamed.sh"), block("./old.sh", 2)]);
    expect(result.files.map(item => item.path)).toEqual([destination]);
    expect(result.warnings.map(warning => warning.files)).toEqual([[destination]]);
    await writeFile(old, "echo user\n");
    expect((await evidence.snapshot(directory, [block("./old.sh", 3)])).files.map(item => item.path)).toEqual([old]);
  });

  it("records each contributing session without duplicate physical paths", async () => {
    const path = await changed("run.sh");
    await evidence.recordWrite("session-b", path, undefined, await heldIdentity(path));
    expect((await evidence.snapshot(directory, [block("./run.sh")])).files[0]?.sessionIds).toEqual(["session-a", "session-b"]);
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
    await evidence.recordWrite("session-a", path, undefined, await heldIdentity(path));
    expect((await evidence.snapshot(directory, [command], "second")).warnings[0]?.files).toEqual([path]);
    expect((await evidence.snapshot(directory, [command], "first")).warnings).toEqual([]);
  });

  it("returns a bounded real baseline and the current contents", async () => {
    const path = await file("run.sh", "after\n");
    await evidence.recordWrite("session-a", path, "before\n", await heldIdentity(path));
    const snapshot = await evidence.snapshot(directory, [block("./run.sh")]);
    expect(change(snapshot.files[0])).toEqual({ operation: "modify", hunks: [["before\n", await readFile(path, "utf8")]] });
    await writeFile(path, Buffer.from([0, 1]));
    expect((await evidence.snapshot(directory, [block("./run.sh", 2)])).files[0]?.review).toBeUndefined();
  });

  it("keeps an unknown baseline explicitly unavailable", async () => {
    const path = await file("run.sh");
    await evidence.recordWrite("session-a", path, undefined, await heldIdentity(path));
    expect((await evidence.snapshot(directory, [block("./run.sh")])).files[0]?.review).toBeUndefined();
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
    expect(result.files.find(item => item.path === bad)).toBeUndefined();
    expect(change(result.files.find(item => item.path === good))).toEqual({ operation: "create", hunks: [["", "echo changed\n"]] });
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
    expect(result.files).toEqual([]);
  });

  it("keeps one warning per matching block and none for the commands between them", async () => {
    const makefile = await changed("Makefile", "build:\n\techo build\n");
    const result = await evidence.snapshot(directory, [block("make build", 1), block("clear", 2), block("ls", 3), block("make build", 4)]);
    expect(result.warnings.map(warning => [warning.blockId, warning.files])).toEqual([[1, [makefile]], [4, [makefile]]]);
    expect(result.cwd).toBe(directory);
    expect(result.latestBlockId).toBe(4);
    expect((await evidence.snapshot(directory, [])).latestBlockId).toBeNull();
  });

  it.each(["npm --version run build", "npm --help run build", "pnpm --version build", "make -n build", "make --dry-run build", "make -q build",
    "make -t build", "make -sn build", "make --version", "bash -n ./run.sh", "sh --version ./run.sh", "node --check ./run.js", "node -v ./run.js",
    "python3 -V ./run.py", "python3 -VV ./run.py", "bash -Z ./run.sh", "bash -s ./run.sh", "node --inspect-brk=0 ./run.js", "python3 -X ./run.py",
    "ruby -v ./run.sh", "perl -M strict ./run.sh",
    // Options outside the proven forms, or with a value the form does not validate, are uncertain.
    "bash -o noexec ./run.sh", "bash -o bogus ./run.sh", "bash -o ./run.sh", "zsh +o errexit ./run.sh", "bash -c ./run.sh",
    "node -r ./run.js --version", "node --require ./run.js ./run.js", "python3 -W bogus ./run.py", "python3 -m run",
    "make FOO=1 build", "make -C ./run.sh", "make -f -n build", "make build -n", "npm --prefix . run build", "npm --if-present run build"])("never calls a command that runs nothing, or an unclassified option, a match: %s", async (command) => {
    await changed("package.json", JSON.stringify({ scripts: { build: "node run.js" } }));
    await changed("Makefile", "build:\n\tnode run.js\n");
    await changed("run.sh");
    await changed("run.js", "console.log('x');\n");
    await changed("run.py", "print('x')\n");
    expect((await evidence.snapshot(directory, [block(command)])).warnings).toEqual([]);
  });

  it.each(["bash -ex ./run.sh", "bash --norc -o errexit ./run.sh", "python3 -u ./run.py", "python3 -W ignore ./run.py", "node --no-warnings ./run.js"])("still matches allowlisted interpreter options that run the operand: %s", async (command) => {
    const run = command.includes("python3") ? await changed("run.py", "print('x')\n") : command.includes("node") ? await changed("run.js", "console.log('x');\n") : await changed("run.sh");
    expect((await evidence.snapshot(directory, [block(command)])).warnings[0]?.files).toEqual([run]);
  });

  it("matches a local bin through plain npx, but not when an npx option may mean no bin runs", async () => {
    const entry = await changed("node_modules/tool/run.js", "console.log('x');\n");
    await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
    await symlink(entry, join(directory, "node_modules/.bin/tool"));
    expect((await evidence.snapshot(directory, [block("npx tool", 1)])).warnings[0]?.files).toEqual([entry]);
    for (const [index, command] of ["npx --version tool", "npx --help tool", "npx -p other tool", "npx --package=other tool", "npx -y tool", "npx --yes tool"].entries()) {
      expect((await evidence.snapshot(directory, [block(command, index + 2)])).warnings).toEqual([]);
    }
  });

  it.each(["make -j4 build", "make -j 4 build", "make -s build", "make --no-print-directory build"])("still matches make options that run recipes: %s", async (command) => {
    const makefile = await changed("Makefile", "build:\n\t./run.sh\n");
    const script = await changed("run.sh");
    expect((await evidence.snapshot(directory, [block(command)])).warnings[0]?.files).toEqual([makefile, script]);
  });

  it("treats a plain command as PATH-resolved, matching a local bin only inside a package script", async () => {
    const entry = await changed("node_modules/tool/bin/run.js", "console.log('run');\n");
    await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
    await symlink(entry, join(directory, "node_modules/.bin/tool"));
    expect(await inferExecutedPaths("tool --flag", directory)).toEqual({ paths: [], unresolved: true });
    expect((await evidence.snapshot(directory, [block("tool --flag")])).warnings).toEqual([]);
    await file("package.json", JSON.stringify({ scripts: { lint: "tool --flag" } }));
    expect((await evidence.snapshot(directory, [block("npm run lint", 2)])).warnings[0]?.files).toEqual([entry]);
  });

  it("never reads through a parent directory swapped for a link after the write was recorded", async () => {
    const recorded = await file("scripts/run.sh", "agent\n");
    await evidence.recordWrite("session-a", recorded, "before\n", await heldIdentity(recorded));
    expect(change((await evidence.snapshot(directory, [block("./scripts/run.sh")])).files[0])).toEqual({ operation: "modify", hunks: [["before\n", "agent\n"]] });
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ave-file-evidence-host-")));
    try {
      await writeFile(join(outside, "run.sh"), "host secret\n");
      await rename(join(directory, "scripts"), join(directory, "scripts.moved"));
      await symlink(outside, join(directory, "scripts"));
      // The command now runs the host file, which is not the recorded one: no match, and nothing of it is shown.
      const swapped = await evidence.snapshot(directory, [block("./scripts/run.sh", 2)]);
      expect(swapped.files).toEqual([]);
      expect(swapped.warnings).toEqual([]);
      expect(JSON.stringify(swapped)).not.toContain("host secret");
      expect(await readTerminalReviewText(recorded)).toBeUndefined();
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("never diffs another file when the parent is swapped between path checks, the open and the inode compares", async () => {
    const recorded = await file("scripts/run.sh", "agent\n");
    await evidence.recordWrite("session-a", recorded, "before\n", await heldIdentity(recorded));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ave-file-evidence-host-")));
    const parent = join(directory, "scripts");
    const moved = join(directory, "scripts.real");
    let swapped = false;
    const swap = async (toLink: boolean): Promise<void> => {
      if (toLink === swapped) return;
      if (toLink) { await rename(parent, moved); await symlink(outside, parent); }
      else { await unlink(parent); await rename(moved, parent); }
      swapped = toLink;
    };
    try {
      await writeFile(join(outside, "run.sh"), "host secret\n");
      // Replays the race: every path check (realpath) sees the original directory, while each lstat and the open
      // see the external link, so string and lstat comparisons alone would all agree on the external file.
      fsHooks.before = async (call, path) => { if (path === recorded) await swap(call !== "realpath"); };
      const raced = await evidence.snapshot(directory, [block("./scripts/run.sh")]);
      expect(raced.files.map(item => item.path)).toEqual([recorded]);
      expect(raced.files[0]?.review).toBeUndefined();
      expect(JSON.stringify(raced)).not.toContain("host secret");
    } finally {
      fsHooks.before = null;
      await swap(false);
      await rm(outside, { recursive: true, force: true });
    }
    expect(change((await evidence.snapshot(directory, [block("./scripts/run.sh", 2)])).files[0])).toEqual({ operation: "modify", hunks: [["before\n", "agent\n"]] });
  });

  it("shows no diff once a save replaces the recorded inode, until the agent writes the path again", async () => {
    const path = await file("run.sh", "agent\n");
    await evidence.recordWrite("session-a", path, "before\n", await heldIdentity(path));
    const replacement = join(directory, "run.sh.tmp");
    await writeFile(replacement, "saved elsewhere\n");
    await rename(replacement, path);
    expect((await evidence.snapshot(directory, [block("./run.sh")])).files[0]?.review).toBeUndefined();
    await writeFile(path, "agent again\n");
    await evidence.recordWrite("session-a", path, undefined, await heldIdentity(path));
    expect(change((await evidence.snapshot(directory, [block("./run.sh", 2)])).files[0])).toEqual({ operation: "modify", hunks: [["before\n", "agent again\n"]] });
  });

  describe("a swap between the agent's write and its recording", () => {
    // The write reports its own descriptor's identity; the swap happens before the ledger records it. Re-opening the
    // path at record time would put the foreign file into the ledger and later diff it.
    let outside: string;
    beforeEach(async () => {
      outside = await realpath(await mkdtemp(join(tmpdir(), "ave-file-evidence-host-")));
      await writeFile(join(outside, "run.sh"), "host secret\n");
    });
    afterEach(async () => { await rm(outside, { recursive: true, force: true }); });
    const expectNoDiff = async (path: string) => {
      const snapshot = await evidence.snapshot(directory, [block(`./${path.slice(directory.length + 1)}`)]);
      expect(snapshot.files.every(item => item.review === undefined)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("host secret");
    };

    it("records no foreign file when the parent is swapped for a link", async () => {
      await mkdir(join(directory, "scripts"));
      const path = join(directory, "scripts", "run.sh");
      const identity = await writeOwned(path, "agent\n");
      await rename(join(directory, "scripts"), join(directory, "scripts.moved"));
      await symlink(outside, join(directory, "scripts"));
      await evidence.recordWrite("session-a", path, "before\n", identity);
      await expectNoDiff(path);
    });

    it("records no foreign file when the file is replaced", async () => {
      const path = join(directory, "run.sh");
      const identity = await writeOwned(path, "agent\n");
      await writeFile(join(directory, "run.sh.foreign"), "host secret\n");
      await rename(join(directory, "run.sh.foreign"), path);
      await evidence.recordWrite("session-a", path, "before\n", identity);
      await expectNoDiff(path);
    });

    it("records no foreign file when the path becomes a hard link to another file", async () => {
      const path = join(directory, "run.sh");
      const identity = await writeOwned(path, "agent\n");
      await unlink(path);
      await link(join(outside, "run.sh"), path).catch(async (error: NodeJS.ErrnoException) => {
        // Hard links cannot cross devices; a same-device foreign file stands in.
        if (error.code !== "EXDEV") throw error;
        await writeFile(join(directory, "foreign.sh"), "host secret\n");
        await link(join(directory, "foreign.sh"), path);
      });
      await evidence.recordWrite("session-a", path, "before\n", identity);
      await expectNoDiff(path);
    });

    it("records no identity, and so no diff, for a write without a descriptor to report", async () => {
      const path = await file("run.sh", "agent\n");
      await evidence.recordWrite("session-a", path, "before\n", undefined);
      const snapshot = await evidence.snapshot(directory, [block("./run.sh")]);
      expect(snapshot.files.map(item => item.path)).toEqual([path]);
      expect(snapshot.files[0]?.review).toBeUndefined();
    });
  });

  it("treats a word too long to be a file name as no file, rather than failing the snapshot", async () => {
    const path = await changed("run.sh", `${"x".repeat(5_000)}\n`);
    const snapshot = await evidence.snapshot(directory, [block("./run.sh")]);
    expect(snapshot.warnings[0]?.files).toEqual([path]);
  });

  it("bounds the review text a snapshot carries in all, listing the files past the budget without a review", async () => {
    // Six files of nearly 1 MiB each: every one is within the per-file bound, together they are not.
    const names = ["a.sh", "b.sh", "c.sh", "d.sh", "e.sh", "f.sh"];
    for (const name of names) {
      const path = await file(name, `# ${"x".repeat(1_000_000)}\n`);
      await evidence.recordWrite("session-a", path, null, await heldIdentity(path));
    }
    const snapshot = await evidence.snapshot(directory, [block(names.map(name => `./${name}`).join("; "))]);
    expect(snapshot.files).toHaveLength(names.length);
    const reviewed = snapshot.files.filter(item => item.review);
    expect(reviewed.length).toBeGreaterThan(0);
    expect(reviewed.length).toBeLessThan(names.length);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(4 * 1_048_576 + 64 * 1024);
  });

  it("caps text reads and distinguishes absent files from unavailable text", async () => {
    const oversized = await file("large", "x".repeat(1_048_577));
    expect(await readTerminalReviewText(oversized)).toBeUndefined();
    expect(await readTerminalReviewText(join(directory, "absent"))).toBeNull();
  });
});

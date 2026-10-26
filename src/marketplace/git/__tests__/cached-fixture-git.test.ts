import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { gitFixtureEnv } from "../../../__tests__/support/git-fixture-env.mjs";
import { cachedFixtureGit } from "../../__tests__/fixtures/cached-git.js";
import { copyFixtureRepo, createFixtureRepo, hostGit, removeFixtureRepo, startGitHttpServer, type FixtureRepo, type GitHttpServer } from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import { BareRepo } from "../repo.js";
import { GIT_TIMEOUTS_MS, type GitRemote, type GitRunner } from "../run-git.js";

describe("cached fixture repositories", () => {
  let root: string;
  let repo: FixtureRepo;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let commands: Pick<GitRunner, "run" | "preflight">;
  let remote: GitRemote;
  let initial: string;
  let sequence = 0;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-cached-git-"));
    const seed = createFixtureRepo(root, "seed");
    repo = copyFixtureRepo(root, "market-1", seed, { publishByCopy: true });
    await removeFixtureRepo(seed);
    initial = repo.commit({ "README.md": "first\n" }, "initial");
    server = await startGitHttpServer({ root });
    git = await createTestGitRunner();
    commands = cachedFixtureGit(git.runner, root, server.origin, join(root, "cache"));
    remote = { url: normalizeSourceUrl(server.url("market-1")), sourceId: "fixture", allowHttp: true, useToken: false, credentialsAllowed: false, addressPolicy: () => "allow" };
  });
  afterAll(async () => {
    await server.close();
    await git.cleanup();
    await removeFixtureRepo(repo);
    await cleanupTmpDir(root);
  });

  const client = () => BareRepo.init(commands, join(root, `client-${++sequence}`));

  it("disables automatic maintenance and preserves snapshots after later publications", async () => {
    const owned = copyFixtureRepo(root, "ownership-1", repo, { publishByCopy: true });
    let snapshot: FixtureRepo | undefined;
    try {
      const trace = join(root, "ownership-trace.jsonl");
      const env = { ...gitFixtureEnv(join(root, "ownership-home")), GIT_TRACE2_EVENT: trace };
      execFileSync(git.git.path, ["commit", "--quiet", "--allow-empty", "-m", "owned command"], { cwd: owned.work, env });
      const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; argv?: string[] });
      expect(events.filter((event) => event.event === "child_start" && event.argv?.includes("maintenance"))).toEqual([]);
      for (const cwd of [owned.work, owned.bare]) {
        expect(execFileSync(git.git.path, ["config", "--local", "--get", "maintenance.auto"], { cwd, env, encoding: "utf8" }).trim()).toBe("false");
      }
      const pinned = owned.commit({ "README.md": "snapshot\n" }, "snapshot");
      snapshot = copyFixtureRepo(root, "ownership-snapshot", owned);
      owned.commit({ "README.md": "later publication\n" }, "later");
      expect(hostGit(["rev-parse", "HEAD"], snapshot.bare)).toBe(pinned);
      expect(await new BareRepo(git.runner, snapshot.bare).readFile(pinned, "README.md", 1024)).toEqual(Buffer.from("snapshot\n"));
    } finally {
      if (snapshot) await removeFixtureRepo(snapshot);
      await removeFixtureRepo(owned);
    }
  });

  it("requires both seed HEADs to match the requested branch before copying", async () => {
    expect(() => copyFixtureRepo(root, "mismatch", repo, { branch: "release" })).toThrow("fixture seed must be on branch release");
    expect(existsSync(join(root, "mismatch"))).toBe(false);
    const seed = createFixtureRepo(root, "release-seed", "release");
    let copied: FixtureRepo | undefined;
    try {
      writeFileSync(join(seed.work, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(() => copyFixtureRepo(root, "work-mismatch", seed, { branch: "release" })).toThrow("fixture seed must be on branch release");
      expect(existsSync(join(root, "work-mismatch"))).toBe(false);
      writeFileSync(join(seed.work, ".git", "HEAD"), "ref: refs/heads/release\n");
      copied = copyFixtureRepo(root, "release-copy", seed, { branch: "release", publishByCopy: true });
      const commit = copied.commit({ "README.md": "release\n" }, "publish release");
      expect(readFileSync(join(copied.work, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/release");
      expect(hostGit(["rev-parse", "refs/heads/release"], copied.bare)).toBe(commit);
      expect(existsSync(join(copied.bare, "refs", "heads", "main"))).toBe(false);
    } finally {
      if (copied) await removeFixtureRepo(copied);
      await removeFixtureRepo(seed);
    }
  });

  it("copies authored objects without overwriting another client's refs, and invalidates on publish", async () => {
    const run = vi.spyOn(git.runner, "run");
    try {
      const first = await client();
      const second = await client();
      expect(await first.fetchRef(remote, undefined, "candidate")).toBe(initial);
      expect(await second.fetchRef(remote, undefined, "candidate")).toBe(initial);
      expect(run.mock.calls.filter(([args]) => args[0] === "fetch")).toHaveLength(0);
      expect(await first.readFile(initial, "README.md", 1024)).toEqual(Buffer.from("first\n"));
      expect(await second.readFile(initial, "README.md", 1024)).toEqual(Buffer.from("first\n"));
      writeFileSync(join(second.dir, "refs", "ave", "retained"), `${initial}\n`);
      const next = repo.commit({ "README.md": "second\n" }, "update");
      expect(await first.fetchRef(remote, undefined, "candidate")).toBe(next);
      expect(await second.fetchRef(remote, undefined, "candidate")).toBe(next);
      expect(readFileSync(join(second.dir, "refs", "ave", "retained"), "utf8").trim()).toBe(initial);
      const actual = await new BareRepo(git.runner, second.dir).readFile(next, "README.md", 1024);
      expect(await second.readFile(next, "README.md", 1024)).toEqual(actual);
      expect(actual).toEqual(Buffer.from("second\n"));
      expect(await new BareRepo(git.runner, second.dir).lsRemote(remote)).toEqual(new Map([["HEAD", next]]));
    } finally {
      run.mockRestore();
    }
  });

  // Archive timestamps vary per run, so compare replay with the original stream bytes.
  it.each([
    { form: "root tree", treeish: (commit: string) => `${commit}^{tree}`,
      files: { "export/README.md": "root\n", "export/plugin/tool.txt": "tool\n" } },
    { form: "subtree path", treeish: (commit: string) => `${commit}:plugin`,
      files: { "export/tool.txt": "tool\n" } },
  ])("replays a $form archive with the bytes its one real run streamed", async ({ treeish, files }) => {
    const name = `archive-${++sequence}`;
    const source = copyFixtureRepo(root, name, repo, { publishByCopy: true });
    const real = git.runner.run.bind(git.runner);
    const run = vi.spyOn(git.runner, "run");
    try {
      source.commit({ "README.md": "root\n", "plugin/tool.txt": "tool\n" }, "archive layout");
      const sourceRemote = { ...remote, url: normalizeSourceUrl(server.url(name)) };
      const target = await client();
      const commit = await target.fetchRef(sourceRemote, undefined, "candidate");
      const args = ["archive", "--format=tar", "--prefix=export/", treeish(commit)];
      const options = { gitDir: target.dir, timeoutMs: GIT_TIMEOUTS_MS.export };
      const streamed: Buffer[] = [];
      run.mockImplementation((runArgs, runOptions) => runArgs[0] !== "archive" || !runOptions.onStdout
        ? real(runArgs, runOptions)
        : real(runArgs, { ...runOptions, onStdout: (chunk) => { streamed.push(Buffer.from(chunk)); runOptions.onStdout!(chunk); } }));
      const delivered: Buffer[] = [];
      for (let index = 0; index < 2; index++) {
        const chunks: Buffer[] = [];
        const result = await commands.run(args, { ...options, onStdout: (chunk) => chunks.push(Buffer.from(chunk)) });
        expect(result.stdout).toEqual(Buffer.alloc(0));
        delivered.push(Buffer.concat(chunks));
      }
      expect(run.mock.calls.filter(([runArgs]) => runArgs[0] === "archive")).toHaveLength(1);
      expect(Buffer.concat(streamed).length).toBeGreaterThan(0);
      expect(delivered[0]).toEqual(Buffer.concat(streamed));
      expect(delivered[1]).toEqual(Buffer.concat(streamed));
      expect(tarFiles(delivered[1]!)).toEqual(files);
    } finally {
      run.mockRestore();
      await removeFixtureRepo(source);
    }
  });

  it("executes path-dependent reads and retries failed reads instead of replaying them", async () => {
    const first = await client();
    const second = await client();
    const options = { timeoutMs: GIT_TIMEOUTS_MS.local };
    for (const target of [first, second]) {
      const result = await commands.run(["rev-parse", "--absolute-git-dir"], { ...options, gitDir: target.dir });
      expect(realpathSync(result.stdout.toString().trim())).toBe(realpathSync(target.dir));
    }
    const run = vi.spyOn(git.runner, "run");
    try {
      for (let index = 0; index < 2; index++) {
        await expect(commands.run(["cat-file", "blob", "f".repeat(40)], { ...options, gitDir: first.dir })).rejects.toThrow();
      }
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
    }
  });
});

function tarFiles(tar: Buffer): Record<string, string> {
  const files: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if (type === "0" || type === "") files[field(345, 155) ? `${field(345, 155)}/${field(0, 100)}` : field(0, 100)] = tar.subarray(offset + 512, offset + 512 + size).toString("utf8");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { cachedFixtureGit } from "../../__tests__/fixtures/cached-git.js";
import { copyFixtureRepo, createFixtureRepo, removeFixtureRepo, startGitHttpServer, type FixtureRepo, type GitHttpServer } from "../../__tests__/fixtures/git-http-server.js";
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

  it("replays streamed archive bytes exactly as the real command emits them", async () => {
    const target = await client();
    const commit = await target.fetchRef(remote, undefined, "candidate");
    const args = ["archive", "--format=tar", "--prefix=export/", `${commit}^{tree}`];
    const options = { gitDir: target.dir, timeoutMs: GIT_TIMEOUTS_MS.export };
    const actual = await git.runner.run(args, options);
    for (let index = 0; index < 2; index++) {
      const chunks: Buffer[] = [];
      const result = await commands.run(args, { ...options, onStdout: (chunk) => chunks.push(chunk) });
      expect(Buffer.concat(chunks)).toEqual(actual.stdout);
      expect(result.stdout).toEqual(Buffer.alloc(0));
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

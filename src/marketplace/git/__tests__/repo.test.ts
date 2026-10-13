import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import {
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  hostGit,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { BareRepo } from "../repo.js";
import type { GitRemote } from "../run-git.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const execFileAsync = promisify(execFile);
const LIMITS = { maxFiles: 100, maxBytes: 1024 * 1024 };

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof MarketplaceError && error.code === code);
}

describe("BareRepo", () => {
  let root: string;
  let scratch: string;
  let server: GitHttpServer;
  let t: TestGitRunner;
  let repo: FixtureRepo;
  let remote: GitRemote;
  let first: string;
  let second: string;
  let counter = 0;

  function localRepoDir(): string {
    counter += 1;
    return join(scratch, `clone-${counter}.git`);
  }

  function missingBlobs(dir: string, commit: string, path: string): string[] {
    return hostGit(["rev-list", "--objects", "--missing=print", "--no-walk", "--sparse", commit, "--", path], dir)
      .split("\n")
      .filter((line) => line.startsWith("?"));
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-bare-repo-"));
    scratch = mkdtempSync(join(tmpdir(), "ave-bare-scratch-"));
    repo = createFixtureRepo(root, "market");
    first = repo.commit(
      {
        "marketplace.json": "{\"v\":1}\n",
        "plugins/alpha/ave-package.json": "{\"name\":\"alpha\"}\n",
        "plugins/alpha/dist/index.js": "export {};\n",
        "skills/beta/SKILL.md": "# beta\n",
      },
      "first",
    );
    // The file mode for git on POSIX, the index bit where core.fileMode is off (Windows).
    chmodSync(join(repo.work, "plugins/alpha/dist/index.js"), 0o755);
    hostGit(["update-index", "--chmod=+x", "plugins/alpha/dist/index.js"], repo.work);
    second = repo.commit({ "plugins/alpha/dist/index.js": "export const v = 2;\n" }, "second");
    server = await startGitHttpServer({ root });
    t = await createTestGitRunner();
    remote = { url: normalizeSourceUrl(server.url("market")), sourceId: "fixture", allowHttp: true, useToken: false, credentialsAllowed: true, addressPolicy: () => "allow" };
  });
  afterAll(async () => {
    await t.cleanup();
    await server.close();
    await removeFixtureRepo(repo);
    await cleanupTmpDir(root);
    await cleanupTmpDir(scratch);
  });

  it("refuses the all-zero object id before git runs (a legacy grant pin has no tree, design §16.3)", async () => {
    const calls: string[][] = [];
    const runner = { run: async (args: readonly string[]) => { calls.push([...args]); throw new Error("git must not run"); } } as unknown as ConstructorParameters<typeof BareRepo>[0];
    const bare = new BareRepo(runner, localRepoDir());
    const zero = "0".repeat(40);
    await expect(bare.lsTree(zero, null, false)).rejects.toThrow("all-zero object id");
    await expect(bare.readFile(zero, "plugin.json", 1024)).rejects.toThrow("all-zero object id");
    await expect(bare.hasCommit(zero)).rejects.toThrow("all-zero object id");
    await expect(bare.commitTime(zero)).rejects.toThrow("all-zero object id");
    await expect(bare.ensureBlobs(remote, zero, ["plugin.json"])).rejects.toThrow("all-zero object id");
    expect(calls).toEqual([]);
  });

  it("lists the remote HEAD and a named ref", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    expect((await bare.lsRemote(remote)).get("HEAD")).toBe(second);
    expect((await bare.lsRemote(remote, "refs/heads/main")).get("refs/heads/main")).toBe(second);
  });

  it("fetches full history without blobs and checks ancestry", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    expect(await bare.fetchRef(remote, undefined, "candidate")).toBe(second);
    expect(await bare.fetchRef(remote, "main", "pin")).toBe(second);
    expect(await bare.isAncestor(first, second)).toBe(true);
    expect(await bare.isAncestor(second, first)).toBe(false);
    expect(missingBlobs(bare.dir, second, "marketplace.json")).toHaveLength(1);
  });

  it("reads a commit's time without the blobs rename detection would want", async () => {
    // A commit that deletes one file and adds others: `git show` would diff it
    // against its parent and try to fetch blobs this clone never has.
    const renamed = createFixtureRepo(root, "renamed");
    try {
      renamed.commit({ "README.md": "start\n" }, "start");
      const moved = renamed.commitEntries(
        [
          { path: "skills/alpha/SKILL.md", mode: "100644", content: "# alpha\n" },
          { path: "skills/alpha/ave-package.json", mode: "100644", content: "{}\n" },
        ],
        "move",
      );
      const bare = await BareRepo.init(t.runner, localRepoDir());
      const renamedRemote = { ...remote, url: normalizeSourceUrl(server.url("renamed")) };
      expect(await bare.fetchRef(renamedRemote, undefined, "pin")).toBe(moved);
      expect(await bare.commitTime(moved)).toBe(new Date(hostGit(["log", "-1", "--format=%cI", moved], renamed.work)).toISOString());
      expect(missingBlobs(bare.dir, moved, "skills")).toHaveLength(2);
    } finally {
      await removeFixtureRepo(renamed);
    }
  });

  it("reports a missing ref", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await expectCode(bare.fetchRef(remote, "no-such-branch", "candidate"), "SOURCE_REF_NOT_FOUND");
    await expectCode(bare.fetchRef(remote, "--upload-pack=touch /tmp/x", "candidate"), "SOURCE_REF_NOT_FOUND");
  });

  it("reads one file after fetching only its blob", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await bare.fetchRef(remote, undefined, "pin");
    await bare.ensureBlobs(remote, second, ["marketplace.json"]);
    expect((await bare.readFile(second, "marketplace.json", 1024))?.toString()).toBe("{\"v\":1}\n");
    expect(await bare.readFile(second, "absent.json", 1024)).toBeNull();
    expect(missingBlobs(bare.dir, second, "skills")).toHaveLength(1);
  });

  it("works on its own directory only, never on a repository above a broken one", async () => {
    const outer = join(scratch, "outer");
    hostGit(["init", "--quiet", outer]);
    const broken = join(outer, "sources", "acme", "repo.git");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "HEAD"), "ref: refs/heads/main\n");
    const bare = new BareRepo(t.runner, broken);
    await expect(bare.fetchRef(remote, undefined, "candidate")).rejects.toThrow();
    expect(hostGit(["for-each-ref", "refs/ave"], outer)).toBe("");
  });

  it("never fetches a missing object on its own", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await bare.fetchRef(remote, undefined, "pin");
    const [blob] = missingBlobs(bare.dir, second, "skills/beta/SKILL.md");
    // The contract environment of a call that may reach this remote: the lazy
    // fetch a partial clone would start on a missing object is not blocked by
    // the protocol allow-list here, only by GIT_NO_LAZY_FETCH.
    const env = t.runner.environment(remote);
    const before = server.seen.length;
    // Async: the fixture server answers from this process.
    await expect(execFileAsync(t.git.path, ["cat-file", "-s", blob!.slice(1)], { cwd: bare.dir, env })).rejects.toThrow();
    expect(server.seen.length).toBe(before);
    // A local call also allows no transport, which stops the fetch on its own.
    const { GIT_NO_LAZY_FETCH: _unused, ...local } = t.runner.environment(undefined);
    await expect(execFileAsync(t.git.path, ["cat-file", "-s", blob!.slice(1)], { cwd: bare.dir, env: local })).rejects.toThrow();
    expect(server.seen.length).toBe(before);
    expect(missingBlobs(bare.dir, second, "skills")).toHaveLength(1);
  });

  it("exports one package path at a commit, with the executable bit, fetching only that path", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await bare.fetchRef(remote, undefined, "pin");
    const dest = mkdtempSync(join(scratch, "export-"));
    const files = await bare.exportPath(remote, first, "plugins/alpha", dest, LIMITS);
    expect(files).toEqual([
      { path: "dist/index.js", size: "export {};\n".length, executable: false },
      { path: "ave-package.json", size: "{\"name\":\"alpha\"}\n".length, executable: false },
    ]);
    expect(readFileSync(join(dest, "dist/index.js"), "utf8")).toBe("export {};\n");
    expect(missingBlobs(bare.dir, first, "skills")).toHaveLength(1);

    const dest2 = mkdtempSync(join(scratch, "export-"));
    const files2 = await bare.exportPath(remote, second, "plugins/alpha", dest2, LIMITS);
    expect(files2.find((file) => file.path === "dist/index.js")).toMatchObject({ executable: true });
    if (process.platform !== "win32") expect(statSync(join(dest2, "dist/index.js")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dest2, "dist/index.js"), "utf8")).toBe("export const v = 2;\n");
  });

  it("enforces file-count and byte limits, refusing too many files before any blob is fetched", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await bare.fetchRef(remote, undefined, "pin");
    const missing = missingBlobs(bare.dir, second, ".").length;
    const before = server.seen.length;
    await expectCode(
      bare.exportPath(remote, second, "", mkdtempSync(join(scratch, "export-")), { maxFiles: 1, maxBytes: 1024 * 1024 }),
      "CONTENT_RULE_VIOLATION",
    );
    expect(server.seen.length).toBe(before);
    expect(missing).toBeGreaterThan(0);
    expect(missingBlobs(bare.dir, second, ".")).toHaveLength(missing);
    await expectCode(
      bare.exportPath(remote, second, "plugins/alpha", mkdtempSync(join(scratch, "export-")), { maxFiles: 1, maxBytes: 1024 }),
      "CONTENT_RULE_VIOLATION",
    );
    await expectCode(
      bare.exportPath(remote, second, "plugins/alpha", mkdtempSync(join(scratch, "export-")), { maxFiles: 10, maxBytes: 8 }),
      "CONTENT_RULE_VIOLATION",
    );
  });

  it("refuses paths that would reach git as options or escape", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await bare.fetchRef(remote, undefined, "pin");
    for (const path of ["../x", "/abs", "plugins/", "a:b", "plugins/*"]) {
      await expect(bare.exportPath(remote, second, path, scratch, LIMITS)).rejects.toThrow("invalid repository path");
    }
  });

  it("exports the whole tree for the root path of a direct source", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await bare.fetchRef(remote, undefined, "pin");
    const dest = mkdtempSync(join(scratch, "export-"));
    const files = await bare.exportPath(remote, second, "", dest, LIMITS);
    expect(files.map((file) => file.path)).toEqual(hostGit(["ls-tree", "-r", "--name-only", second], repo.bare).split("\n").sort());
    expect(readFileSync(join(dest, "plugins/alpha/dist/index.js"), "utf8")).toBe("export const v = 2;\n");
  });

  describe("tree entries a package may not contain", () => {
    let hostile: FixtureRepo;
    let hostileRemote: GitRemote;
    let bare: BareRepo;
    let symlinkCommit: string;
    let gitlinkCommit: string;
    let caseCommit: string;
    let runtimeDirCommit: string;

    beforeAll(async () => {
      hostile = createFixtureRepo(root, "hostile");
      hostile.commit({ "README.md": "x\n" }, "base");
      symlinkCommit = hostile.commitEntries(
        [
          { path: "plugins/evil/plugin.json", mode: "100644", content: "{}" },
          { path: "plugins/evil/link", mode: "120000", content: "/etc/passwd" },
        ],
        "symlink",
      );
      gitlinkCommit = hostile.commitEntries(
        [
          { path: "plugins/evil/plugin.json", mode: "100644", content: "{}" },
          { path: "plugins/evil/sub", mode: "160000", oid: first },
        ],
        "gitlink",
      );
      caseCommit = hostile.commitEntries(
        [
          { path: "plugins/evil/A.txt", mode: "100644", content: "upper" },
          { path: "plugins/evil/a.txt", mode: "100644", content: "lower" },
        ],
        "case",
      );
      runtimeDirCommit = hostile.commitEntries(
        [{ path: "plugins/evil/data/state.json", mode: "100644", content: "{}" }],
        "runtime dir",
      );
      hostileRemote = { url: normalizeSourceUrl(server.url("hostile")), sourceId: "hostile", allowHttp: true, useToken: false, credentialsAllowed: true, addressPolicy: () => "allow" };
      bare = await BareRepo.init(t.runner, localRepoDir());
      await bare.fetchRef(hostileRemote, undefined, "pin");
    });
    afterAll(() => removeFixtureRepo(hostile));

    it.each([
      ["a symlink", () => symlinkCommit],
      ["a submodule", () => gitlinkCommit],
      ["case-only duplicate paths", () => caseCommit],
      ["a plugin runtime directory", () => runtimeDirCommit],
    ])("rejects %s", async (_label, commit) => {
      await expectCode(
        bare.exportPath(hostileRemote, commit(), "plugins/evil", mkdtempSync(join(scratch, "export-")), LIMITS),
        "CONTENT_RULE_VIOLATION",
      );
    });

    it("reads a symlink as a rule violation, not as its target", async () => {
      await bare.ensureBlobs(hostileRemote, symlinkCommit, ["plugins/evil"]);
      await expectCode(bare.readFile(symlinkCommit, "plugins/evil/link", 1024), "CONTENT_RULE_VIOLATION");
    });
  });

  // GitLab answers a repository path without `.git` with a redirect to the same path with `.git`;
  // the stored address never carries `.git`, and git follows no redirect.
  describe("a host that redirects the address to its .git form", () => {
    let suffixed: FixtureRepo;
    let head: string;

    beforeAll(() => {
      suffixed = createFixtureRepo(root, "suffixed.git");
      head = suffixed.commit({ "marketplace.json": "{\"v\":3}\n", "plugins/gamma/ave-package.json": "{\"name\":\"gamma\"}\n" }, "suffixed");
    });
    afterAll(async () => {
      await removeFixtureRepo(suffixed);
    });

    function redirectedRemote(name: string): GitRemote {
      return { ...remote, url: normalizeSourceUrl(server.url(`${name}.git`)) };
    }

    function requestsTo(name: string): number {
      return server.seen.filter((request) => request.path.split("/")[1] === name).length;
    }

    it("lists, fetches and exports at the .git address on the same host", async () => {
      server.redirect("suffixed", `${server.origin}/suffixed.git`);
      const redirected = redirectedRemote("suffixed");
      expect(redirected.url.url).toBe(server.url("suffixed"));
      const bare = await BareRepo.init(t.runner, localRepoDir());
      expect((await bare.lsRemote(redirected)).get("HEAD")).toBe(head);
      expect(await bare.refNames(redirected, 10)).toEqual(["main"]);
      expect(await bare.fetchRef(redirected, undefined, "pin")).toBe(head);
      const dest = join(scratch, `suffixed-${counter}`);
      const files = await bare.exportPath(redirected, head, "plugins/gamma", dest, LIMITS);
      expect(files.map((file) => file.path)).toEqual(["ave-package.json"]);
      expect(requestsTo("suffixed")).toBeGreaterThan(0);
      expect(requestsTo("suffixed.git")).toBeGreaterThan(0);
    });

    it("never requests the redirect's Location, and reports the redirect when the .git address has no repository", async () => {
      server.redirect("elsewhere", `${server.origin}/landing/info/refs?service=git-upload-pack`);
      const bare = await BareRepo.init(t.runner, localRepoDir());
      const error = await bare.lsRemote(redirectedRemote("elsewhere")).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MarketplaceError);
      expect((error as MarketplaceError).code).toBe("SOURCE_UNREACHABLE");
      expect((error as MarketplaceError).detail).toEqual({ reason: "http-status", host: "127.0.0.1", status: 302 });
      expect(requestsTo("elsewhere.git")).toBeGreaterThan(0);
      expect(requestsTo("landing")).toBe(0);
    });

    it("does not retry an address that answers without a redirect", async () => {
      const bare = await BareRepo.init(t.runner, localRepoDir());
      await expectCode(bare.lsRemote({ ...remote, url: normalizeSourceUrl(server.url("absent")) }), "SOURCE_UNREACHABLE");
      expect(requestsTo("absent")).toBeGreaterThan(0);
      expect(requestsTo("absent.git")).toBe(0);
    });
  });
});

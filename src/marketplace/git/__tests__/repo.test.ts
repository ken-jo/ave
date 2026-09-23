import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import {
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { BareRepo } from "../repo.js";
import type { GitRemote } from "../run-git.js";

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
    return execFileSync("git", ["rev-list", "--objects", "--missing=print", "--no-walk", "--sparse", commit, "--", path], {
      cwd: dir,
      encoding: "utf8",
    })
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
    execFileSync("chmod", ["+x", join(repo.work, "plugins/alpha/dist/index.js")]);
    second = repo.commit({ "plugins/alpha/dist/index.js": "export const v = 2;\n" }, "second");
    server = await startGitHttpServer({ root });
    t = await createTestGitRunner();
    remote = { url: normalizeSourceUrl(server.url("market")), sourceId: "fixture", allowHttp: true };
  });
  afterAll(async () => {
    await t.cleanup();
    await server.close();
    removeFixtureRepo(repo);
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
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
    expect(statSync(join(dest2, "dist/index.js")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dest2, "dist/index.js"), "utf8")).toBe("export const v = 2;\n");
  });

  it("enforces file-count and byte limits", async () => {
    const bare = await BareRepo.init(t.runner, localRepoDir());
    await bare.fetchRef(remote, undefined, "pin");
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
    for (const path of ["", "../x", "/abs", "plugins/", "a:b", "plugins/*"]) {
      await expect(bare.exportPath(remote, second, path, scratch, LIMITS)).rejects.toThrow("invalid repository path");
    }
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
      hostileRemote = { url: normalizeSourceUrl(server.url("hostile")), sourceId: "hostile", allowHttp: true };
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
});

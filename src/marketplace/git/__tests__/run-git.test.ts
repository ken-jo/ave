import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { classifyRemoteFailure, GIT_TIMEOUTS_MS, type GitRemote } from "../run-git.js";

function remote(url: string, allowHttp = true, useToken = true): GitRemote {
  return { url: normalizeSourceUrl(url), sourceId: "fixture", allowHttp, useToken };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<MarketplaceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).code).toBe(code);
    return error as MarketplaceError;
  }
  throw new Error(`expected ${code}`);
}

describe("GitRunner invocation contract", () => {
  let t: TestGitRunner;
  beforeAll(async () => {
    t = await createTestGitRunner({ resolveProxy: async () => "PROXY proxy.corp.example:3128; DIRECT", tokens: { "github.com": "stored-token" } });
  });
  afterAll(async () => t.cleanup());

  it("builds the environment from scratch", () => {
    process.env.AVE_TEST_LEAK_CANARY = "secret";
    process.env.GIT_DIR = "/tmp/elsewhere";
    try {
      const env = t.runner.environment(remote("https://github.com/acme/tools", false));
      expect(env).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        LC_ALL: "C",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        GIT_ALLOW_PROTOCOL: "https:ssh",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ASKPASS: t.broker.launcherPath,
      });
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(t.dir, "gitconfig"));
      expect(env.AVE_TEST_LEAK_CANARY).toBeUndefined();
      expect(env.GIT_DIR).toBeUndefined();
      expect(t.runner.environment(remote("http://git.corp.example/a/b", true)).GIT_ALLOW_PROTOCOL).toBe("https:ssh:http");
      expect(t.runner.environment(undefined).GIT_ALLOW_PROTOCOL).toBe("none");
    } finally {
      delete process.env.AVE_TEST_LEAK_CANARY;
      delete process.env.GIT_DIR;
    }
  });

  it("carries the fixed -c flags and the PAC proxy for http(s) remotes", async () => {
    const args = await t.runner.configArgs(remote("https://github.com/acme/tools"));
    const flags = args.filter((_, index) => index % 2 === 1);
    expect(args.filter((_, index) => index % 2 === 0).every((arg) => arg === "-c")).toBe(true);
    expect(flags).toEqual([
      "protocol.file.allow=never",
      "submodule.recurse=false",
      "core.fsmonitor=false",
      `core.hooksPath=${join(t.dir, "empty")}`,
      "http.followRedirects=false",
      "http.proxy=http://proxy.corp.example:3128",
      "filter.lfs.smudge=",
      "filter.lfs.process=",
      "filter.lfs.required=false",
      "gc.auto=0",
      "maintenance.auto=false",
      "credential.helper=",
    ]);
    // No reset without a stored token for the host (an OS helper answers), or for a source without token auth.
    expect(await t.runner.configArgs(remote("https://gitlab.com/acme/tools"))).not.toContain("credential.helper=");
    expect(await t.runner.configArgs(remote("https://github.com/acme/tools", false, false))).not.toContain("credential.helper=");
    expect(await t.runner.configArgs(remote("git@github.com:acme/tools"))).toContain("http.proxy=");
    expect(await t.runner.configArgs(undefined)).toContain("http.proxy=");
  });
});

describe("GitRunner proxy from PAC", () => {
  it.each([
    ["SOCKS socks.corp.example:1080", "http.proxy=socks4://socks.corp.example:1080"],
    ["SOCKS5 socks.corp.example:1080; DIRECT", "http.proxy=socks5://socks.corp.example:1080"],
    ["DIRECT", "http.proxy="],
  ])("maps %j", async (pac, flag) => {
    const t = await createTestGitRunner({ resolveProxy: async () => pac });
    try {
      expect(await t.runner.configArgs(remote("https://github.com/acme/tools"))).toContain(flag);
    } finally {
      await t.cleanup();
    }
  });

  it("refuses a proxy git cannot use instead of going direct", async () => {
    const t = await createTestGitRunner({ resolveProxy: async () => "QUIC quic.corp.example:443" });
    try {
      await expectCode(t.runner.configArgs(remote("https://github.com/acme/tools")), "SOURCE_UNREACHABLE");
    } finally {
      await t.cleanup();
    }
  });
});

describe("GitRunner against a smart-HTTP server", () => {
  let root: string;
  let repo: FixtureRepo;
  let server: GitHttpServer;
  let otherServer: GitHttpServer;
  let t: TestGitRunner;
  let head: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-git-http-"));
    repo = createFixtureRepo(root, "tools");
    head = repo.commit({ "README.md": "hello\n" }, "initial");
    server = await startGitHttpServer({ root });
    otherServer = await startGitHttpServer({ root });
    t = await createTestGitRunner();
  });
  afterAll(async () => {
    await t.cleanup();
    await server.close();
    await otherServer.close();
    removeFixtureRepo(repo);
    rmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    server.seen.length = 0;
    otherServer.seen.length = 0;
  });

  it("lists remote refs over http when the host allows it", async () => {
    const result = await t.runner.run(["ls-remote", server.url("tools"), "refs/heads/main"], {
      remote: remote(server.url("tools")),
      timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
    });
    expect(result.stdout.toString()).toContain(`${head}\trefs/heads/main`);
  });

  it("refuses plain http unless the host is listed", async () => {
    await expectCode(
      t.runner.run(["ls-remote", server.url("tools")], {
        remote: remote(server.url("tools"), false),
        timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
      }),
      "SOURCE_UNREACHABLE",
    );
    expect(server.seen).toHaveLength(0);
  });

  it("refuses the file protocol even when a caller passes a path", async () => {
    await expectCode(
      t.runner.run(["ls-remote", `file://${repo.bare}`], {
        remote: remote(server.url("tools")),
        timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
      }),
      "SOURCE_UNREACHABLE",
    );
  });

  it("does not follow redirects", async () => {
    server.redirect("moved", `${otherServer.origin}/tools/info/refs?service=git-upload-pack`);
    await expectCode(
      t.runner.run(["ls-remote", server.url("moved")], {
        remote: remote(server.url("moved")),
        timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
      }),
      "SOURCE_UNREACHABLE",
    );
    expect(otherServer.seen).toHaveLength(0);
  });

  it("reports an unreachable remote on timeout", async () => {
    server.hang("slow");
    const error = await expectCode(
      t.runner.run(["ls-remote", server.url("slow")], { remote: remote(server.url("slow")), timeoutMs: 300 }),
      "SOURCE_UNREACHABLE",
    );
    expect(error.message).toContain("timed out");
  });

  it("stops on abort", async () => {
    server.hang("slow");
    const controller = new AbortController();
    const pending = t.runner.run(["ls-remote", server.url("slow")], {
      remote: remote(server.url("slow")),
      timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 100);
    await expect(pending).rejects.toThrow("cancelled by test");
  });

  it("caps buffered output", async () => {
    await expect(
      t.runner.run(["ls-remote", server.url("tools")], {
        remote: remote(server.url("tools")),
        timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
        maxStdoutBytes: 10,
      }),
    ).rejects.toThrow("exceeded the limit");
  });

  it("reports a missing executable as GIT_RUNTIME_MISSING", async () => {
    const { GitRunner } = await import("../run-git.js");
    const broken = new GitRunner({
      git: { ...t.git, path: join(t.dir, "no-such-git") },
      globalConfigPath: join(t.dir, "gitconfig"),
      emptyDir: join(t.dir, "empty"),
      askpass: t.broker,
    });
    await expectCode(broken.run(["--version"], { timeoutMs: 5_000 }), "GIT_RUNTIME_MISSING");
  });
});

describe("GitRunner authentication through the askpass broker", () => {
  let root: string;
  let repo: FixtureRepo;
  let server: GitHttpServer;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ave-git-auth-"));
    repo = createFixtureRepo(root, "private-tools");
    repo.commit({ "README.md": "private\n" }, "initial");
    server = await startGitHttpServer({ root, token: "s3cret-token" });
  });
  afterAll(async () => {
    await server.close();
    removeFixtureRepo(repo);
    rmSync(root, { recursive: true, force: true });
  });

  it("answers with the stored token for the ticket's host", async () => {
    const t = await createTestGitRunner({ tokens: { "127.0.0.1": "s3cret-token" } });
    try {
      const result = await t.runner.run(["ls-remote", server.url("private-tools")], {
        remote: remote(server.url("private-tools")),
        timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
      });
      expect(result.stdout.toString()).toContain("refs/heads/main");
      const authorized = server.seen.find((request) => request.authorization);
      expect(Buffer.from(authorized!.authorization!.slice(6), "base64").toString()).toBe("x-access-token:s3cret-token");
    } finally {
      await t.cleanup();
    }
  });

  it("reports SOURCE_AUTH_REQUIRED without a token and with a wrong one", async () => {
    const cases: Array<Record<string, string>> = [{}, { "127.0.0.1": "wrong" }];
    for (const tokens of cases) {
      const t = await createTestGitRunner({ tokens });
      try {
        await expectCode(
          t.runner.run(["ls-remote", server.url("private-tools")], {
            remote: remote(server.url("private-tools")),
            timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
          }),
          "SOURCE_AUTH_REQUIRED",
        );
      } finally {
        await t.cleanup();
      }
    }
  });

  it("keeps the token out of the user's credential helpers", async () => {
    const t = await createTestGitRunner({ tokens: { "127.0.0.1": "s3cret-token" } });
    const store = join(t.dir, "stored-credentials");
    writeFileSync(join(t.dir, "gitconfig"), `[credential]\n\thelper = store --file=${store}\n`);
    try {
      await t.runner.run(["ls-remote", server.url("private-tools")], {
        remote: remote(server.url("private-tools")),
        timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
      });
      // Without the reset, git's `credential approve` hands the askpass answer to every helper.
      expect(existsSync(store) ? readFileSync(store, "utf8") : "").toBe("");
    } finally {
      await t.cleanup();
    }
  });

  it("offers no token to a source that does not declare token auth", async () => {
    const t = await createTestGitRunner({ tokens: { "127.0.0.1": "s3cret-token" } });
    server.seen.length = 0;
    try {
      await expectCode(
        t.runner.run(["ls-remote", server.url("private-tools")], {
          remote: remote(server.url("private-tools"), true, false),
          timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
        }),
        "SOURCE_AUTH_REQUIRED",
      );
      expect(server.seen.every((request) => request.authorization === undefined)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("never gives a token to a ticket bound to another host", async () => {
    const t = await createTestGitRunner({ tokens: { "127.0.0.1": "s3cret-token", "localhost": "other" } });
    server.seen.length = 0;
    try {
      // The ticket is bound to `localhost`, while git prompts for 127.0.0.1.
      const bound = { ...remote(server.url("private-tools")), url: normalizeSourceUrl("http://localhost/private-tools") };
      await expectCode(
        t.runner.run(["ls-remote", server.url("private-tools")], { remote: bound, timeoutMs: GIT_TIMEOUTS_MS.lsRemote }),
        "SOURCE_AUTH_REQUIRED",
      );
      expect(server.seen.every((request) => request.authorization === undefined
        || !Buffer.from(request.authorization.slice(6), "base64").toString().includes("s3cret-token"))).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});

describe("classifyRemoteFailure", () => {
  it.each([
    ["fatal: Authentication failed for 'https://github.com/a/b/'", false, "SOURCE_AUTH_REQUIRED"],
    ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", false, "SOURCE_AUTH_REQUIRED"],
    ["Host key verification failed.\nfatal: Could not read from remote repository.", false, "SOURCE_SSH_HOST_UNKNOWN"],
    ["fatal: couldn't find remote ref refs/heads/nope", false, "SOURCE_REF_NOT_FOUND"],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", false, "SOURCE_UNREACHABLE"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", true, "SOURCE_AUTH_REQUIRED"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", false, "SOURCE_UNREACHABLE"],
  ] as const)("%j", (stderr, offered, code) => {
    expect(classifyRemoteFailure(stderr, offered)).toBe(code);
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyAddress, NetworkGuardError } from "../../../core/network-guard.js";
import { ConfirmationRequiredError, MarketplaceError } from "../../errors.js";
import { NetworkGate } from "../../net/network-gate.js";
import { normalizeSourceUrl } from "../../net/source-url.js";
import type { SourceWarning } from "../../sources/warnings.js";
import { policyLoad, policySource } from "../../__tests__/fixtures/policy.js";
import {
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner as buildTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { BareRepo } from "../repo.js";
import { classifyRemoteFailure, GIT_TIMEOUTS_MS, GitRunner, type GitRemote, type GitResult } from "../run-git.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { gitFixtureEnv } from "../../../__tests__/support/git-fixture-env.mjs";

// Process/authentication cases use a real broker; only its immutable runtime
// and listener are shared. Each runner owns a fresh config and empty directory.
let sharedRuntime: TestGitRunner;
const brokerTokens: Record<string, string> = {};
beforeAll(async () => {
  sharedRuntime = await buildTestGitRunner({ tokens: brokerTokens });
});
afterAll(async () => sharedRuntime.cleanup());
async function createRunner(options: Parameters<typeof buildTestGitRunner>[0] = {}): Promise<TestGitRunner> {
  const { tokens = {}, ...configuration } = options;
  for (const host of Object.keys(brokerTokens)) delete brokerTokens[host];
  Object.assign(brokerTokens, tokens);
  return buildTestGitRunner({ ...configuration, runtime: sharedRuntime });
}

function remote(url: string, allowHttp = true, useToken = true): GitRemote {
  return { url: normalizeSourceUrl(url), sourceId: "fixture", allowHttp, useToken, credentialsAllowed: true, addressPolicy: () => "allow" };
}

/** The gate's rule for an entered target, reduced to the refusal these tests need. */
const refuseMetadata: GitRemote["addressPolicy"] = (address) =>
  classifyAddress(address) === "metadata" ? new NetworkGuardError(`${address} is metadata`, { cause: new MarketplaceError("SOURCE_URL_REJECTED", "metadata", { detail: { reason: "address-metadata", host: "market.test", address } }), rank: 4 }) : "allow";

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
    t = await createRunner({ resolveProxy: async () => "PROXY proxy.corp.example:3128; DIRECT", tokens: { "github.com": "stored-token" } });
  });
  afterAll(async () => t.cleanup());

  it("builds the environment from scratch", () => {
    process.env.MARKETPLACE_TEST_LEAK_CANARY = "secret";
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
      expect(env.MARKETPLACE_TEST_LEAK_CANARY).toBeUndefined();
      expect(env.GIT_DIR).toBeUndefined();
      expect(t.runner.environment(remote("http://git.corp.example/a/b", true)).GIT_ALLOW_PROTOCOL).toBe("https:ssh:http");
      expect(t.runner.environment(undefined).GIT_ALLOW_PROTOCOL).toBe("none");
    } finally {
      delete process.env.MARKETPLACE_TEST_LEAK_CANARY;
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
    const t = await createRunner({ resolveProxy: async () => pac });
    try {
      expect(await t.runner.configArgs(remote("https://github.com/acme/tools"))).toContain(flag);
    } finally {
      await t.cleanup();
    }
  });

  it.each([
    ["PROXY 169.254.169.254:80", "address-metadata"],
    ["PROXY 192.0.2.1:80", "address-unroutable"],
    ["PROXY [fd00:ec2::254]:80", "address-metadata"],
    ["PROXY [::ffff:169.254.169.254]:80", "address-metadata"],
    ["PROXY [64:ff9b::a9fe:a9fe]:80", "address-metadata"],
    ["SOCKS5 169.254.169.254:1080", "address-metadata"],
  ])("refuses the literal proxy of %j before git starts, on the preflight and on a call (§18.3 #3)", async (pac, reason) => {
    const lookups: string[] = [];
    const t = await createRunner({ resolveProxy: async () => pac, lookup: async (host) => (lookups.push(host), ["1.1.1.1"]) });
    const spawn = vi.spyOn(GitRunner.prototype as unknown as { spawnGit: () => Promise<GitResult> }, "spawnGit");
    try {
      const target = remote("https://git.example.com/acme/tools");
      expect((await expectCode(t.runner.preflight(target), "SOURCE_URL_REJECTED")).detail).toMatchObject({ reason });
      expect((await expectCode(t.runner.run(["ls-remote", target.url.url], { remote: target, timeoutMs: 5_000 }), "SOURCE_URL_REJECTED")).detail).toMatchObject({ reason });
      expect(spawn).not.toHaveBeenCalled();
      // The literal is judged as its own answer: nothing resolves the proxy.
      expect(lookups.filter((host) => host !== "git.example.com")).toEqual([]);
    } finally {
      spawn.mockRestore();
      await t.cleanup();
    }
  });

  it("configures git with the one route its binding checked, though the PAC answer changes between questions (§18.2.4)", async () => {
    const routes = ["PROXY checked.test:3128", "PROXY unchecked.test:3128"];
    let asked = 0;
    const lookups: string[] = [];
    const t = await createRunner({
      resolveProxy: async () => routes[Math.min(asked++, routes.length - 1)]!,
      lookup: async (host) => (lookups.push(host), ["127.0.0.1"]),
    });
    let argv: string[] = [];
    const spawn = vi.spyOn(GitRunner.prototype as unknown as { spawnGit: (command: string, args: string[]) => Promise<GitResult> }, "spawnGit").mockImplementation(async (_command, args) => {
      argv = args;
      return { stdout: Buffer.alloc(0), stderr: "" };
    });
    try {
      const target = remote("https://git.example.com/acme/tools");
      await t.runner.run(["ls-remote", target.url.url], { remote: target, timeoutMs: 5_000 });
      expect(asked).toBe(1);
      expect(argv).toContain("http.proxy=http://checked.test:3128");
      expect(argv).toContain("http.curloptResolve=checked.test:3128:127.0.0.1");
      expect(argv.join(" ")).not.toContain("unchecked.test");
      expect(lookups).toEqual(["checked.test"]);
    } finally {
      spawn.mockRestore();
      await t.cleanup();
    }
  });

  it("refuses a proxy git cannot use instead of going direct", async () => {
    const t = await createRunner({ resolveProxy: async () => "QUIC quic.corp.example:443" });
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
    t = await createRunner();
  });
  afterAll(async () => {
    await t.cleanup();
    await server.close();
    await otherServer.close();
    await removeFixtureRepo(repo);
    await cleanupTmpDir(root);
  });
  afterEach(async () => {
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

  it("pins the remote's host to its one lookup's answer with http.curloptResolve, and looks it up no second time (§18.2.4)", async () => {
    // A rebinding resolver: the fixture's address to the first lookup, the metadata address to any later one.
    const lookups: string[] = [];
    const pinned = await createRunner({
      lookup: async (host) => {
        lookups.push(host);
        return lookups.length === 1 ? ["127.0.0.1"] : ["169.254.169.254"];
      },
    });
    try {
      // git cannot resolve market.test itself: the call succeeds only through the pinned entry.
      const url = server.url("tools").replace("127.0.0.1", "market.test");
      const target: GitRemote = { ...remote(url), addressPolicy: refuseMetadata };
      const result = await pinned.runner.run(["ls-remote", url, "refs/heads/main"], { remote: target, timeoutMs: GIT_TIMEOUTS_MS.lsRemote });
      expect(result.stdout.toString()).toContain(`${head}\trefs/heads/main`);
      expect(lookups).toEqual(["market.test"]);
    } finally {
      await pinned.cleanup();
    }
  });

  it("starts no git when the one lookup answers only refused addresses", async () => {
    const refused = await createRunner({ lookup: async () => ["169.254.169.254"] });
    try {
      const url = server.url("tools").replace("127.0.0.1", "market.test");
      const error = await expectCode(
        refused.runner.run(["ls-remote", url], { remote: { ...remote(url), addressPolicy: refuseMetadata }, timeoutMs: GIT_TIMEOUTS_MS.lsRemote }),
        "SOURCE_URL_REJECTED",
      );
      expect(error.detail).toEqual({ reason: "address-metadata", host: "market.test", address: "169.254.169.254" });
      expect(server.seen).toEqual([]);
    } finally {
      await refused.cleanup();
    }
  });

  it("names the branches and tags the remote has when a ref is missing", async () => {
    execFileSync("git", ["tag", "v1.0.0", head], { cwd: repo.bare, env: gitFixtureEnv(repo.bare) });
    const local = await BareRepo.init(t.runner, join(root, "missing-ref.git"));
    const error = await expectCode(local.fetchRef(remote(server.url("tools")), "nope", "candidate"), "SOURCE_REF_NOT_FOUND");
    expect(error.detail).toEqual({ reason: "missing", ref: "nope", repository: remote(server.url("tools")).url.url, available: ["main", "v1.0.0"] });
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
    const requested = server.hang("timeout");
    let expire!: () => void;
    const cancel = vi.fn();
    const schedule = vi.fn((callback: () => void, _delayMs: number) => {
      expire = callback;
      return cancel;
    });
    const timed = await createRunner({ _scheduleTimeoutForTest: schedule });
    try {
      const result = expectCode(
        timed.runner.run(["ls-remote", server.url("timeout")], { remote: remote(server.url("timeout")), timeoutMs: 300 }),
        "SOURCE_UNREACHABLE",
      );
      // The real transport is running; only its deadline is driven in process.
      await requested;
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), 300);
      expire();
      const error = await result;
      expect(error.message).toContain("timed out");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await timed.cleanup();
    }
  });

  it("stops on abort", async () => {
    const requested = server.hang("abort");
    const controller = new AbortController();
    const pending = expect(t.runner.run(["ls-remote", server.url("abort")], {
      remote: remote(server.url("abort")),
      timeoutMs: GIT_TIMEOUTS_MS.lsRemote,
      signal: controller.signal,
    })).rejects.toThrow("cancelled by test");
    await requested;
    controller.abort(new Error("cancelled by test"));
    await pending;
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
    await removeFixtureRepo(repo);
    await cleanupTmpDir(root);
  });

  it("answers with the stored token for the ticket's host", async () => {
    // Releasing a borrowed runner must leave its suite-owned broker available.
    const released = await createRunner();
    await released.cleanup();
    const t = await createRunner({ tokens: { "127.0.0.1": "s3cret-token" } });
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
      const t = await createRunner({ tokens });
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
    const t = await createRunner({ tokens: { "127.0.0.1": "s3cret-token" } });
    const store = join(t.dir, "stored-credentials");
    // Forward slashes: a raw Windows path is not a valid unquoted config value.
    writeFileSync(join(t.dir, "gitconfig"), `[credential]\n\thelper = store --file=${store.replaceAll("\\", "/")}\n`);
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
    const t = await createRunner({ tokens: { "127.0.0.1": "s3cret-token" } });
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

  it("sends no credential over http without token-unencrypted, a stored token included (§18.2.2)", async () => {
    const t = await createRunner({ tokens: { "127.0.0.1": "s3cret-token" } });
    const store = join(t.dir, "stored-credentials");
    writeFileSync(store, "http://x-access-token:s3cret-token@127.0.0.1\n");
    writeFileSync(join(t.dir, "gitconfig"), `[credential]\n\thelper = store --file=${store.replaceAll("\\", "/")}\n`);
    server.seen.length = 0;
    try {
      // A token source over http whose user has not accepted sending the token unencrypted, as a listed
      // (managed) host is: the listing does not imply it.
      const withheld: GitRemote = { ...remote(server.url("private-tools")), credentialsAllowed: false };
      expect(await t.runner.configArgs(withheld)).toContain("credential.helper=");
      const error = await expectCode(
        t.runner.run(["ls-remote", server.url("private-tools")], { remote: withheld, timeoutMs: GIT_TIMEOUTS_MS.lsRemote }),
        "SOURCE_AUTH_REQUIRED",
      );
      expect(error.detail).toEqual({ reason: "token-unencrypted", host: "127.0.0.1" });
      // Neither askpass (holding the token) nor the user's own helper (holding it too) answered.
      expect(server.seen.every((request) => request.authorization === undefined)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("reaches an http source only once unencrypted is confirmed, at its one checked address, and signs in only with token-unencrypted (§18.2.2, §18.2.4)", async () => {
    const lookups: string[] = [];
    const t = await createRunner({ tokens: { "market.test": "s3cret-token" }, lookup: async (host) => (lookups.push(host), ["127.0.0.1"]) });
    // git cannot resolve market.test itself: every request reaches the fixture only through the pinned address.
    const url = server.url("private-tools").replace("127.0.0.1", "market.test");
    const normalized = normalizeSourceUrl(url);
    const gate = new NetworkGate({ policy: policySource(policyLoad()), allowLoopback: true, transport: async () => new Response(null, { status: 599 }) });
    const remoteWith = (...warnings: SourceWarning[]): GitRemote => ({
      url: normalized,
      sourceId: "fixture",
      useToken: true,
      ...gate.checkRemote(normalized, { official: false, acknowledged: new Set(warnings) }),
    });
    server.seen.length = 0;
    try {
      // Without `unencrypted` the gate asks; nothing is looked up or contacted.
      expect(() => remoteWith()).toThrow(ConfirmationRequiredError);
      expect(lookups).toEqual([]);
      expect(server.seen).toEqual([]);

      // With `unencrypted` only: git reaches the checked address, and no credential answers.
      const plain = remoteWith("unencrypted");
      expect(plain).toMatchObject({ allowHttp: true, credentialsAllowed: false });
      const error = await expectCode(t.runner.run(["ls-remote", url], { remote: plain, timeoutMs: GIT_TIMEOUTS_MS.lsRemote }), "SOURCE_AUTH_REQUIRED");
      expect(error.detail).toEqual({ reason: "token-unencrypted", host: "market.test" });
      expect(lookups).toEqual(["market.test"]);
      expect(server.seen.length).toBeGreaterThan(0);
      expect(server.seen.every((request) => request.authorization === undefined)).toBe(true);

      // With token-unencrypted too: the stored token answers, still over the one checked address per call.
      server.seen.length = 0;
      const signedIn = remoteWith("unencrypted", "token-unencrypted");
      const result = await t.runner.run(["ls-remote", url], { remote: signedIn, timeoutMs: GIT_TIMEOUTS_MS.lsRemote });
      expect(result.stdout.toString()).toContain("refs/heads/main");
      expect(lookups).toEqual(["market.test", "market.test"]);
      const authorized = server.seen.find((request) => request.authorization);
      expect(Buffer.from(authorized!.authorization!.slice(6), "base64").toString()).toBe("x-access-token:s3cret-token");
    } finally {
      await t.cleanup();
    }
  });

  it("never gives a token to a ticket bound to another host", async () => {
    const t = await createRunner({ tokens: { "127.0.0.1": "s3cret-token", "localhost": "other" } });
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
  const https = normalizeSourceUrl("https://github.com/a/b");
  const ssh = normalizeSourceUrl("git@github.com:a/b.git");
  const sshOnPort = normalizeSourceUrl("ssh://git@git.example.com:2222/a/b");

  it.each([
    ["fatal: Authentication failed for 'https://github.com/a/b/'", false, https, "SOURCE_AUTH_REQUIRED", { reason: "token", host: "github.com" }],
    ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", false, ssh, "SOURCE_AUTH_REQUIRED", { reason: "ssh", host: "github.com" }],
    [
      "No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.",
      false,
      ssh,
      "SOURCE_SSH_HOST_UNKNOWN",
      { reason: "unknown", host: "github.com", port: 22 },
    ],
    ["fatal: couldn't find remote ref refs/heads/nope", false, https, "SOURCE_REF_NOT_FOUND", undefined],
    ["fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com", false, https, "SOURCE_UNREACHABLE", { reason: "dns", host: "github.com" }],
    ["ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known", false, ssh, "SOURCE_UNREACHABLE", { reason: "dns", host: "github.com" }],
    ["ssh: connect to host github.com port 22: Network is unreachable", false, ssh, "SOURCE_UNREACHABLE", { reason: "offline" }],
    ["fatal: unable to access 'https://github.com/a/b/': Failed to connect to github.com port 443 after 75003 ms: Timed out", false, https, "SOURCE_UNREACHABLE", { reason: "timeout", host: "github.com" }],
    ["fatal: unable to access 'https://github.com/a/b/': Failed to connect to github.com port 443 after 2 ms: Couldn't connect to server", false, https, "SOURCE_UNREACHABLE", { reason: "refused", host: "github.com" }],
    ["fatal: unable to access 'https://github.com/a/b/': SSL certificate problem: unable to get local issuer certificate", false, https, "SOURCE_UNREACHABLE", { reason: "tls", host: "github.com" }],
    ["fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 502", false, https, "SOURCE_UNREACHABLE", { reason: "http-status", host: "github.com", status: 502 }],
    // A host's "not found" is also its answer for a private repository: with Ave's token the token may not reach it,
    // without one the address may be wrong or the repository private; neither is claimed.
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", true, https, "SOURCE_AUTH_REQUIRED", { reason: "token-no-access", host: "github.com" }],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", false, https, "SOURCE_UNREACHABLE", { reason: "not-found", host: "github.com" }],
    ["fatal: unable to access 'https://git.example.com/a/b/': The requested URL returned error: 404", false, https, "SOURCE_UNREACHABLE", { reason: "not-found", host: "github.com" }],
    [
      "remote: The project you were looking for could not be found or you don't have permission to view it.\nfatal: repository 'https://github.com/a/b/' not found",
      false,
      https,
      "SOURCE_UNREACHABLE",
      { reason: "not-found", host: "github.com" },
    ],
    ["ERROR: Repository not found.\nfatal: Could not read from remote repository.", false, ssh, "SOURCE_UNREACHABLE", { reason: "not-found-ssh", host: "github.com" }],
    // An empty answer to the host's prompt is a refused sign-in, not a missing repository.
    ["remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/a/b/'", false, https, "SOURCE_AUTH_REQUIRED", { reason: "token", host: "github.com" }],
  ] as const)("%j", (stderr, offered, url, code, detail) => {
    const error = classifyRemoteFailure(stderr, offered, url, "git ls-remote failed");
    expect(error.code).toBe(code);
    expect(error.detail).toEqual(detail);
    expect(error.message).toBe("git ls-remote failed");
  });

  it("tells a changed host key from an unknown one, with the port ssh files it under", () => {
    const stderr = [
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
      "Host key for [git.example.com]:2222 has changed and you have requested strict checking.",
      "Host key verification failed.",
      "fatal: Could not read from remote repository.",
    ].join("\n");
    const error = classifyRemoteFailure(stderr, false, sshOnPort, "git fetch failed");
    expect(error.code).toBe("SOURCE_SSH_HOST_UNKNOWN");
    expect(error.detail).toEqual({ reason: "changed", host: "git.example.com", port: 2222 });
  });
});

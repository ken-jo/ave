import { once } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { en } from "../../../i18n/messages/en.js";
import { ko } from "../../../i18n/messages/ko.js";
import * as hostGitLaunch from "../../../shared/host-git.js";
import { canonicalWorkflowJson, outputHashOf } from "../../../shared/workflow-template-output.js";
import { configuredWorkflowPush, createHostGit, executeWorkflowPush, type HostGit } from "../host-git.js";
import { createRequestedOutputHooks, stageOutputIntake } from "../requested-outputs.js";
import { stageOf } from "./stage-fixtures.js";
import { pathToFileURL } from "node:url";
import { runBranch } from "../workspace-layout.js";
import { fixturePushRemote, gitFixture } from "./stage-git-fixture.js";

const RUN_ID = "approved-run";
const REF = `refs/heads/${runBranch(RUN_ID)}`;
const fixtures: ReturnType<typeof gitFixture>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.done();
});

function setup() {
  const fixture = gitFixture();
  fixtures.push(fixture);
  const onePath = join(fixture.base, "endpoint-one.git");
  const twoPath = join(fixture.base, "endpoint-two.git");
  const one = fixturePushRemote(fixture, onePath);
  const two = fixturePushRemote(fixture, twoPath);
  const { repo, userGit } = fixture;
  userGit(fixture.base, "init", "-q", "--bare", onePath);
  userGit(fixture.base, "init", "-q", "--bare", twoPath);
  const git = (...args: string[]) => userGit(repo, ...args);
  git("update-ref", REF, "HEAD");
  git("remote", "add", "origin", one);
  const real = createHostGit({ env: fixture.env });
  const refs = (url: string) => userGit(url === one ? onePath : twoPath, "for-each-ref", "--format=%(refname)");
  const bind = async (args: unknown = { remote: "origin" }, runner: HostGit = real) => {
    const result = await configuredWorkflowPush(runner, repo, RUN_ID, args);
    return "binding" in result ? result.binding : undefined;
  };
  const capture = async () => {
    const args = await bind();
    if (!args) throw new Error("Expected an approved push binding");
    return args;
  };
  const push = (args: object, runner: HostGit = real) => executeWorkflowPush(runner, repo, RUN_ID, { ...args }, () => true);
  return { fixture, one, two, onePath, git, real, refs, bind, capture, push, repo };
}

type PushFixture = ReturnType<typeof setup>;
const empty = (x: PushFixture) => {
  expect(x.refs(x.one)).toBe("");
  expect(x.refs(x.two)).toBe("");
};
function wrap(x: PushFixture, run: (args: readonly string[], next: () => ReturnType<HostGit["run"]>) => ReturnType<HostGit["run"]>): HostGit {
  return { ...x.real, run: (cwd, args, options) => run(args, () => x.real.run(cwd, args, options)) };
}

it("a push to a configured remote sends only ave/workflow/<run> to the same-named remote branch, with no tag and no other ref", async () => {
  const x = setup();
  x.git("tag", "-am", "Do not send", "local-only");
  x.git("config", "push.followTags", "true");
  const args = await x.capture();
  const result = await x.push(args);
  expect(result.status).toBe("done");
  expect(x.refs(x.one)).toBe(REF);
  expect(x.fixture.userGit(x.onePath, "rev-parse", REF)).toBe(args.sha);
  expect(x.refs(x.two)).toBe("");
});

it("sends no configured default push option to a receiver that advertises push options", async () => {
  const x = setup();
  x.git("config", "--add", "push.pushOption", "unapproved-repository-option");
  const runner = createHostGit({ env: { ...x.fixture.env, GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "push.pushOption", GIT_CONFIG_VALUE_0: "unapproved-command-option" } });
  x.fixture.userGit(x.onePath, "config", "receive.advertisePushOptions", "true");
  const trace = join(x.fixture.base, "packets");
  const launch = hostGitLaunch.spawnHostGitIfWorkspaceFree;
  vi.spyOn(hostGitLaunch, "spawnHostGitIfWorkspaceFree").mockImplementation((cwd, program, args, options, deadline) =>
    launch(cwd, program, args, args.includes("push") ? { ...options, env: { ...options.env, GIT_TRACE_PACKET: trace } } : options, deadline));
  const binding = await x.bind({ remote: "origin" }, runner);
  expect(binding).toBeDefined();
  expect((await x.push(binding ?? {}, runner)).status).toBe("done");
  const packets = readFileSync(trace, "utf8");
  expect(packets).toContain("push-options");
  expect(packets).not.toContain("unapproved-");
  expect(x.refs(x.one)).toBe(REF);
});

it.each(["absolute", "file URL", "relative"])("shows the local transport refusal at intake for an %s remote", async shape => {
  const x = setup();
  const remoteUrl = shape === "absolute" ? x.onePath : shape === "file URL" ? pathToFileURL(x.onePath).href : "../endpoint-one.git";
  x.git("remote", "set-url", "origin", remoteUrl);
  const decl = { kind: "external-write", owner: "host", ownerId: "host:git", toolName: "git_push" } as const;
  const intake = stageOutputIntake(createRequestedOutputHooks(x.real, { operands: vi.fn(), invoke: vi.fn() }), {
    stage: stageOf("review", { requestedOutputs: [decl] }), workspaceRoot: x.repo, repository: x.repo,
    run: { itemId: 1, runId: RUN_ID, runKey: RUN_ID },
  });
  await expect(intake.tool.execute({ toolName: decl.toolName, owner: decl.owner, ownerId: decl.ownerId,
    args: { remote: "origin" }, summary: "Publish run branch" }, { cwd: x.repo, metadata: {}, extraAllowedDirectories: [] }))
    .resolves.toMatchObject({ isError: true, output: expect.stringContaining('"reasonCode":"output-remote-local-unsupported"') });
  expect(intake.close()).toEqual([]);
  empty(x);
});

it("allows an HTTP header scoped to another host or repository at intake and dispatch", async () => {
  const x = setup();
  const url = "https://example.test/team/repo.git";
  x.git("remote", "set-url", "origin", url);
  x.git("config", "http.https://other.test/team.extraHeader", "X-Other: fixture");
  x.git("config", "http.https://example.test/another.extraHeader", "X-Other-Path: fixture");
  const push = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runner = wrap(x, (command, next) => command[0] === "push" ? push() : next());
  const binding = await x.capture();
  expect(binding.url).toBe(url);
  await expect(x.push(binding, runner)).resolves.toMatchObject({ status: "done" });
  expect(push).toHaveBeenCalledOnce();
});

it("treats a single-letter remote alias as SSH on POSIX and as local on Windows", async () => {
  const x = setup();
  const url = "g:team/repo.git";
  x.git("remote", "set-url", "origin", url);
  if (process.platform === "win32") {
    await expect(configuredWorkflowPush(x.real, x.repo, RUN_ID, { remote: "origin" }))
      .resolves.toEqual({ code: "output-remote-local-unsupported" });
  } else {
    await expect(x.bind()).resolves.toMatchObject({ url });
  }
});

it("uses the effective typed value of URL-scoped push booleans", async () => {
  const x = setup();
  const url = "https://example.test/team/repo.git";
  x.git("remote", "set-url", "origin", url);
  x.git("config", "http.https://example.test/.followRedirects", "no");
  x.git("config", "http.https://example.test/.saveCookies", "0");
  const push = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runner = wrap(x, (command, next) => command[0] === "push" ? push() : next());
  const binding = await x.capture();
  await expect(x.push(binding, runner)).resolves.toMatchObject({ status: "done" });
  x.git("config", "http.https://example.test/.followRedirects", "yes");
  await expect(x.bind()).resolves.toBeUndefined();
  await expect(x.push(binding, runner)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
  expect(push).toHaveBeenCalledOnce();
});

it("refuses an HTTP header configured for the approved URL before starting the transport", async () => {
  const x = setup();
  const url = "https://example.test/repo";
  x.git("remote", "set-url", "origin", url);
  const binding = await x.capture();
  x.git("config", "http.https://*.test.extraHeader", "X-Unapproved: fixture");
  await expect(x.bind()).resolves.toBeUndefined();
  const runner = wrap(x, async (command, next) => command[0] === "push" ? { code: 0, stdout: "", stderr: "" } : next());
  await expect(x.push(binding, runner)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
});

it("refuses a configured remote named like the approved literal URL", async () => {
  const x = setup();
  const binding = await x.capture();
  x.git("config", `remote.${binding.url}.url`, x.two);
  await expect(x.push(binding)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
  empty(x);
});

it("refuses a previously recorded local destination before transport", async () => {
  const x = setup();
  const binding = await x.capture();
  const push = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runner = wrap(x, (command, next) => command[0] === "push" ? push() : next());
  await expect(x.push({ ...binding, url: x.onePath }, runner))
    .resolves.toEqual({ status: "failed", detail: "output-remote-local-unsupported" });
  expect(push).not.toHaveBeenCalled();
  empty(x);
});

it("a request that names an unknown remote, or a URL, is refused remote-not-configured, which has an en and a ko message, and nothing is sent", async () => {
  const x = setup();
  for (const remote of ["unknown", "https://example.test/repo", x.one]) await expect(x.bind({ remote })).resolves.toBeUndefined();
  expect(en["reasonCodes.remote-not-configured"]).toBeTruthy();
  expect(ko["reasonCodes.remote-not-configured"]).toBeTruthy();
  empty(x);
});

it("a push whose remote branch has diverged is not forced: it ends failed as a non-fast-forward and the remote branch is unchanged", async () => {
  const x = setup();
  writeFileSync(join(x.repo, "a.txt"), "Diverged");
  const divergent = x.fixture.commitAll("An independent commit");
  x.git("push", x.onePath, `HEAD:${REF}`);
  const args = await x.capture();
  const outcome = await x.push(args);
  expect(outcome.status).toBe("failed");
  expect(JSON.parse(outcome.detail)).toMatchObject({ exit: "push-non-fast-forward" });
  expect(x.fixture.userGit(x.onePath, "rev-parse", REF)).toBe(divergent);
});

it("a push request in a folder-kind run is refused at request, and an execution of one ends failed and sends nothing", async () => {
  const x = setup();
  await expect(executeWorkflowPush(x.real, undefined, RUN_ID, { ...await x.capture() }, () => true))
    .resolves.toEqual({ status: "failed", detail: "remote-not-configured" });
  empty(x);
});

it("a remote removed after the approval ends the execution failed remote-not-configured", async () => {
  const x = setup();
  const args = await x.capture();
  x.git("remote", "remove", "origin");
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "remote-not-configured" });
  empty(x);
});

it("the stored args hold the resolved URL without its secrets, and another URL gives another outputHash", async () => {
  const x = setup();
  x.git("remote", "set-url", "origin", "https://account:synthetic-secret@example.test/repo");
  const one = await x.capture();
  expect(one.url).toBe("https://example.test/repo");
  x.git("remote", "set-url", "origin", "https://elsewhere.test/repo");
  const two = await x.capture();
  const hash = (args: object) => outputHashOf("Ready", [{
    id: "push", summary: "Deliver", decl: { kind: "external-write", owner: "host", ownerId: "host:git", toolName: "git_push" }, args: canonicalWorkflowJson(args),
  }]);
  expect(hash(one)).not.toBe(hash(two));
});

it("an https remote URL that carries a token is bound, shown and pushed without it, and the token is in no record and no log", async () => {
  const x = setup();
  x.git("remote", "set-url", "origin", "https://synthetic-token@example.test/repo");
  const args = await x.capture();
  const runner = wrap(x, async (command, next) => {
    if (command[0] !== "push") return next();
    expect(command).toContain("https://example.test/repo");
    expect(command.join(" ")).not.toContain("synthetic-token");
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(JSON.stringify(await x.push(args, runner))).not.toContain("synthetic-token");
});

it("an ssh:// remote and an scp-form remote keep their user name in the bound URL, on the card and in the git call", async () => {
  const x = setup();
  for (const [configured, url] of [
    ["ssh://git:synthetic-secret@example.test/repo", "ssh://git@example.test/repo"],
    ["git@example.test:team/repo.git", "git@example.test:team/repo.git"],
  ]) {
    x.git("remote", "set-url", "origin", configured);
    const args = await x.capture();
    expect(args.url).toBe(url);
    const runner = wrap(x, async (command, next) => {
      if (command[0] !== "push") return next();
      expect(command).toContain(url);
      return { code: 0, stdout: "", stderr: "" };
    });
    expect((await x.push(args, runner)).status).toBe("done");
  }
});

it("a remote whose URL was changed in the repository after the approval ends the execution failed with \"push failed: remote URL changed\" and sends nothing", async () => {
  const x = setup();
  const args = await x.capture();
  x.git("remote", "set-url", "origin", x.two);
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-url-changed" });
  empty(x);
});

it("a request that carries its own url is refused", async () => {
  const x = setup();
  await expect(x.bind({ remote: "origin", url: x.two })).resolves.toBeUndefined();
  empty(x);
});

it("the git call pushes the approved SHA to the bound branch using the compared URL", async () => {
  const x = setup();
  const binding = await x.capture();
  const runner = wrap(x, async (args, next) => {
    if (args[0] === "push") {
      expect(args.slice(-2)).toEqual([binding.url, `${binding.sha}:${REF}`]);
      expect(args).not.toContain("origin");
    }
    return next();
  });
  expect((await x.push(binding, runner)).status).toBe("done");
});

it("a remote whose URL is changed in the repository after the compare and before git runs still pushes to the approved URL and nothing reaches the new one", async () => {
  const x = setup();
  const runner = wrap(x, async (args, next) => {
    if (args[0] === "push") x.git("remote", "set-url", "origin", x.two);
    return next();
  });
  expect((await x.push(await x.capture(), runner)).status).toBe("done");
  expect(x.refs(x.one)).toBe(REF);
  expect(x.refs(x.two)).toBe("");
});

it("the push record is canonical JSON in OutputExecution.detail and holds no credential", async () => {
  const x = setup();
  const args = await x.capture();
  const result = await x.push(args);
  expect(result.detail).toBe(canonicalWorkflowJson({ remote: "origin", host: "example.test", branch: runBranch(RUN_ID), sha: args.sha, exit: "ok" }));
});

it("a changed run ref invalidates approval and nothing is sent", async () => {
  const x = setup();
  const args = await x.capture();
  writeFileSync(join(x.repo, "new"), "Different payload");
  x.fixture.commitAll("A later commit");
  x.git("update-ref", REF, "HEAD");
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-ref-changed" });
  empty(x);
});

it("the approved Git ref cannot move between the final verification and transport", async () => {
  const x = setup();
  const args = await x.capture();
  writeFileSync(join(x.repo, "new"), "Different payload");
  x.fixture.commitAll("A later commit");
  const runner = wrap(x, async (command, next) => {
    if (command[0] === "push") expect(() => x.git("update-ref", REF, "HEAD")).toThrow();
    return next();
  });
  expect((await x.push(args, runner)).status).toBe("done");
  expect(x.fixture.userGit(x.onePath, "rev-parse", REF)).toBe(args.sha);
});

it("cancels a push waiting on its final guard when the prepared lock process exits", async () => {
  const x = setup();
  const binding = await x.capture();
  writeFileSync(join(x.repo, "new"), "Different payload");
  x.fixture.commitAll("A later commit");
  const guardReached = deferred<void>();
  const resumeGuard = deferred<void>();
  const callbackReturned = deferred<void>();
  const prepared = deferred<Exclude<ReturnType<typeof hostGitLaunch.spawnHostGitIfWorkspaceFree>, string>>();
  const launch = hostGitLaunch.spawnHostGitIfWorkspaceFree;
  vi.spyOn(hostGitLaunch, "spawnHostGitIfWorkspaceFree").mockImplementation((...args) => {
    const child = launch(...args);
    if (typeof child !== "string" && args[2].includes("update-ref")) prepared.resolve(child);
    return child;
  });
  const real = x.real;
  let pushStarted = false;
  const runner: HostGit = { ...real, run: (cwd, command, options) => {
    if (command[0] === "update-ref" && options?.holdPreparedRef) {
      const holdPreparedRef = options.holdPreparedRef;
      return real.run(cwd, command, { ...options, holdPreparedRef: async (...args) => {
        try { await holdPreparedRef(...args); } finally { callbackReturned.resolve(); }
      } });
    }
    if (command[0] === "config") {
      guardReached.resolve();
      return resumeGuard.promise.then(() => real.run(cwd, command, options));
    }
    if (command[0] === "push") pushStarted = true;
    return real.run(cwd, command, options);
  } };
  const outcome = x.push(binding, runner);
  try {
    await guardReached.promise;
    const lock = await prepared.promise;
    const exited = once(lock, "exit");
    lock.stdin?.end("abort\n");
    await exited;
    x.git("update-ref", REF, "HEAD");
  } finally {
    resumeGuard.resolve();
    await callbackReturned.promise;
  }
  await expect(outcome).resolves.toMatchObject({ status: "failed", detail: "push-ref-changed" });
  expect(pushStarted).toBe(false);
  empty(x);
});

it("terminates a running transport before returning from a lost prepared lock", async () => {
  const x = setup();
  const binding = await x.capture();
  type Child = Exclude<ReturnType<typeof hostGitLaunch.spawnHostGitIfWorkspaceFree>, string>;
  const prepared = deferred<Child>();
  const transportReady = deferred<Child>();
  const launch = hostGitLaunch.spawnHostGitIfWorkspaceFree;
  let transportExited = false;
  vi.spyOn(hostGitLaunch, "spawnHostGitIfWorkspaceFree").mockImplementation((cwd, program, args, options, deadline) => {
    if (args.includes("push")) {
      const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? "node";
      const transport = launch(cwd, node, ["-e", "console.log('ready'); setInterval(() => {}, 1_000)"], options, deadline);
      if (typeof transport !== "string") {
        transport.on("exit", () => { transportExited = true; });
        transport.stdout?.once("data", () => transportReady.resolve(transport));
      }
      return transport;
    }
    const child = launch(cwd, program, args, options, deadline);
    if (typeof child !== "string" && args.includes("update-ref")) prepared.resolve(child);
    return child;
  });
  const outcome = x.push(binding);
  const transport = await transportReady.promise;
  const lock = await prepared.promise;
  try {
    lock.stdin?.end("abort\n");
    await expect(outcome).resolves.toMatchObject({ status: "failed", detail: "push-ref-changed" });
    expect(transportExited).toBe(true);
  } finally {
    if (!transportExited) {
      const exit = once(transport, "exit");
      transport.kill("SIGKILL");
      await exit;
    }
  }
  empty(x);
});

describe.each(["insteadOf", "pushInsteadOf"] as const)("%s", rule => {
  it("with a rewrite rule the bound and displayed URL is the rewritten push URL, and the push reaches exactly that endpoint", async () => {
    const x = setup();
    x.git("remote", "set-url", "origin", "alias:one");
    x.git("config", `url.${x.one}.${rule}`, "alias:one");
    const args = await x.capture();
    expect(args.url).toBe(x.one);
    expect((await x.push(args)).status).toBe("done");
    expect(x.refs(x.one)).toBe(REF);
    expect(x.refs(x.two)).toBe("");
  });

  it("a rewrite rule added, removed or changed after the approval ends the execution failed with \"push failed: remote URL changed\" and nothing is sent", async () => {
    const x = setup();
    x.git("remote", "set-url", "origin", "alias:one");
    x.git("config", `url.${x.one}.${rule}`, "alias:one");
    const args = await x.capture();
    x.git("config", "--unset", `url.${x.one}.${rule}`);
    x.git("config", `url.${x.two}.${rule}`, "alias:one");
    await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-url-changed" });
    empty(x);
  });
});

function stableAlias(x: PushFixture, rule: "insteadOf" | "pushInsteadOf") {
  if (rule === "insteadOf") {
    x.git("remote", "set-url", "origin", "alias:one");
    x.git("config", `url.${x.one}.insteadOf`, "alias:one");
  } else {
    x.git("remote", "set-url", "--push", "origin", x.one);
  }
}

it.each([
  { rule: "insteadOf", title: "an insteadOf rule whose value is a prefix of U, added after the approval, leaves the remote's resolved URL equal to U, is refused by the guard, and no repository receives a ref" },
  { rule: "pushInsteadOf", title: "a pushInsteadOf rule whose value is a prefix of U, added after the approval, leaves the remote's resolved URL equal to U, is refused by the guard, and no repository receives a ref" },
] as const)("$title", async ({ rule }) => {
    const x = setup();
    stableAlias(x, rule);
    const args = await x.capture();
    x.git("config", `url.${x.two}.${rule}`, x.one);
    expect(x.git("remote", "get-url", "--push", "origin")).toBe(args.url);
    await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
    empty(x);
    x.git("push", args.url, `${REF}:${REF}`);
    expect(x.refs(x.one)).toBe("");
    expect(x.refs(x.two)).toBe(REF);
  },
);

it.each([
  { rule: "insteadOf", title: "when U is the result of an insteadOf rule and matches a second insteadOf rule at request, the request is refused remote-not-configured and nothing reaches the gate" },
  { rule: "pushInsteadOf", title: "when U is the result of a pushInsteadOf rule and matches a second pushInsteadOf rule at request, the request is refused remote-not-configured and nothing reaches the gate" },
] as const)("$title", async ({ rule }) => {
    const x = setup();
    stableAlias(x, rule);
    x.git("config", `url.${x.two}.${rule}`, x.one);
    await expect(x.bind()).resolves.toBeUndefined();
    const ignoreRules = wrap(x, (args, next) => args[0] === "config" ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : next());
    const bound = await x.bind({ remote: "origin" }, ignoreRules);
    expect(bound?.url).toBe(x.one);
    await expect(x.push(bound ?? {})).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
    empty(x);
  },
);

it("a rule that comes from a conditional include which applies only inside the project directory, added after the approval, leaves the remote's resolved URL equal to U, is refused by the guard, and the same read from another directory does not see it", async () => {
  const x = setup();
  stableAlias(x, "insteadOf");
  const args = await x.capture();
  const include = join(x.fixture.base, "included.conf");
  writeFileSync(include, `[url "${x.two}"]\n  insteadOf = ${x.one}\n`);
  appendFileSync(x.fixture.env.GIT_CONFIG_GLOBAL ?? "", `[includeIf "gitdir:${x.repo}/.git"]\n  path = ${include}\n`);
  expect(x.git("remote", "get-url", "--push", "origin")).toBe(args.url);
  const command = ["config", "--includes", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"];
  await expect(x.real.run(x.fixture.base, command)).resolves.toMatchObject({ code: 1, stdout: "" });
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
  empty(x);
});

it("a rule that matches U but is not the longest match still refuses", async () => {
  const x = setup();
  stableAlias(x, "insteadOf");
  const args = await x.capture();
  x.git("config", `url.${x.two}.insteadOf`, x.one);
  x.git("config", `url.${x.two}.pushInsteadOf`, "ssh://example.test/");
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
  empty(x);
});

it("a rule whose value differs from the start of U only in letter case does not refuse, and the push reaches U", async () => {
  const x = setup();
  const args = await x.capture();
  x.git("config", `url.${x.two}.insteadOf`, x.one.toUpperCase());
  expect((await x.push(args)).status).toBe("done");
  expect(x.refs(x.one)).toBe(REF);
  expect(x.refs(x.two)).toBe("");
});

it("with no rewrite rule at all the read exits 1 with empty output, is read as no rules, and the push reaches U", async () => {
  const x = setup();
  const runner = wrap(x, async (args, next) => {
    const result = await next();
    if (args[0] === "config") expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
    return result;
  });
  expect((await x.push(await x.capture(), runner)).status).toBe("done");
  expect(x.refs(x.one)).toBe(REF);
});

const failedReads = [
  ["exits 128", { code: 128, stdout: "", stderr: "Config failed" }],
  ["returns another exit code", { code: 2, stdout: "", stderr: "" }],
  ["exits 1 with output", { code: 1, stdout: "unexpected", stderr: "" }],
  ["returns output that cannot be parsed", { code: 0, stdout: "not-a-record\0", stderr: "" }],
  ["times out", new Error("Timeout")],
  ["could not be started", new Error("Launch failed")],
] as const;

it.each(failedReads.map(([label, response]) => ({
  title: `a rule read that ${label} ends the execution failed with "push failed: push URL could not be verified" and pushes nothing`, response,
})))("$title", async ({ response }) => {
  const x = setup();
  const args = await x.capture();
  const runner = wrap(x, (command, next) => command[0] !== "config" ? next() : response instanceof Error ? Promise.reject(response) : Promise.resolve(response));
  expect(x.git("remote", "get-url", "--push", "origin")).toBe(args.url);
  await expect(x.bind({ remote: "origin" }, runner)).resolves.toBeUndefined();
  await expect(x.push(args, runner)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
  empty(x);
});

it("a rule read that exits 128, or fails in any other way, refuses the request remote-not-configured and nothing reaches the gate", async () => {
  const x = setup();
  for (const [, response] of failedReads) {
    const runner = wrap(x, (command, next) => command[0] !== "config" ? next() : response instanceof Error ? Promise.reject(response) : Promise.resolve(response));
    await expect(x.bind({ remote: "origin" }, runner)).resolves.toBeUndefined();
  }
  empty(x);
});

it('a compare mismatch never shows the guard\'s text, and a guard refusal and a read failure never show "push failed: remote URL changed"', async () => {
  const x = setup();
  stableAlias(x, "insteadOf");
  const args = await x.capture();
  x.git("config", `url.${x.two}.insteadOf`, x.one);
  expect((await x.push(args)).detail).toBe("push-url-unverified");
  const unreadable = wrap(x, (command, next) => command[0] === "config" ? Promise.resolve({ code: 128, stdout: "", stderr: "" }) : next());
  expect((await x.push(args, unreadable)).detail).toBe("push-url-unverified");
  x.git("remote", "set-url", "origin", x.two);
  expect((await x.push(args, unreadable)).detail).toBe("push-url-changed");
  empty(x);
});

it("a rule read that exits 1 with empty output lets the request through", async () => {
  const x = setup();
  await expect(x.bind()).resolves.toMatchObject({ url: x.one });
});

it('a configuration file that git cannot parse, written after the approval, ends the execution failed with "push failed: push URL could not be verified" and pushes nothing', async () => {
  const x = setup();
  const args = await x.capture();
  appendFileSync(join(x.repo, ".git", "config"), "[broken configuration\n");
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
  empty(x);
});

it("an https remote whose URL has a user name, with a rule on the URL without it at request, is refused remote-not-configured: the rule does not match at resolution and matches the stripped U", async () => {
  const x = setup();
  x.git("remote", "set-url", "origin", "https://alice@example.test/repo");
  x.git("config", `url.${x.two}.insteadOf`, "https://example.test/repo");
  expect(x.git("remote", "get-url", "--push", "origin")).toBe("https://alice@example.test/repo");
  await expect(x.bind()).resolves.toBeUndefined();
  empty(x);
});

it("the same rule added after the approval leaves the remote's resolved URL unchanged and is refused by the guard", async () => {
  const x = setup();
  x.git("remote", "set-url", "origin", "https://alice@example.test/repo");
  const args = await x.capture();
  x.git("config", `url.${x.two}.insteadOf`, args.url);
  expect(x.git("remote", "get-url", "--push", "origin")).toBe("https://alice@example.test/repo");
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "push-url-unverified" });
  empty(x);
});

it('"push failed: push URL could not be verified" and "push failed: remote URL changed" each have an en and a ko message', () => {
  expect(en["reasonCodes.push-url-unverified"]).toBe("push failed: push URL could not be verified");
  expect(en["reasonCodes.push-url-changed"]).toBe("push failed: remote URL changed");
  expect(ko["reasonCodes.push-url-unverified"]).toBe("푸시 실패: 푸시 URL을 확인할 수 없음");
  expect(ko["reasonCodes.push-url-changed"]).toBe("푸시 실패: 원격 URL이 변경됨");
});

it("the https accounts help text has an en and a ko message", () => {
  expect(en["workflowTemplates.pushHttpsAccountsHelp"]).toContain("credential helper keyed by path");
  expect(ko["workflowTemplates.pushHttpsAccountsHelp"]).toContain("경로별 자격 증명 도우미");
});

it("a remote with two push URLs is refused remote-not-configured at request and nothing reaches the gate", async () => {
  const x = setup();
  x.git("remote", "set-url", "--add", "--push", "origin", x.one);
  x.git("remote", "set-url", "--add", "--push", "origin", x.two);
  await expect(x.bind()).resolves.toBeUndefined();
  empty(x);
});

it("a second push URL added after the approval ends the execution failed remote-not-configured and neither bare repository receives a ref", async () => {
  const x = setup();
  x.git("remote", "set-url", "--add", "--push", "origin", x.one);
  const args = await x.capture();
  x.git("remote", "set-url", "--add", "--push", "origin", x.two);
  await expect(x.push(args)).resolves.toEqual({ status: "failed", detail: "remote-not-configured" });
  empty(x);
});

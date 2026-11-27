import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { en } from "../../../i18n/messages/en.js";
import { canonicalWorkflowJson } from "../../../shared/workflow-template-output.js";
import { configuredWorkflowPush, createHostGit, executeWorkflowPush } from "../host-git.js";
import { runBranch } from "../workspace-layout.js";
import { gitFixture } from "./stage-git-fixture.js";

const ALICE_SECRET = "fixture-alice-credential";
const BOB_SECRET = "fixture-bob-credential";
const RUN_ID = "accounts";
const REF = `refs/heads/${runBranch(RUN_ID)}`;

function receive(fixture: ReturnType<typeof gitFixture>, request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "https://localhost");
  const git = spawn("git", ["http-backend"], { env: {
    ...fixture.env, GIT_PROJECT_ROOT: fixture.base, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "alice",
    PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
    CONTENT_TYPE: request.headers["content-type"], CONTENT_LENGTH: request.headers["content-length"],
  } });
  let headers: Buffer = Buffer.alloc(0);
  const readHeaders = (chunk: Buffer) => {
    headers = Buffer.concat([headers, chunk]);
    const boundary = headers.indexOf("\r\n\r\n");
    if (boundary === -1) return;
    git.stdout.off("data", readHeaders);
    for (const entry of headers.subarray(0, boundary).toString().split("\r\n")) {
      const [name, ...value] = entry.split(":");
      const text = value.join(":").trim();
      if (name.toLowerCase() === "status") response.statusCode = Number.parseInt(text, 10);
      else if (name) response.setHeader(name, text);
    }
    response.write(headers.subarray(boundary + 4));
    git.stdout.pipe(response);
  };
  git.stdout.on("data", readHeaders);
  git.stderr.resume();
  git.on("error", () => response.destroy());
  git.stdin.on("error", () => response.destroy());
  git.on("close", () => { if (!response.writableEnded) response.end(); });
  request.pipe(git.stdin);
}

async function withAccounts(
  body: (fixture: ReturnType<typeof gitFixture>, endpoint: string, requests: string[]) => Promise<void>,
  acceptAlice = false,
) {
  const fixture = gitFixture();
  const key = join(fixture.base, "key.pem");
  const cert = join(fixture.base, "cert.pem");
  const requests: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
      const credential = Buffer.from(request.headers.authorization?.replace(/^Basic /u, "") ?? "", "base64").toString();
      requests.push(credential);
      if (acceptAlice && credential === `alice:${ALICE_SECRET}`) {
        receive(fixture, request, response);
        return;
      }
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback endpoint");
    const endpoint = `https://localhost:${address.port}/repo.git`;
    const git = (...args: string[]) => fixture.userGit(fixture.repo, ...args);
    git("update-ref", REF, "HEAD");
    git("config", "http.sslCAInfo", cert);
    git("remote", "add", "origin", endpoint.replace("://", "://alice@"));
    if (acceptAlice) fixture.userGit(fixture.base, "init", "-q", "--bare", join(fixture.base, "repo.git"));
    await body(fixture, endpoint, requests);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server?.close(() => resolve()));
    }
    await fixture.done();
  }
}

function installHelper(fixture: ReturnType<typeof gitFixture>, endpoint: string): string {
  const script = join(fixture.base, "helper.sh");
  const trace = join(fixture.base, "helper.log");
  writeFileSync(script, `#!/bin/sh
if [ "$1" = get ]; then
  request=$(cat)
  printf '%s\\n' "$request" >> "${trace}"
  case "$request" in
    *username=*) printf 'username=bob\\npassword=${BOB_SECRET}\\n' ;;
    *) printf 'username=alice\\npassword=${ALICE_SECRET}\\n' ;;
  esac
fi
`, { mode: 0o700 });
  const git = (...args: string[]) => fixture.userGit(fixture.repo, ...args);
  git("config", "credential.helper", `!"${script}"`);
  git("config", `credential.${endpoint.replace("://", "://alice@")}.username`, "bob");
  return trace;
}

it('a push that would need a credential prompt fails with "push failed: authentication" and does not hang', () => withAccounts(async (fixture, endpoint, requests) => {
  const git = createHostGit({ env: { ...fixture.env, GIT_ASKPASS: "invalid-askpass-program" }, timeoutMs: 2_000 });
  const binding = await configuredWorkflowPush(git, fixture.repo, RUN_ID, { remote: "origin" });
  expect(binding?.url).toBe(endpoint);
  const result = await executeWorkflowPush(git, fixture.repo, RUN_ID, { ...binding }, () => true);
  expect(result.status).toBe("failed");
  expect(JSON.parse(result.detail)).toMatchObject({ exit: { code: "push-authentication" } });
  expect(requests).toEqual([""]);
}), 10_000);

it('the push of a remote whose https URL names alice asks the helper with the URL without a user name, and ends in one of two ways: it uses the credential the fixture configures for that URL, or it ends failed with "push failed: authentication"', () => withAccounts(async (fixture, endpoint, requests) => {
  const trace = installHelper(fixture, endpoint);
  const runner = createHostGit({ env: fixture.env, timeoutMs: 2_000 });
  const resolved = await configuredWorkflowPush(runner, fixture.repo, RUN_ID, { remote: "origin" });
  expect(resolved?.url).toBe(endpoint);
  const result = await executeWorkflowPush(runner, fixture.repo, RUN_ID, { ...resolved }, () => true);
  const observed = readFileSync(trace, "utf8");
  expect(observed).toContain("protocol=https");
  expect(observed).not.toContain("username=");
  expect(observed.match(/protocol=https/gu)).toHaveLength(1);
  expect(requests).toEqual(["", `alice:${ALICE_SECRET}`]);
  expect(requests.join(" ")).not.toContain(BOB_SECRET);
  expect(result.status).toBe("failed");
  expect(JSON.parse(result.detail)).toMatchObject({ remote: "origin", host: "localhost", branch: runBranch(RUN_ID), sha: resolved?.sha, exit: { code: "push-authentication" } });
  expect(result.detail).toBe(canonicalWorkflowJson(JSON.parse(result.detail)));
  expect(JSON.stringify({ resolved, result, observed })).not.toContain(ALICE_SECRET);
  expect(JSON.stringify({ resolved, result, observed })).not.toContain(BOB_SECRET);
  expect(en["reasonCodes.push-authentication"]).toBe("push failed: authentication");
}), 10_000);

it("after a push through a credential helper, and after a failed one, the run record, the audit log and the logs hold no credential and no password or token from a URL; the record holds only the remote name, the URL host, the branch, the pushed SHA and the exit result", async () => {
  for (const succeeds of [true, false]) {
    await withAccounts(async (fixture, endpoint, requests) => {
      const trace = installHelper(fixture, endpoint);
      const runner = createHostGit({ env: fixture.env, timeoutMs: 3_000 });
      const binding = await configuredWorkflowPush(runner, fixture.repo, RUN_ID, { remote: "origin" });
      const result = await executeWorkflowPush(runner, fixture.repo, RUN_ID, { ...binding }, () => true);
      expect(result.status).toBe(succeeds ? "done" : "failed");
      if (succeeds) expect(fixture.userGit(join(fixture.base, "repo.git"), "rev-parse", REF)).toBe(binding?.sha);
      const receipt = JSON.parse(result.detail);
      expect(Object.keys(receipt).sort()).toEqual(["branch", "exit", "host", "remote", "sha"]);
      expect(JSON.stringify({ binding, receipt })).not.toContain(ALICE_SECRET);
      expect(JSON.stringify({ binding, receipt })).not.toContain(BOB_SECRET);
      expect(readFileSync(trace, "utf8").match(/protocol=https/gu)).toHaveLength(1);
      expect(requests.join(" ")).not.toContain(BOB_SECRET);
    }, succeeds);
  }
}, 15_000);

it.each([
  { title: "git never prompts and the call ends inside the timeout", verify: (value: AccountObservation) => expect(value.elapsed).toBeLessThan(3_000) },
  { title: "the helper is asked for one push attempt and nothing is retried", verify: (value: AccountObservation) => expect(value.helper.match(/protocol=https/gu)).toHaveLength(1) },
  { title: "bob's secret is never sent to the endpoint", verify: (value: AccountObservation) => expect(value.requested.join(" ")).not.toContain(BOB_SECRET) },
  { title: "neither secret is in the run record, the audit log, the logs or the card text", verify: (value: AccountObservation) => {
    expect(value.hostText).not.toContain(ALICE_SECRET);
    expect(value.hostText).not.toContain(BOB_SECRET);
  } },
])("$title", ({ verify }) => withAccounts(async (fixture, endpoint, requested) => {
  const trace = installHelper(fixture, endpoint);
  const runner = createHostGit({ env: { ...fixture.env, GIT_ASKPASS: "invalid-askpass-program" }, timeoutMs: 3_000 });
  const binding = await configuredWorkflowPush(runner, fixture.repo, RUN_ID, { remote: "origin" });
  const now = performance.now();
  const result = await executeWorkflowPush(runner, fixture.repo, RUN_ID, { ...binding }, () => true);
  expect(result.status).toBe("failed");
  const helper = readFileSync(trace, "utf8");
  verify({ elapsed: performance.now() - now, helper, requested, hostText: JSON.stringify({ binding, result, helper }) });
}), 10_000);

interface AccountObservation {
  elapsed: number;
  helper: string;
  requested: string[];
  hostText: string;
}

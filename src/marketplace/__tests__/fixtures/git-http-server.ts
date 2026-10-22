/**
 * Test fixture: a loopback git smart-HTTP server backed by `git http-backend`.
 *
 * Marketplace git calls refuse the file protocol, so tests reach local
 * repositories the way the app reaches real hosts — over HTTP, with protocol
 * v2, partial-clone filters and object-id fetches enabled on the served repos.
 * The server can demand a token, redirect, or hang, and records what it saw.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitFixtureEnv } from "../../../__tests__/support/git-fixture-env.mjs";

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>/<name>` for a repository under the server root. */
  url(name: string): string;
  readonly origin: string;
  readonly seen: SeenRequest[];
  /** Answer every request for `name` with a redirect to `location`. */
  redirect(name: string, location: string): void;
  /** Never answer requests for `name`. */
  hang(name: string): void;
  /** Answer GET `path` with `body` (release assets, archives); `null` removes it. */
  file(path: string, body: Buffer | null, status?: number): void;
  close(): Promise<void>;
}

export interface GitHttpServerOptions {
  root: string;
  /** Require HTTP Basic auth whose password equals this token. */
  token?: string;
}

function hostGitEnv(): NodeJS.ProcessEnv {
  return { ...gitFixtureEnv(join(tmpdir(), `ave-git-http-${process.pid}`)), LC_ALL: "C" };
}

/**
 * Run the host git for fixture setup and inspection (outside the marketplace
 * contract), with an environment of its own: a git hook runs tests with
 * `GIT_DIR` set, which would otherwise point every call at the app's checkout.
 */
export function hostGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: hostGitEnv(), encoding: "utf8" }).trim();
}

export interface FixtureRepo {
  /** Bare repository served by the server. */
  bare: string;
  /** Working clone used to author commits. */
  work: string;
  commit(files: Record<string, string | Buffer>, message: string): string;
  /**
   * Commit an exact tree built with plumbing, for entries a checkout cannot
   * hold (case-only duplicates on macOS, symlinks, gitlinks). Replaces the
   * working clone's index; returns the pushed commit.
   */
  commitEntries(entries: ReadonlyArray<{ path: string; mode: string; content?: string; oid?: string }>, message: string): string;
  /** Replace the served history with the working clone's (force push). */
  forcePush(): void;
}

/** Create `<root>/<name>` (bare, served) and a working clone to author commits in. */
export function createFixtureRepo(root: string, name: string, branch = "main"): FixtureRepo {
  const bare = join(root, name);
  mkdirSync(dirname(bare), { recursive: true });
  hostGit(["init", "--bare", "--quiet", `--initial-branch=${branch}`, bare]);
  hostGit(["config", "uploadpack.allowFilter", "true"], bare);
  hostGit(["config", "uploadpack.allowAnySHA1InWant", "true"], bare);
  hostGit(["config", "http.receivepack", "false"], bare);
  const work = mkdtempSync(join(tmpdir(), "ave-fixture-work-"));
  hostGit(["init", "--quiet", `--initial-branch=${branch}`, work]);
  hostGit(["config", "user.email", "fixture@example.invalid"], work);
  hostGit(["config", "user.name", "Fixture"], work);
  hostGit(["remote", "add", "origin", bare], work);
  return {
    bare,
    work,
    commit(files, message) {
      for (const [path, content] of Object.entries(files)) {
        const target = join(work, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      hostGit(["add", "--all"], work);
      hostGit(["commit", "--quiet", "--allow-empty", "-m", message], work);
      hostGit(["push", "--quiet", "origin", `HEAD:${branch}`], work);
      return hostGit(["rev-parse", "HEAD"], work);
    },
    commitEntries(entries, message) {
      hostGit(["read-tree", "--empty"], work);
      for (const entry of entries) {
        const oid = entry.oid ?? execFileSync("git", ["hash-object", "-w", "--stdin"], {
          cwd: work,
          env: hostGitEnv(),
          input: entry.content ?? "",
          encoding: "utf8",
        }).trim();
        // Tree entries only: Git for Windows would refuse names like `odd:name` for a checkout.
        hostGit(["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `${entry.mode},${oid},${entry.path}`], work);
      }
      const tree = hostGit(["write-tree"], work);
      const parent = hostGit(["rev-parse", "HEAD"], work);
      const commit = hostGit(["commit-tree", tree, "-p", parent, "-m", message], work);
      hostGit(["update-ref", "HEAD", commit], work);
      hostGit(["push", "--quiet", "origin", `HEAD:${branch}`], work);
      return commit;
    },
    forcePush() {
      hostGit(["push", "--quiet", "--force", "origin", `HEAD:${branch}`], work);
    },
  };
}

/**
 * Async `rm`: Electron's `rmSync` refuses the read-only object files git writes on Windows.
 * Retries ride out the brief EBUSY a just-exited git child can leave on the work dir.
 */
export async function removeFixtureRepo(repo: FixtureRepo): Promise<void> {
  await rm(repo.work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1) === token;
}

function serveBackend(root: string, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const child = spawn("git", ["http-backend"], {
    env: {
      ...hostGitEnv(),
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(url.pathname),
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: url.search.replace(/^\?/u, ""),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
      ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0);
  let headersDone = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    headersDone = true;
    let status = 200;
    for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else res.setHeader(name, value);
    }
    res.writeHead(status);
    res.write(head.subarray(end + 4));
  });
  child.on("close", () => res.end());
}

export async function startGitHttpServer(options: GitHttpServerOptions): Promise<GitHttpServer> {
  const seen: SeenRequest[] = [];
  const redirects = new Map<string, string>();
  const hanging = new Set<string>();
  const files = new Map<string, { body: Buffer; status: number }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ method: req.method ?? "GET", path: url.pathname, authorization: req.headers.authorization });
    const file = files.get(url.pathname);
    if (file) {
      res.writeHead(file.status, { "content-type": "application/octet-stream", "content-length": String(file.body.byteLength) });
      res.end(file.body);
      return;
    }
    const repo = url.pathname.split("/")[1] ?? "";
    if (hanging.has(repo)) return;
    const location = redirects.get(repo);
    if (location) {
      res.writeHead(302, { location });
      res.end();
      return;
    }
    if (!authorized(req, options.token)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' });
      res.end();
      return;
    }
    serveBackend(options.root, req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    seen,
    url: (name) => `${origin}/${name}`,
    redirect: (name, location) => redirects.set(name, location),
    hang: (name) => hanging.add(name),
    file: (path, body, status = 200) => {
      if (body === null) files.delete(path);
      else files.set(path, { body, status });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

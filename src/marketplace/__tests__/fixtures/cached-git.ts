import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { GitResult, GitRunner, RunGitOptions } from "../../git/run-git.js";

/** Only the read forms emitted by BareRepo; other commands execute normally. */
function isRepositoryRead(args: readonly string[]): boolean {
  const oid = (value: string | undefined) => /^[0-9a-f]{40}$/u.test(value ?? "");
  switch (args[0]) {
    case "rev-parse":
      return args.length === 4 && args[1] === "--verify" && args[2] === "--end-of-options"
        && /^(?:refs\/ave\/[a-zA-Z0-9_-]+|[0-9a-f]{40})\^\{commit\}$/u.test(args[3]!);
    case "cat-file":
      return args.length === 3 && ["-s", "-t", "blob"].includes(args[1]!) && oid(args[2]);
    case "log":
      return args.length === 4 && args[1] === "-1" && args[2] === "--format=%cI" && oid(args[3]);
    case "merge-base":
      return args.length === 4 && args[1] === "--is-ancestor" && oid(args[2]) && oid(args[3]);
    case "ls-tree": {
      const index = args[3] === "-r" ? 4 : 3;
      return args[1] === "-z" && args[2] === "--full-tree" && oid(args[index])
        && (args.length === index + 1 || (args.length === index + 3 && args[index + 1] === "--"));
    }
    case "rev-list":
      return args.slice(1, 5).join(" ") === "--objects --missing=print --no-walk --sparse"
        && oid(args[5]) && args[6] === "--" && args.length > 7;
    case "archive":
      return args.length === 4 && args[1] === "--format=tar" && args[2]!.startsWith("--prefix=")
        && /^[0-9a-f]{40}(?::.*|\^\{tree\})$/u.test(args[3]!);
    default:
      return false;
  }
}

/**
 * Read real, prebuilt fixture repositories through an in-process transport.
 * Their complete object stores and requested HEAD refs are copied to clients.
 * Immutable object reads share results; ref resolution and missing-object
 * reads include the inventory. Sources must be complete, idle FixtureRepo
 * publications, and clients own ordinary refs/ave/* refs exclusively.
 *
 * This is for service orchestration tests: transport and process lifecycle
 * cases must use the underlying runner. Errors and unknown commands are never
 * replayed. Every client still owns its repository and all installed files.
 * This transport installs objects and a target ref; filtering, FETCH_HEAD,
 * negotiation and process cancellation remain on the real runner.
 */
export function cachedFixtureGit(runner: GitRunner, servedRoot: string, origin: string, cacheRoot: string): Pick<GitRunner, "run" | "preflight"> {
  mkdirSync(cacheRoot, { recursive: true });
  const reads = new Map<string, GitResult>();
  const fetches = new Map<string, { dir: string; head: Buffer }>();
  let sequence = 0;
  let initialized: Promise<string> | undefined;

  // Object names encode their bytes. Ref contents encode their current target.
  function inventory(dir: string, includeRefs = true): string {
    const hash = createHash("sha256");
    function walk(path: string, contents: boolean) {
      if (!existsSync(path)) return;
      for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        hash.update(JSON.stringify([path.slice(dir.length), item.name, item.isDirectory()]));
        if (item.isDirectory()) walk(join(path, item.name), contents);
        else if (contents) hash.update(readFileSync(join(path, item.name)));
      }
    }
    walk(join(dir, "objects"), false);
    if (includeRefs) walk(join(dir, "refs"), true);
    for (const name of [...(includeRefs ? ["HEAD", "packed-refs"] : []), "config", "shallow", "info/attributes", "objects/info/alternates"]) {
      const path = join(dir, name);
      if (existsSync(path)) hash.update(readFileSync(path));
    }
    return hash.digest("hex");
  }

  function deliver(result: GitResult, options: RunGitOptions): GitResult {
    options.signal?.throwIfAborted();
    const stdout = Buffer.from(result.stdout);
    if (options.onStdout) {
      options.onStdout(stdout);
      return { stdout: Buffer.alloc(0), stderr: result.stderr };
    }
    return { stdout, stderr: result.stderr };
  }

  async function record(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
    const chunks: Buffer[] = [];
    const result = await runner.run(args, { ...options, ...(options.onStdout ? { onStdout: (chunk: Buffer) => chunks.push(Buffer.from(chunk)) } : {}) });
    return { ...result, stdout: options.onStdout ? Buffer.concat(chunks) : result.stdout };
  }

  return {
    preflight: (remote) => runner.preflight(remote),
    async run(args, options) {
      options.signal?.throwIfAborted();
      if (args[0] === "init" && args[1] === "--bare" && args[2] === "--quiet" && args.length === 4) {
        initialized ??= (async () => {
          const dir = join(cacheRoot, "empty");
          await runner.run([...args.slice(0, 3), dir], options);
          return dir;
        })().catch((error) => {
          initialized = undefined;
          throw error;
        });
        cpSync(await initialized, args[3]!, { recursive: true });
        return { stdout: Buffer.alloc(0), stderr: "" };
      }
      const fetchShape = args.slice(0, 6).join("\0") === ["fetch", "--filter=blob:none", "--no-tags", "--quiet", "--", options.remote?.url.url].join("\0")
        && args.length === 7 && /^\+HEAD:refs\/ave\/[a-zA-Z0-9_-]+$/u.test(args[6]!);
      if (fetchShape && options.remote && options.gitDir) {
        const url = new URL(options.remote.url.url);
        // Other hosts retain real transport behavior, including refusal paths.
        if (url.origin !== origin || !/^\/[a-z]+-\d+$/u.test(url.pathname)) return runner.run(args, options);
        const source = join(servedRoot, url.pathname.slice(1));
        const branch = readFileSync(join(source, "HEAD"), "utf8").trim().match(/^ref: (refs\/heads\/[a-zA-Z0-9_-]+)$/u)?.[1];
        if (!branch || !existsSync(join(source, branch))) return runner.run(args, options);
        const key = JSON.stringify([inventory(source), args.map((arg) => arg === options.remote!.url.url ? "<fixture>" : arg)]);
        let entry = fetches.get(key);
        if (!entry) {
          const dir = join(cacheRoot, `fetch-${++sequence}`);
          mkdirSync(dir);
          cpSync(join(source, "objects"), join(dir, "objects"), { recursive: true, force: false });
          entry = { head: readFileSync(join(source, branch)), dir };
          fetches.set(key, entry);
        }
        options.signal?.throwIfAborted();
        // Fetch adds objects and updates only the requested refs. Replaying an
        // entire client tree would overwrite unrelated refs from an older call.
        cpSync(join(entry.dir, "objects"), join(options.gitDir, "objects"), { recursive: true, force: false });
        for (const refspec of args.slice(args.indexOf("--") + 2)) {
          const target = refspec.match(/^\+[^:]+:(refs\/[a-zA-Z0-9/_-]+)$/u)?.[1];
          if (!target) continue; // Object-id fetches do not update a local ref.
          const dest = join(options.gitDir, target);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, entry.head);
        }
        return deliver({ stdout: Buffer.alloc(0), stderr: "" }, options);
      }
      // Only the read forms emitted by BareRepo are replayable. In particular,
      // path-reporting rev-parse and archive --output must still execute.
      if (!options.remote && options.gitDir && existsSync(join(options.gitDir, "objects")) && isRepositoryRead(args)) {
        const immutable = ["ls-tree", "cat-file", "log", "merge-base", "archive"].includes(args[0]!);
        const oids = args.flatMap((arg) => arg.match(/^[0-9a-f]{40}(?=$|:|\^)/u) ?? []);
        const complete = oids.length > 0 && oids.every((oid) => existsSync(join(options.gitDir!, "objects", oid.slice(0, 2), oid.slice(2))));
        const externalState = ["shallow", "info/attributes", "objects/info/alternates"].some((path) => existsSync(join(options.gitDir!, path)));
        const identity = immutable && complete && !externalState
          ? ["immutable", readFileSync(join(options.gitDir, "config"), "utf8")]
          : inventory(options.gitDir, args[0] !== "rev-list");
        const key = JSON.stringify([identity, args, options.maxStdoutBytes]);
        let result = reads.get(key);
        if (!result) {
          result = await record(args, options);
          reads.set(key, result);
        }
        return deliver(result, options);
      }
      return runner.run(args, options);
    },
  };
}

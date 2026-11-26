import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMainBoundaryBundle, repositoryRoot } from "../../plugins/isolation/__tests__/child-entry-bundle.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { inspectGitRepository } from "../rules/git-repository-inputs.js";

const paths = vi.hoisted(() => ({ mainDir: "" }));
vi.mock("../../main/main-paths.js", () => ({ get mainDir() { return paths.mainDir; } }));

type Client = typeof import("../rules/git-repository-inspection-client.js");
const WORKER_SOURCE = "src/permissions/rules/git-repository-inspection-worker-main.ts";
const ORDINARY_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";
/**
 * Repository evidence is produced only on POSIX hosts. On win32 the inspection needs the
 * host's native path-pinning helper, which neither this suite nor the worker thread has, so
 * both sides refuse; the verified path never reaches it there, because no verified Git is registered.
 */
const EVIDENCE_HOST = process.platform !== "win32";
let builtWorkerDir: string;
let root: string;
let cwd: string;
let client: Client;

/** The shipped worker entry, bundled through the main-process build boundary. */
beforeAll(async () => {
  mkdirSync(join(repositoryRoot(), ".cache"), { recursive: true });
  builtWorkerDir = mkdtempSync(join(repositoryRoot(), ".cache", "git-inspection-worker-"));
  await buildMainBoundaryBundle({
    entryPoints: { "git-repository-inspection-worker": join(repositoryRoot(), WORKER_SOURCE) },
    outdir: builtWorkerDir,
    splitting: false,
  });
  copyFileSync(join(builtWorkerDir, "git-repository-inspection-worker.mjs"), join(builtWorkerDir, "git-repository-inspection-worker.js"));
});
afterAll(() => rmSync(builtWorkerDir, { recursive: true, force: true }));

function repository(path: string): string {
  mkdirSync(join(path, ".git", "objects", "info"), { recursive: true });
  mkdirSync(join(path, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(path, ".git", "config"), ORDINARY_CONFIG);
  return path;
}

/** A stand-in worker for transport failures; `behaviour` receives each request. */
function standInWorker(behaviour: string): string {
  const directory = mkdtempSync(join(root, "stand-in-"));
  writeFileSync(join(directory, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(directory, "git-repository-inspection-worker.js"),
    `const { parentPort } = require("node:worker_threads");\nparentPort.on("message", (request) => { ${behaviour} });\n`);
  return directory;
}

/**
 * Ancestor directories are shared with other test workers, and the fingerprint covers their
 * identity. Compare the worker with in-process inspections taken on both sides of it, and
 * retry only when that window was itself disturbed.
 */
async function inspectInStableWindow(path: string, requireEvidence = false) {
  let last: { actual: unknown; expected: unknown } | undefined;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (attempt > 0) await new Promise((settle) => setTimeout(settle, 20));
    const before = inspectGitRepository(path);
    const actual = await client.inspectGitRepositoryAsync(path);
    const after = inspectGitRepository(path);
    last = { actual, expected: before };
    // A deterministic mismatch fails every attempt; only a disturbed window is retried.
    // A refusal of an admitted repository means the window was disturbed, never parity.
    const disturbed = requireEvidence && (before === null || actual === null);
    if (!disturbed && JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(actual) === JSON.stringify(before)) return last;
  }
  if (last === undefined) throw new Error("No comparison ran");
  return last;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "git-inspection-client-")));
  cwd = repository(join(root, "workspace"));
  paths.mainDir = builtWorkerDir;
  vi.resetModules();
  client = await import("../rules/git-repository-inspection-client.js");
});
afterEach(() => {
  vi.useRealTimers();
  client.disposeGitRepositoryInspectionWorker();
  rmSync(root, { recursive: true, force: true });
});

describe("repository inspection worker", () => {
  const PARITY_CASES: readonly [string, () => void][] = [
    ["ordinary metadata", () => {}],
    ["loose refs and packed refs", () => {
      for (let index = 0; index < 40; index += 1) writeFileSync(join(cwd, ".git", "refs", "heads", `branch-${index}`), `${"a".repeat(40)}\n`);
      writeFileSync(join(cwd, ".git", "packed-refs"), `# pack-refs with: peeled\n${"b".repeat(40)} refs/tags/v1\n`);
    }],
    ["unsupported configuration", () => writeFileSync(join(cwd, ".git", "config"), "[include]\n\tpath = /outside\n")],
    ["metadata pointer file", () => { rmSync(join(cwd, ".git"), { recursive: true }); writeFileSync(join(cwd, ".git"), `gitdir: ${root}\n`); }],
    ["object alternates", () => writeFileSync(join(cwd, ".git", "objects", "info", "alternates"), root)],
    ["hard-linked metadata", () => linkSync(join(cwd, ".git", "HEAD"), join(root, "head-alias"))],
    ["symbolic ref link", () => { mkdirSync(join(root, "outside")); symlinkSync(join(root, "outside"), join(cwd, ".git", "refs", "heads", "linked"), "junction"); }],
    ["missing metadata", () => rmSync(join(cwd, ".git"), { recursive: true })],
    ["nested repository data", () => { mkdirSync(join(cwd, ".git", "modules", "nested"), { recursive: true }); writeFileSync(join(cwd, ".git", "modules", "nested", "config"), ORDINARY_CONFIG); }],
  ];

  const EVIDENCE_CASES = new Set(["ordinary metadata", "loose refs and packed refs"]);

  it.each(PARITY_CASES)("returns the in-process inspection result: %s", async (name, arrange) => {
    arrange();
    const admitted = EVIDENCE_HOST && EVIDENCE_CASES.has(name);
    const { actual, expected } = await inspectInStableWindow(cwd, admitted);
    // Admitted repositories must yield evidence on both sides, so two refusals cannot pass as parity.
    if (admitted) {
      expect(expected).not.toBeNull();
      expect(actual).not.toBeNull();
    }
    if (!EVIDENCE_HOST) {
      // Both sides refuse, and the refusal comes from the inspection itself, not from the transport.
      expect(expected).toBeNull();
      expect(actual).toBeNull();
      expect(client.lastGitRepositoryInspectionRefusal()).toBeUndefined();
    }
    expect(actual).toEqual(expected);
  });

  it("refuses unsupported root spelling", async () => {
    for (const path of ["relative", "", "invalid\0cwd"]) expect(await client.inspectGitRepositoryAsync(path)).toBeNull();
  });

  it("correlates replies by request id when the worker answers out of order", async () => {
    // Holds every request, then answers in reverse order with a result naming the request's own cwd.
    paths.mainDir = standInWorker(`globalThis.held ??= []; globalThis.held.push(request);
      if (globalThis.held.length === 6) for (const held of globalThis.held.reverse()) parentPort.postMessage({ id: held.id,
        result: { gitDirectory: held.cwd + "/.git", workTree: held.cwd, referenceBackend: "files", stateFingerprint: "fingerprint:" + held.cwd } });`);
    const requested = Array.from({ length: 6 }, (_, index) => `/request-${index}`);
    const results = await Promise.all(requested.map((path) => client.inspectGitRepositoryAsync(path)));
    expect(results.map((result) => result?.stateFingerprint)).toEqual(requested.map((path) => `fingerprint:${path}`));
    expect(client.lastGitRepositoryInspectionRefusal()).toBeUndefined();
  });

  it("answers concurrent inspections of real repositories on one resident worker", async () => {
    const workspaces = Array.from({ length: 6 }, (_, index) => repository(join(root, `workspace-${index}`)));
    for (const [index, workspace] of workspaces.entries()) writeFileSync(join(workspace, ".git", "refs", "heads", `only-${index}`), `${"c".repeat(40)}\n`);
    let results: Awaited<ReturnType<Client["inspectGitRepositoryAsync"]>>[] = [];
    if (!EVIDENCE_HOST) {
      results = await Promise.all(workspaces.map((workspace) => client.inspectGitRepositoryAsync(workspace)));
      expect(results).toEqual(workspaces.map(() => null));
      expect(client.lastGitRepositoryInspectionRefusal()).toBeUndefined();
      return;
    }
    for (let attempt = 0; attempt < 25 && !(results.length > 0 && results.every((result) => result !== null)); attempt += 1) {
      if (attempt > 0) await new Promise((settle) => setTimeout(settle, 20));
      results = await Promise.all(workspaces.map((workspace) => client.inspectGitRepositoryAsync(workspace)));
    }
    // Each reply names the work tree it inspected, so a crossed reply cannot go unnoticed.
    expect(results.map((result) => result?.workTree)).toEqual(workspaces);
    expect(new Set(results.map((result) => result?.stateFingerprint)).size).toBe(workspaces.length);
  });

  it("yields the main thread while the worker inspects", async () => {
    // The worker blocks its own thread for 200 ms, as a slow inspection would. A fast real
    // inspection (win32 refuses at once) can answer before an immediate runs, so timing a
    // real reply would race; a blocked worker proves the main thread keeps turning.
    paths.mainDir = standInWorker(
      "const until = Date.now() + 200; while (Date.now() < until) {} parentPort.postMessage({ id: request.id, result: null });");
    let turns = 0;
    const ticker = setInterval(() => { turns += 1; }, 10);
    const inspection = client.inspectGitRepositoryAsync("blocked");
    expect(turns).toBe(0);
    expect(await inspection).toBeNull();
    clearInterval(ticker);
    expect(turns).toBeGreaterThan(5);
  });

  it("refuses a request whose reply misses the named deadline and replaces the worker", async () => {
    paths.mainDir = standInWorker(`if (request.cwd !== "hold") parentPort.postMessage({ id: request.id, result: null });`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = client.inspectGitRepositoryAsync("hold");
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.gitRepositoryInspectionMs);
    expect(await held).toBeNull();
    expect(client.lastGitRepositoryInspectionRefusal()).toBe("timeout");
    vi.useRealTimers();
    expect(await client.inspectGitRepositoryAsync("answered")).toBeNull();
    expect(client.lastGitRepositoryInspectionRefusal()).toBe("timeout");
  });

  it("refuses every request owned by a crashed worker and restarts on the next request", async () => {
    const crashing = standInWorker(`if (request.cwd === "crash") process.exit(3); parentPort.postMessage({ id: request.id, result: null });`);
    paths.mainDir = crashing;
    const owned = [client.inspectGitRepositoryAsync("crash"), client.inspectGitRepositoryAsync("second")];
    expect(await Promise.all(owned)).toEqual([null, null]);
    expect(client.lastGitRepositoryInspectionRefusal()).toBe("worker-failed");
    paths.mainDir = builtWorkerDir;
    const { actual, expected } = await inspectInStableWindow(cwd);
    expect(actual).toEqual(expected);
  });

  it.each([
    ["an unknown id", `parentPort.postMessage({ id: request.id + 1000, result: null });`],
    ["a forged result", `parentPort.postMessage({ id: request.id, result: { gitDirectory: "/x", workTree: "/x", referenceBackend: "files", stateFingerprint: "f", extra: true } });`],
    ["a non-object reply", `parentPort.postMessage("ready");`],
    ["a thrown request handler", `throw new Error("handler failed");`],
  ])("refuses %s and retires the worker", async (_name, behaviour) => {
    paths.mainDir = standInWorker(behaviour);
    expect(await client.inspectGitRepositoryAsync(cwd)).toBeNull();
    expect(["malformed-reply", "worker-failed"]).toContain(client.lastGitRepositoryInspectionRefusal());
    paths.mainDir = builtWorkerDir;
    const { actual, expected } = await inspectInStableWindow(cwd);
    expect(actual).toEqual(expected);
  });

  it("refuses a missing worker entry and does not start another worker for it", async () => {
    const { Worker } = await import("node:worker_threads");
    paths.mainDir = join(root, "no-build");
    expect(await client.inspectGitRepositoryAsync(cwd)).toBeNull();
    expect(client.lastGitRepositoryInspectionRefusal()).toBe("worker-entry-missing");
    const started = vi.spyOn(Worker.prototype, "postMessage");
    for (let attempt = 0; attempt < 3; attempt += 1) expect(await client.inspectGitRepositoryAsync(cwd)).toBeNull();
    expect(client.lastGitRepositoryInspectionRefusal()).toBe("worker-entry-missing");
    expect(started).not.toHaveBeenCalled();
    started.mockRestore();
    paths.mainDir = builtWorkerDir;
    const { actual, expected } = await inspectInStableWindow(cwd);
    expect(actual).toEqual(expected);
  });

  it("bounds the queue and refuses requests beyond it without queuing them", async () => {
    paths.mainDir = standInWorker(`globalThis.held ??= []; globalThis.held.push(request.id);`);
    const held = Array.from({ length: client.MAX_PENDING_GIT_REPOSITORY_INSPECTIONS }, (_, index) => client.inspectGitRepositoryAsync(`held-${index}`));
    expect(await client.inspectGitRepositoryAsync("overflow")).toBeNull();
    expect(client.lastGitRepositoryInspectionRefusal()).toBe("queue-full");
    client.disposeGitRepositoryInspectionWorker();
    expect(await Promise.all(held)).toEqual(held.map(() => null));
  });
});

describe("packaged repository inspection worker", () => {
  it("is a main-bundle root entry that the package footprint check requires", async () => {
    const { MAIN_ENTRY_POINTS } = await import("../../../scripts/lib/main-entry-points.mjs");
    expect(MAIN_ENTRY_POINTS["git-repository-inspection-worker"]).toBe("src/permissions/rules/git-repository-inspection-worker-main.ts");
    const budget = createRequire(import.meta.url)("../../../scripts/lib/main-bundle-budget.mjs") as {
      MAIN_BUNDLE_ROOT_FILES: readonly string[]; isSafeMainBundleManifestPath(path: string): boolean;
    };
    expect(budget.MAIN_BUNDLE_ROOT_FILES).toContain(client.GIT_REPOSITORY_INSPECTION_WORKER_FILE);
    expect(budget.isSafeMainBundleManifestPath(client.GIT_REPOSITORY_INSPECTION_WORKER_FILE)).toBe(true);
    const packaged = JSON.parse(readFileSync(join(repositoryRoot(), "package.json"), "utf8")) as { build: { files: string[] } };
    expect(packaged.build.files).toContain("dist/**/*");
  });

  it("bundles without desktop-only dependencies", () => {
    const bundle = readFileSync(join(builtWorkerDir, "git-repository-inspection-worker.js"), "utf8");
    expect(bundle).not.toMatch(/from\s*["']electron["']|require\(["']electron["']\)/);
  });
});

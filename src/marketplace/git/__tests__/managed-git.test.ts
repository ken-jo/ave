import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { c as createTar } from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import { NetworkGate } from "../../net/network-gate.js";
import { createPinnedFetch } from "../../net/pinned-fetch.js";
import { policySource } from "../../__tests__/fixtures/policy.js";
import { parseSourcePattern } from "../../net/source-url.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../sources/policy.js";
import type { GitRuntimeProgress } from "../../../shared/git-runtime.js";
import { findManagedGit, installManagedGit, managedGitLayout, managedRunnerOptions } from "../managed-git.js";
import { MANAGED_GIT, type ManagedGitPins } from "../managed-git-pins.js";

const VERSION = "2.53.0";
const SMOKE_OID = createHash("sha1").update("blob 16\0ave managed git\n").digest("hex");
const KEY = `${process.platform}-${process.arch}`;

/** A stand-in for the copy: answers --version and hash-object like git would. */
function fakeGitScript(version = VERSION, oid = SMOKE_OID): string {
  return `#!/bin/sh\ncase "$1" in\n  --version) echo "git version ${version}" ;;\n  hash-object) cat >/dev/null; echo "${oid}" ;;\n  *) exit 1 ;;\nesac\n`;
}

async function buildArchive(dir: string, name: string, layout: (root: string) => void): Promise<Buffer> {
  const root = join(dir, `${name}-src`);
  mkdirSync(root, { recursive: true });
  layout(root);
  const file = join(dir, `${name}.tar.gz`);
  await createTar({ gzip: true, cwd: root, file, portable: true }, readdirSync(root).map((entry) => `./${entry}`));
  return readFileSync(file);
}

function put(root: string, path: string, content: string, mode = 0o644): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  chmodSync(target, mode);
}

function standardLayout(script = fakeGitScript()) {
  return (root: string) => {
    put(root, "bin/git", script, 0o755);
    put(root, "libexec/git-core/git", script, 0o755);
    put(root, "libexec/git-core/git-remote-http", "#!/bin/sh\nexit 0\n", 0o755);
    symlinkSync("git-remote-http", join(root, "libexec/git-core/git-remote-https"));
    symlinkSync("git", join(root, "libexec/git-core/git-fetch"));
    put(root, "ssl/cacert.pem", "-----BEGIN CERTIFICATE-----\nSHIPPED\n-----END CERTIFICATE-----\n");
  };
}

describe.skipIf(process.platform === "win32")("managed git install", () => {
  let dir: string;
  let runtimeRoot: string;
  let server: Server;
  let origin: string;
  const bodies = new Map<string, { bytes: Buffer; mode: "full" | "truncate" | "extra" | "stall" }>();
  const gate = new NetworkGate({ policy: policySource({ ok: true, policy: EMPTY_MARKETPLACE_POLICY, path: "/fixture/ave-policy.json" }), allowLoopback: true, transport: createPinnedFetch() });
  const download = (url: string, signal?: AbortSignal) => gate.fetch(url, { official: true, catalog: null, ...(signal ? { signal } : {}) });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = bodies.get(req.url ?? "");
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      if (body.mode === "stall") {
        res.writeHead(200, { "content-length": String(body.bytes.length) });
        res.write(body.bytes.subarray(0, Math.floor(body.bytes.length / 2)));
        return;
      }
      if (body.mode === "truncate") {
        res.writeHead(200, { "content-length": String(body.bytes.length) });
        res.write(body.bytes.subarray(0, Math.floor(body.bytes.length / 2)));
        res.socket?.destroy();
        return;
      }
      const bytes = body.mode === "extra" ? Buffer.concat([body.bytes, Buffer.from("trailing")]) : body.bytes;
      res.writeHead(200, { "content-length": String(bytes.length) }).end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-managed-git-"));
    runtimeRoot = join(dir, "runtime", "git");
    bodies.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function serve(path: string, bytes: Buffer, mode: "full" | "truncate" | "extra" | "stall" = "full"): ManagedGitPins {
    bodies.set(path, { bytes, mode });
    return { version: VERSION, assets: { [KEY]: { url: `${origin}${path}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } } };
  }

  async function install(pins: ManagedGitPins, extra: { force?: boolean; downloadStallMs?: number } = {}) {
    const progress: GitRuntimeProgress[] = [];
    try {
      const installed = await installManagedGit({ runtimeRoot, download, pins, onProgress: (item) => progress.push(item), ...extra });
      return { installed, progress, error: null as MarketplaceError | null };
    } catch (error) {
      return { installed: null, progress, error: error as MarketplaceError };
    }
  }

  function phases(progress: GitRuntimeProgress[]): string[] {
    return progress.map((item) => item.phase).filter((phase, index, all) => phase !== all[index - 1]);
  }

  function leftovers(): string[] {
    return existsSync(runtimeRoot) ? readdirSync(runtimeRoot).filter((name) => name.startsWith(".")) : [];
  }

  it("downloads, verifies, extracts, smoke-tests and publishes the pinned copy", async () => {
    const pins = serve("/git.tar.gz", await buildArchive(dir, "good", standardLayout()));
    const { installed, progress, error } = await install(pins);
    expect(error).toBeNull();
    expect(phases(progress)).toEqual(["checking", "downloading", "verifying", "extracting", "smoke-testing", "ready"]);
    const downloads = progress.filter((item) => item.phase === "downloading");
    expect(downloads[downloads.length - 1]).toEqual({ phase: "downloading", bytes: pins.assets[KEY]!.size, total: pins.assets[KEY]!.size });
    const root = join(runtimeRoot, VERSION);
    expect(installed).toEqual({ path: join(root, "bin", "git"), root, version: { major: 2, minor: 53, patch: 0, text: "2.53.0" } });
    expect(readlinkSync(join(root, "libexec/git-core/git-remote-https"))).toBe("git-remote-http");
    expect(await findManagedGit(runtimeRoot, process.platform, pins)).toEqual(installed);
    expect(leftovers()).toEqual([]);

    // An installed copy is returned without downloading again.
    bodies.clear();
    const again = await install(pins);
    expect(again.error).toBeNull();
    expect(phases(again.progress)).toEqual(["checking", "ready"]);
  });

  it.each([
    ["a wrong hash", "verifying", async (_bytes: Buffer, pins: ManagedGitPins) => ({ ...pins, assets: { [KEY]: { ...pins.assets[KEY]!, sha256: "0".repeat(64) } } })],
    ["a truncated download", "downloading", async (bytes: Buffer) => serve("/short.tar.gz", bytes, "truncate")],
    ["a body longer than pinned", "downloading", async (bytes: Buffer) => serve("/long.tar.gz", bytes, "extra")],
    ["a missing asset", "downloading", async (_bytes: Buffer, pins: ManagedGitPins) => ({ ...pins, assets: { [KEY]: { ...pins.assets[KEY]!, url: `${origin}/missing.tar.gz` } } })],
  ])("fails on %s in the %s phase and leaves nothing behind", async (_label, phase, variant) => {
    const bytes = await buildArchive(dir, "good", standardLayout());
    const pins = await variant(bytes, serve("/git.tar.gz", bytes));
    const { error, progress } = await install(pins);
    expect(error?.code).toBe("GIT_RUNTIME_INSTALL_FAILED");
    expect(error?.detail).toEqual({ reason: phase });
    expect(progress[progress.length - 1]).toMatchObject({ phase: "failed", code: "GIT_RUNTIME_INSTALL_FAILED" });
    expect(existsSync(join(runtimeRoot, VERSION))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ["a symlink that leaves its directory", (root: string) => {
      standardLayout()(root);
      symlinkSync("../../../etc/passwd", join(root, "libexec/git-core/escape"));
    }, "is not a sibling", "extracting"],
    ["an absolute symlink", (root: string) => {
      standardLayout()(root);
      symlinkSync("/etc/passwd", join(root, "bin/escape"));
    }, "is not a sibling", "extracting"],
    ["a hard link", (root: string) => {
      standardLayout()(root);
      linkSync(join(root, "bin/git"), join(root, "bin/git-hard"));
    }, "unsupported entry type Link", "extracting"],
    ["a copy that reports another version", standardLayout(fakeGitScript("2.52.0")), "reports git version 2.52.0", "smoke-testing"],
    ["a copy that hashes wrongly", standardLayout(fakeGitScript(VERSION, "f".repeat(40))), "hashed a blob as", "smoke-testing"],
    ["a copy without the https helper", (root: string) => {
      put(root, "bin/git", fakeGitScript(), 0o755);
      put(root, "libexec/git-core/git", fakeGitScript(), 0o755);
    }, "no https transport helper", "smoke-testing"],
  ])("refuses %s", async (_label, layout, message, phase) => {
    const pins = serve("/bad.tar.gz", await buildArchive(dir, "bad", layout));
    const { error } = await install(pins);
    expect(error?.code).toBe("GIT_RUNTIME_INSTALL_FAILED");
    expect(error?.message).toContain(message);
    expect(error?.detail).toEqual({ reason: phase });
    expect(existsSync(join(runtimeRoot, VERSION))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("fails a download whose body stops arriving instead of waiting for it", async () => {
    const bytes = await buildArchive(dir, "good", standardLayout());
    const { error } = await install(serve("/stall.tar.gz", bytes, "stall"), { downloadStallMs: 200 });
    expect(error).toMatchObject({ code: "GIT_RUNTIME_INSTALL_FAILED", message: expect.stringContaining("stalled"), detail: { reason: "downloading" } });
    expect(leftovers()).toEqual([]);
  });

  it("keeps a working copy when a forced reinstall fails, and replaces it when one succeeds", async () => {
    const good = serve("/git.tar.gz", await buildArchive(dir, "good", standardLayout()));
    const { installed } = await install(good);
    const marker = readFileSync(join(installed!.root, ".ave-ready.json"), "utf8");

    const broken = serve("/broken.tar.gz", Buffer.from("not a tar archive at all"));
    const failed = await install(broken, { force: true });
    expect(failed.error?.code).toBe("GIT_RUNTIME_INSTALL_FAILED");
    expect(failed.error?.detail).toEqual({ reason: "extracting" });
    expect(readFileSync(join(installed!.root, ".ave-ready.json"), "utf8")).toBe(marker);
    expect(await findManagedGit(runtimeRoot, process.platform, good)).toEqual(installed);

    const replacement = serve("/git2.tar.gz", await buildArchive(dir, "good2", (root) => {
      standardLayout()(root);
      put(root, "share/new-file", "new\n");
    }));
    const replaced = await install(replacement, { force: true });
    expect(replaced.error).toBeNull();
    expect(existsSync(join(runtimeRoot, VERSION, "share/new-file"))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("names the final move as the failing phase when the copy cannot be put in place", async () => {
    const pins = serve("/git.tar.gz", await buildArchive(dir, "good", standardLayout()));
    const progress: GitRuntimeProgress[] = [];
    const error = await installManagedGit({
      runtimeRoot,
      download,
      pins,
      // A dangling link where the copy goes: `existsSync` misses it, so nothing is moved aside, and the rename fails.
      onProgress: (item) => {
        progress.push(item);
        if (item.phase === "smoke-testing") symlinkSync(join(dir, "nowhere"), join(runtimeRoot, VERSION));
      },
    }).catch((failure: unknown) => failure as MarketplaceError);
    expect(error).toMatchObject({ code: "GIT_RUNTIME_INSTALL_FAILED", message: expect.stringContaining("cannot move the new copy into place"), detail: { reason: "installing" } });
    expect(progress[progress.length - 1]).toMatchObject({ phase: "failed", code: "GIT_RUNTIME_INSTALL_FAILED" });
    expect(leftovers()).toEqual([]);
  });

  it("shares one install between concurrent callers", async () => {
    const pins = serve("/git.tar.gz", await buildArchive(dir, "good", standardLayout()));
    const [a, b] = await Promise.all([
      installManagedGit({ runtimeRoot, download, pins }),
      installManagedGit({ runtimeRoot, download, pins }),
    ]);
    expect(a).toEqual(b);
  });

  it("does not count a directory without the ready marker", async () => {
    mkdirSync(join(runtimeRoot, VERSION, "bin"), { recursive: true });
    writeFileSync(join(runtimeRoot, VERSION, "bin", "git"), fakeGitScript());
    expect(await findManagedGit(runtimeRoot, process.platform, { version: VERSION, assets: {} })).toBeNull();
  });

  it("refuses a platform without a pinned build", async () => {
    const { error } = await install({ version: VERSION, assets: {} });
    expect(error?.message).toContain(`no managed git build for ${KEY}`);
    expect(error?.detail).toEqual({ reason: "checking" });
  });
});

describe("managed git runner settings", () => {
  const install = { path: "/r/bin/git", root: "/r", version: { major: 2, minor: 53, patch: 0, text: "2.53.0" } };

  it("uses the keychain on macOS and the certificate store through schannel on Windows", async () => {
    expect(await managedRunnerOptions(install, "darwin", "PEM")).toEqual({
      managedEnv: { GIT_EXEC_PATH: join("/r", "libexec", "git-core") },
      managedConfig: {},
    });
    const windows = managedGitLayout("C:\\ave\\git", "win32");
    expect(windows.config).toEqual({ "http.sslBackend": "schannel" });
    expect(windows.executable).toBe(join("C:\\ave\\git", "cmd", "git.exe"));
    expect(windows.pathPrefix).toEqual([join("C:\\ave\\git", "mingw64", "bin"), join("C:\\ave\\git", "usr", "bin")]);
  });

  it.skipIf(process.platform === "win32")("adds corporate roots to the shipped bundle on Linux", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-managed-ca-"));
    try {
      put(root, "ssl/cacert.pem", "SHIPPED\n");
      const linux = { ...install, root, path: join(root, "bin", "git") };
      expect((await managedRunnerOptions(linux, "linux", null)).managedEnv).toEqual({
        GIT_EXEC_PATH: join(root, "libexec", "git-core"),
        GIT_SSL_CAINFO: join(root, "ssl", "cacert.pem"),
      });
      const withCorp = await managedRunnerOptions(linux, "linux", "CORP\n");
      expect(readFileSync(withCorp.managedEnv!.GIT_SSL_CAINFO!, "utf8")).toBe("SHIPPED\nCORP\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins a build for every supported desktop platform", () => {
    expect(Object.keys(MANAGED_GIT.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    for (const asset of Object.values(MANAGED_GIT.assets)) {
      expect(asset.url).toMatch(/^https:\/\/github\.com\/desktop\/dugite-native\/releases\/download\/v2\.53\.0-4\//u);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe("managed git download policy", () => {
  it("reports a policy block as such, not as an install failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-managed-policy-"));
    try {
      const blocked = new NetworkGate({
        policy: policySource({ ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, block: [parseSourcePattern("host:github.com")] }, path: "/fixture/ave-policy.json" }),
        allowLoopback: false,
        transport: createPinnedFetch(),
      });
      const error = await installManagedGit({
        runtimeRoot: join(dir, "git"),
        download: (url) => blocked.fetch(url, { official: true, catalog: null }),
        pins: { version: VERSION, assets: { [KEY]: { url: MANAGED_GIT.assets["darwin-arm64"]!.url, sha256: "0".repeat(64), size: 1 } } },
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(MarketplaceError);
      expect((error as MarketplaceError).code).toBe("SOURCE_POLICY_BLOCKED");
      expect((error as MarketplaceError).detail?.reason).toBe("blocked-by-pattern");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

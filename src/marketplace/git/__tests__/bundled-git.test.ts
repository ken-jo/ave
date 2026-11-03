import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_RUNTIME_MARKER, GIT_RUNTIME_VERSION } from "../../../../scripts/git-runtime-targets.mjs";
import { bundledGitRoot, bundledRunnerOptions, findBundledGit } from "../bundled-git.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-bundled-git-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stageLinuxCopy(version: string = GIT_RUNTIME_VERSION): string {
  const root = join(dir, "linux-x64");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "ssl"), { recursive: true });
  writeFileSync(join(root, "bin", "git"), "");
  writeFileSync(join(root, "ssl", "cacert.pem"), "SHIPPED\n");
  writeFileSync(join(root, GIT_RUNTIME_MARKER), JSON.stringify({ version }));
  return root;
}

describe("bundledGitRoot", () => {
  it("names the copy under the app resources, and none on macOS", () => {
    expect(bundledGitRoot("/r", "linux", "x64")).toBe(join("/r", "git-runtime", "linux-x64"));
    expect(bundledGitRoot("/r", "win32", "arm64")).toBe(join("/r", "git-runtime", "win32-arm64"));
    expect(bundledGitRoot("/r", "darwin", "arm64")).toBeNull();
  });
});

describe("findBundledGit", () => {
  it("accepts a copy whose marker names the pinned version", async () => {
    const root = stageLinuxCopy();
    expect(await findBundledGit(root, "linux")).toEqual({ path: join(root, "bin", "git"), root });
  });

  it("refuses a missing root, a missing or foreign marker, and a missing binary", async () => {
    expect(await findBundledGit(null, "linux")).toBeNull();
    expect(await findBundledGit(join(dir, "absent"), "linux")).toBeNull();
    expect(await findBundledGit(stageLinuxCopy("2.40.0"), "linux")).toBeNull();
    const root = stageLinuxCopy();
    rmSync(join(root, "bin", "git"));
    expect(await findBundledGit(root, "linux")).toBeNull();
  });
});

describe("bundledRunnerOptions", () => {
  it("writes the corporate-root bundle outside the copy and leaves the copy unchanged", async () => {
    const root = stageLinuxCopy();
    const before = readdirSync(root, { recursive: true }).sort();
    const envRoot = join(dir, "env");
    mkdirSync(envRoot);
    const options = await bundledRunnerOptions({ path: join(root, "bin", "git"), root }, "linux", "CORPORATE\n", envRoot);
    const bundle = options.bundledEnv?.GIT_SSL_CAINFO;
    expect(bundle).toBe(join(envRoot, "bundled-git-ca-bundle.pem"));
    expect(readFileSync(bundle!, "utf8")).toBe("SHIPPED\nCORPORATE\n");
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(join(root, "ssl", "cacert.pem"), "utf8")).toBe("SHIPPED\n");
  });

  it("points at the shipped bundle when there are no corporate roots", async () => {
    const root = stageLinuxCopy();
    const options = await bundledRunnerOptions({ path: join(root, "bin", "git"), root }, "linux", null, join(dir, "unused"));
    expect(options.bundledEnv).toEqual({ GIT_EXEC_PATH: join(root, "libexec", "git-core"), GIT_SSL_CAINFO: join(root, "ssl", "cacert.pem") });
  });

  it("uses schannel and the copy's own tools on Windows", async () => {
    const options = await bundledRunnerOptions({ path: "C:\r\cmd\git.exe", root: "C:\r" }, "win32", "CORPORATE\n", dir);
    expect(options.bundledConfig).toEqual({ "http.sslBackend": "schannel" });
    expect(options.bundledEnv).not.toHaveProperty("GIT_SSL_CAINFO");
    expect(options.bundledPathPrefix?.split(";")).toHaveLength(2);
  });
});

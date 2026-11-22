import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePythonDownloadMirror } from "../../.github/scripts/python-download-mirror.mjs";
import { PYTHON_VERSION } from "../../.github/scripts/python-archive-cache.mjs";
import { fetchBytesWithRetry } from "../../scripts/lib/fetch-with-retry.mjs";
import { resolveUvTarget } from "../../scripts/uv-targets.mjs";

const roots: string[] = [];
const releaseBase = "https://releases.astral.sh/github/python-build-standalone/releases/download/";
const releasePath = "20261110/cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz";
const release = `${releaseBase}${releasePath}`;
const legacyRelease = `https://github.com/astral-sh/python-build-standalone/releases/download/${releasePath}`;
const selection = (url = release) => JSON.stringify([{ implementation: "cpython", variant: "default", url }]);
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "python-download-mirror-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("interpreter archive staging", () => {
  it("does no selection or download without a token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const listDownloads = vi.fn(selection);
    const download = vi.fn();
    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: temporaryRoot(), listDownloads, download })).resolves.toBeNull();
    expect(listDownloads).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    ["GITHUB_TOKEN", release],
    ["GH_TOKEN", release],
    ["GITHUB_TOKEN", legacyRelease],
  ])("stages the selected release through %s from %s", async (name, url) => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv(name, "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const root = temporaryRoot();
    const download = vi.fn(async () => Buffer.from("archive"));
    const mirror = await preparePythonDownloadMirror({ uv: "unused", mirrorRoot: root, listDownloads: () => selection(url), download });
    if (mirror === null) throw new Error("Interpreter mirror was not prepared");
    expect(download).toHaveBeenCalledWith(url, expect.objectContaining({ httpError: expect.any(Function) }));
    expect(readFileSync(join(fileURLToPath(mirror), decodeURIComponent(releasePath)), "utf8")).toBe("archive");
  });

  it("preserves an explicit interpreter mirror", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "https://mirror.example/downloads");
    const listDownloads = vi.fn(selection);
    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: temporaryRoot(), listDownloads })).resolves.toBeNull();
    expect(listDownloads).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 404", new Response(null, { status: 404 })],
    ["network error", new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })],
  ])("falls back to the same release path after a preferred mirror %s", async (_failure, outcome) => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const root = temporaryRoot();
    const download = vi.fn<typeof fetchBytesWithRetry>((url, options) => fetchBytesWithRetry(url, {
      ...options,
      fetchImpl: async () => {
        if (url === legacyRelease) return new Response("fallback archive");
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      sleep: async () => {},
    }));

    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: root, listDownloads: selection, download }))
      .resolves.toBeTypeOf("string");
    expect(download.mock.calls.map(([url]) => url)).toEqual([release, legacyRelease]);
    expect(readFileSync(join(root, decodeURIComponent(releasePath)), "utf8")).toBe("fallback archive");
  });

  it.each(["Digest mismatch", "Attestation mismatch"])("does not fall back on %s", async (message) => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const root = temporaryRoot();
    const failure = new Error(message);
    const download = vi.fn().mockRejectedValue(failure);

    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: root, listDownloads: selection, download }))
      .rejects.toBe(failure);
    expect(download).toHaveBeenCalledTimes(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    `https://example.com/github/python-build-standalone/releases/download/${releasePath}`,
    release.replace("releases.astral.sh", "releases.astral.sh.evil.example"),
    release.replace("releases.astral.sh", "evil.example/releases.astral.sh"),
    release.replace("https:", "http:"),
    release.replace("python-build-standalone", "other-project"),
    legacyRelease.replace("github.com", "github.com.evil.example"),
  ])("refuses an unexpected selected URL %s", async (url) => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const download = vi.fn();
    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: temporaryRoot(),
      listDownloads: () => selection(url), download,
    })).rejects.toThrow("Cannot identify");
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    "tag/archive.tar.gz",
    "20261110/../archive.tar.gz",
    "20261110/%2e%2e.tar.gz",
    "20261110/extra%2Farchive.tar.gz",
    "20261110/extra%5Carchive.tar.gz",
    "20261110/archive.zip",
  ])("refuses an invalid release path %s", async (path) => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const download = vi.fn();
    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: temporaryRoot(),
      listDownloads: () => selection(`${releaseBase}${path}`), download,
    })).rejects.toThrow("Invalid managed interpreter release path");
    expect(download).not.toHaveBeenCalled();
  });

  it("retains the installed tool's distribution pin when consuming a local mirror", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const root = temporaryRoot();
    const target = resolveUvTarget(process.platform, process.arch);
    const uv = resolve("resources", "uv", target.dir, target.bin);
    const mirror = await preparePythonDownloadMirror({ uv, mirrorRoot: join(root, "mirror"),
      download: async () => gzipSync(Buffer.alloc(1024)),
    });
    if (mirror === null) throw new Error("Interpreter mirror was not prepared");
    const env = { ...process.env, UV_PYTHON_INSTALL_MIRROR: mirror, UV_CACHE_DIR: join(root, "cache"),
      UV_PYTHON_INSTALL_DIR: join(root, "python"), UV_PYTHON_CACHE_DIR: join(root, "archives") };
    const result = spawnSync(uv, ["python", "install", PYTHON_VERSION, "--no-bin", "--no-registry"], { env, encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Hash mismatch[\s\S]*Expected:\s+[0-9a-f]{64}/);
    expect(readdirSync(join(root, "python")).filter((name) => name.startsWith("cpython-"))).toEqual([]);
  });
});

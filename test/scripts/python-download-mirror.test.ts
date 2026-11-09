import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePythonDownloadMirror } from "../../.github/scripts/python-download-mirror.mjs";
import { PYTHON_VERSION } from "../../.github/scripts/python-archive-cache.mjs";
import { resolveUvTarget } from "../../scripts/uv-targets.mjs";

const roots: string[] = [];
const release = "https://github.com/astral-sh/python-build-standalone/releases/download/20250409/cpython-3.12.10%2B20250409-x86_64-pc-windows-msvc-install_only_stripped.tar.gz";
const selection = () => JSON.stringify([{ implementation: "cpython", variant: "default", url: release }]);
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "python-download-mirror-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("authenticated interpreter archive staging", () => {
  it("does no selection or download without a token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const listDownloads = vi.fn(selection);
    const download = vi.fn();
    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: temporaryRoot(), listDownloads, download })).resolves.toBeNull();
    expect(listDownloads).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it.each(["GITHUB_TOKEN", "GH_TOKEN"])("stages the selected release through %s", async (name) => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv(name, "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const root = temporaryRoot();
    const download = vi.fn(async () => Buffer.from("archive"));
    const mirror = await preparePythonDownloadMirror({ uv: "unused", mirrorRoot: root, listDownloads: selection, download });
    if (mirror === null) throw new Error("Interpreter mirror was not prepared");
    expect(download).toHaveBeenCalledWith(release, expect.objectContaining({ httpError: expect.any(Function) }));
    expect(readFileSync(join(fileURLToPath(mirror), "20250409", decodeURIComponent(basename(new URL(release).pathname))), "utf8")).toBe("archive");
  });

  it("preserves an explicit interpreter mirror", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "https://mirror.example/downloads");
    const listDownloads = vi.fn(selection);
    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: temporaryRoot(), listDownloads })).resolves.toBeNull();
    expect(listDownloads).not.toHaveBeenCalled();
  });

  it.each(["https://github.com.evil.example/archive.tar.gz", "https://registry.npmjs.org/archive.tar.gz"])("refuses an unexpected selected URL %s", async (url) => {
    vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubEnv("UV_PYTHON_INSTALL_MIRROR", "");
    const download = vi.fn();
    await expect(preparePythonDownloadMirror({ uv: "unused", mirrorRoot: temporaryRoot(),
      listDownloads: () => JSON.stringify([{ implementation: "cpython", variant: "default", url }]), download,
    })).rejects.toThrow("Cannot identify");
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
    const result = spawnSync(uv, ["python", "install", PYTHON_VERSION], { env, encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Hash mismatch[\s\S]*Expected:\s+[0-9a-f]{64}/);
    expect(readdirSync(join(root, "python")).filter((name) => name.startsWith("cpython-"))).toEqual([]);
  });
});

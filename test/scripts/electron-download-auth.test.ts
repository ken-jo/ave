import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const installerPath = createRequire(import.meta.url).resolve("electron/install.js");
const installerRequire = createRequire(installerPath);
const downloadLibrary = installerRequire("@electron/get");
const TOKEN = "fixture-download-token";
const RELEASE_URL = "https://github.com/electron/electron/releases/download/v45.2.2/archive.zip";

interface Downloader {
  download(url: string, target: string, options?: RequestInit): Promise<void>;
}

interface DownloadDetails {
  version: string;
  artifactName: string;
  platform: string;
  arch: string;
  checksums: Record<string, string>;
  downloader?: Downloader;
}

function installerDetails(env: Record<string, string>): DownloadDetails {
  let details: DownloadDetails | undefined;
  runInNewContext(fs.readFileSync(installerPath, "utf8"), {
    __dirname: dirname(installerPath),
    Headers,
    URL,
    fetch: (url: string, options?: RequestInit) => globalThis.fetch(url, options),
    process: { env, platform: "win32", arch: "x64" },
    require: (id: string) => {
      if (id === "fs") return { ...fs, readFileSync: () => { throw new Error("Dependency is not installed"); } };
      if (id === "@electron/get") return {
        downloadArtifact: (options: DownloadDetails) => {
          details = options;
          return new Promise(() => {});
        },
      };
      return installerRequire(id);
    },
  });
  if (!details) throw new Error("Installer did not request its dependency archive");
  return details;
}

async function recordedDownload(env: Record<string, string>, url: string, options?: RequestInit) {
  let receivedOptions: RequestInit | undefined;
  vi.stubGlobal("fetch", async (_url: string, requestOptions?: RequestInit) => {
    receivedOptions = requestOptions;
    return new Response("archive fixture");
  });
  const root = fs.mkdtempSync(join(tmpdir(), "dependency-headers-"));
  try {
    await installerDetails(env).downloader?.download(url, join(root, "archive.zip"), options);
    return receivedOptions;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("dependency archive authentication", () => {
  it("retains the default downloader and pinned checksums without a token", () => {
    const details = installerDetails({});
    expect(details.downloader).toBeUndefined();
    expect(details.checksums).toEqual(installerRequire("./checksums.json"));
    expect(details.version).toBe(installerRequire("./package.json").version);
  });

  it.each([
    ["https://github.com/owner/repo/archive.zip", true],
    ["https://api.github.com/repos/owner/repo/releases/assets/1", true],
    ["https://objects.githubusercontent.com/archive.zip", false],
    ["https://github.com.example.test/archive.zip", false],
    ["https://mirror.example.test/archive.zip", false],
    ["http://github.com/archive.zip", false],
  ])("scopes authentication for %s", async (url, authenticated) => {
    const options = { headers: { "X-Archive-Test": "kept" } };
    const receivedOptions = await recordedDownload({ GITHUB_TOKEN: TOKEN }, url, options);
    const headers = new Headers(receivedOptions?.headers);
    expect(headers.get("authorization")).toBe(authenticated ? `Bearer ${TOKEN}` : null);
    expect(headers.get("x-archive-test")).toBe("kept");
    expect(options.headers).toEqual({ "X-Archive-Test": "kept" });
  });

  it.each<{ env: Record<string, string>; expected: string }>([
    { env: { GH_TOKEN: TOKEN }, expected: TOKEN },
    { env: { GITHUB_TOKEN: TOKEN, GH_TOKEN: "secondary-token" }, expected: TOKEN },
    { env: { GITHUB_TOKEN: "", GH_TOKEN: TOKEN }, expected: TOKEN },
  ])("uses the available token with deterministic precedence", async ({ env, expected }) => {
    const options = await recordedDownload(env, RELEASE_URL);
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${expected}`);
  });

  it("strips the authorization header when the real downloader follows a cross-host redirect", async () => {
    const received: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      received.push(request.headers.authorization);
      if (request.url === "/start") {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Download server has no TCP address");
        response.writeHead(302, { location: `http://127.0.0.1:${address.port}/archive` });
        response.end();
      } else {
        response.end("verified archive fixture");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const root = fs.mkdtempSync(join(tmpdir(), "dependency-auth-"));
    const actualFetch = globalThis.fetch;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Download server has no TCP address");
      const initialUrl = `http://localhost:${address.port}/start`;
      vi.stubGlobal("fetch", (url: string, options?: RequestInit) => actualFetch(url === RELEASE_URL ? initialUrl : url, options));
      const target = join(root, "archive.zip");
      await installerDetails({ GITHUB_TOKEN: TOKEN }).downloader?.download(RELEASE_URL, target);
      expect(received).toEqual([`Bearer ${TOKEN}`, undefined]);
      expect(fs.readFileSync(target, "utf8")).toBe("verified archive fixture");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects authenticated archive bytes that do not match the supplied checksum", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "dependency-pin-"));
    try {
      const details = installerDetails({ GITHUB_TOKEN: TOKEN });
      vi.stubGlobal("fetch", async () => new Response("corrupt archive"));
      const filename = `electron-v${details.version}-win32-x64.zip`;
      await expect(downloadLibrary.downloadArtifact({
        ...details,
        cacheRoot: root,
        checksums: { [filename]: createHash("sha256").update("expected archive").digest("hex") },
      })).rejects.toThrow(/checksum/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

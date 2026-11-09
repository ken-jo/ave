import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("app-builder-lib/out/util/electronGet.js");
const moduleRequire = createRequire(modulePath);
const TOKEN = "fixture-builder-token";

interface RequestOptions {
  url: URL;
  headers: Record<string, string>;
}

interface DownloadOptions {
  hooks?: Record<string, Array<(options: RequestOptions) => void>>;
  timeout?: { request: number };
  getProgressCallback?: (info: { total: number; percent: number }) => Promise<void>;
}

async function capturedDownload(env: Record<string, string>, options: DownloadOptions = {}) {
  let config: { checksums: Record<string, string>; downloadOptions: DownloadOptions } | undefined;
  const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  runInNewContext(readFileSync(modulePath, "utf8"), {
    exports,
    process: { env, platform: process.platform, stdout: { isTTY: false } },
    require: (id: string) => {
      if (id === "@electron/get") return {
        ...moduleRequire(id),
        downloadArtifact: async (details: typeof config) => { config = details; return "/fixture/archive.zip"; },
      };
      if (id === "proper-lockfile") return { lock: async () => async () => {} };
      if (id === "builder-util") return {
        ...moduleRequire(id),
        exists: async () => true,
        buildGotProxyAgent: () => undefined,
        log: { info: () => {}, warn: () => {} },
      };
      return moduleRequire(id);
    },
  });
  const checksums = { "electron-v45.2.2-linux-x64.zip": "a".repeat(64) };
  await exports.downloadElectronArtifactZip({
    arch: "x64", version: "45.2.2", platformName: "linux", artifactName: "electron",
    cacheDir: "/fixture/cache", electronDownload: { checksums, downloadOptions: options },
  });
  if (!config) throw new Error("Builder did not request an archive");
  return { ...config, expectedChecksums: checksums };
}

describe("packaging helper archive authentication", () => {
  it("preserves supplied hooks, checksum pins and timeout without a token", async () => {
    const beforeRequest = () => {};
    const supplied = { hooks: { beforeRequest: [beforeRequest] }, timeout: { request: 1234 } };
    const config = await capturedDownload({}, supplied);
    expect(config.downloadOptions.hooks).toBe(supplied.hooks);
    expect(config.downloadOptions.timeout).toEqual(supplied.timeout);
    expect(config.checksums).toEqual(config.expectedChecksums);
    expect(config.downloadOptions.getProgressCallback).toBeTypeOf("function");
  });

  it.each([
    ["https://github.com/owner/repo/archive.zip", true],
    ["https://api.github.com/repos/owner/repo/releases/assets/1", true],
    ["https://objects.githubusercontent.com/archive.zip", false],
    ["https://github.com.example.test/archive.zip", false],
    ["http://github.com/archive.zip", false],
  ])("authenticates only permitted request URLs for %s", async (url, authenticated) => {
    const config = await capturedDownload({ GITHUB_TOKEN: TOKEN });
    const options = { url: new URL(url), headers: {} as Record<string, string> };
    for (const hook of config.downloadOptions.hooks?.beforeRequest ?? []) hook(options);
    expect(options.headers.authorization).toBe(authenticated ? `Bearer ${TOKEN}` : undefined);
  });

  it("keeps existing hooks and applies the selected token last", async () => {
    const beforeRequest = (options: RequestOptions) => { options.headers["x-fixture"] = "kept"; };
    const beforeRedirect = () => {};
    const supplied = { hooks: { beforeRequest: [beforeRequest], beforeRedirect: [beforeRedirect] } };
    const config = await capturedDownload({ GH_TOKEN: TOKEN }, supplied);
    expect(config.downloadOptions.hooks?.beforeRequest?.[0]).toBe(beforeRequest);
    expect(config.downloadOptions.hooks?.beforeRedirect).toBe(supplied.hooks.beforeRedirect);
    expect(supplied.hooks.beforeRequest).toHaveLength(1);
    const options = { url: new URL("https://github.com/archive"), headers: {} as Record<string, string> };
    for (const hook of config.downloadOptions.hooks?.beforeRequest ?? []) hook(options);
    expect(options.headers).toEqual({ "x-fixture": "kept", authorization: `Bearer ${TOKEN}` });
    options.url = new URL("http://github.com/downgraded");
    for (const hook of config.downloadOptions.hooks?.beforeRequest ?? []) hook(options);
    expect(options.headers.authorization).toBeUndefined();
  });

  it("removes authentication while the real downloader follows a cross-host redirect", async () => {
    const received: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      received.push(request.headers.authorization);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Download server has no TCP address");
      if (request.url === "/start") response.writeHead(302, { location: `http://127.0.0.1:${address.port}/archive` });
      response.end(request.url === "/start" ? undefined : "archive fixture");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const root = mkdtempSync(join(tmpdir(), "builder-auth-"));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Download server has no TCP address");
      const config = await capturedDownload({ GITHUB_TOKEN: TOKEN });
      const { GotDownloader } = moduleRequire("@electron/get");
      await new GotDownloader().download("https://github.com/owner/repo/archive.zip", join(root, "archive.zip"), {
        ...config.downloadOptions,
        quiet: true,
        request: (url: URL, options: object, callback: Parameters<typeof httpRequest>[2]) => {
          const destination = url.hostname === "github.com" ? new URL(`http://localhost:${address.port}/start`) : url;
          return httpRequest(destination, {
            ...options, protocol: destination.protocol, hostname: destination.hostname, port: destination.port,
            path: destination.pathname, agent: undefined,
          }, callback);
        },
      });
      expect(received).toEqual([`Bearer ${TOKEN}`, undefined]);
      expect(readFileSync(join(root, "archive.zip"), "utf8")).toBe("archive fixture");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

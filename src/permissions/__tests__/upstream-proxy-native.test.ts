/**
 * The upstream proxy end to end against the real sandbox (macOS Seatbelt,
 * Linux bwrap): a sandboxed curl reaches a local stand-in upstream proxy
 * through Ave's per-invocation proxy, with the route the router answers.
 *
 * Covers the three sources without touching this machine's proxy settings:
 * the app process's environment (HTTP_PROXY with credentials), a manual URL
 * from Settings (credentials from the secret store), and the OS path through
 * an injected `resolveProxy` answering a PAC string (SOCKS entry skipped, a
 * dead proxy falling back to the next). And that the sandboxed process sees
 * only Ave's proxy: neither the upstream URL nor its credentials are in its
 * environment.
 *
 * Nothing leaves the machine: destinations are documentation addresses
 * reached only through the stand-in upstream on loopback.
 */
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../asrt-sandbox.js";
import { createUpstreamProxyRouter, type UpstreamProxyRouterDeps } from "../upstream-proxy.js";
import { DEFAULT_UPSTREAM_PROXY, type UpstreamProxySettings } from "../../shared/upstream-proxy.js";
import { sandboxCasesRequired, sandboxCasesRun } from "../../plugins/isolation/__tests__/sandbox-cases.js";
import { spawnWithSandbox } from "../../tools/shell-tools.js";
import { prepareSandboxFixture } from "../../tools/__tests__/support/prepared-shell.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const CURL = "/usr/bin/curl";
const nativePlatform = process.platform === "darwin" || process.platform === "linux";
const SECRET = "s3cret-pa55";

async function requireNativeCase(context: TestContext): Promise<void> {
  if (!(await sandboxCasesRun())) context.skip("ASRT cannot initialize (sandbox dependencies missing)");
  if (!existsSync(CURL)) {
    if (sandboxCasesRequired()) throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but ${CURL} is missing`);
    context.skip(`${CURL} is missing`);
  }
}

/** A stand-in upstream: records each request line and Proxy-Authorization, answers plain HTTP with a marker body. */
async function standInUpstream(): Promise<{ port: number; requests: Array<{ line: string; authorization?: string }>; close: () => Promise<void> }> {
  const requests: Array<{ line: string; authorization?: string }> = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.removeListener("data", onData);
      const lines = head.split("\r\n");
      const authorization = lines.find((l) => /^proxy-authorization:/iu.test(l))?.replace(/^[^:]+:\s*/u, "");
      requests.push({ line: lines[0] ?? "", ...(authorization !== undefined ? { authorization } : {}) });
      if ((lines[0] ?? "").startsWith("CONNECT ")) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      else socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 12\r\nConnection: close\r\n\r\nUPSTREAM-OK\n");
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(PROXY_VARS.map((name) => [name, process.env[name]]));
  for (const name of PROXY_VARS) delete process.env[name];
});
afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
});

/** Initialize the sandbox the way boot does, with every destination allowed and the router built from `deps`. */
async function startSandbox(deps: Partial<UpstreamProxyRouterDeps> & { settings: () => UpstreamProxySettings }): Promise<void> {
  const upstream = createUpstreamProxyRouter({
    manualCredentials: () => null,
    env: () => process.env,
    ...deps,
  });
  await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: false, upstreamRouter: upstream.router }, async () => true);
}

async function runSandboxed(command: string): Promise<string> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "upstream-proxy-native-")));
  try {
    const result = await spawnWithSandbox(command, cwd, [cwd], 30, prepareSandboxFixture(command, cwd, { toolUseId: "toolu_upstream_fixture" }));
    return result.output;
  } finally {
    await cleanupTmpDir(cwd);
  }
}

describe.runIf(nativePlatform)("upstream proxy through the sandbox (native)", () => {
  it("environment: chains through HTTP_PROXY with Basic credentials, and the sandboxed process never sees them", async (context) => {
    await requireNativeCase(context);
    const upstream = await standInUpstream();
    try {
      process.env.HTTP_PROXY = `http://user:${SECRET}@127.0.0.1:${upstream.port}`;
      process.env.https_proxy = `http://user:${SECRET}@127.0.0.1:${upstream.port}`;
      await startSandbox({ settings: () => ({ ...DEFAULT_UPSTREAM_PROXY }) });
      const output = await runSandboxed(
        `${CURL} -sS -m 10 http://203.0.113.10/plain ; ${CURL} -sS -m 10 -o /dev/null https://203.0.113.10/ ; env | grep -i '_proxy=' ; echo run-done`,
      );
      expect(output).toContain("UPSTREAM-OK");
      expect(output).toContain("run-done");
      const basic = `Basic ${Buffer.from(`user:${SECRET}`).toString("base64")}`;
      expect(upstream.requests).toEqual([
        { line: "GET http://203.0.113.10/plain HTTP/1.1", authorization: basic },
        { line: "CONNECT 203.0.113.10:443 HTTP/1.1", authorization: basic },
      ]);
      // The child sees Ave's per-invocation proxy only.
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain(`127.0.0.1:${upstream.port}`);
      expect(output).toMatch(/HTTPS_PROXY=http:\/\/[^\s]*localhost:\d+/u);
    } finally {
      await upstream.close();
    }
  }, 60_000);

  it("manual: uses the Settings proxy with stored credentials, and the bypass list goes direct", async (context) => {
    await requireNativeCase(context);
    const upstream = await standInUpstream();
    try {
      // The environment would say otherwise; manual wins.
      process.env.HTTP_PROXY = `http://127.0.0.1:${await deadPort()}`;
      await startSandbox({
        settings: () => ({ mode: "manual", manualUrl: `http://127.0.0.1:${upstream.port}`, bypass: "", resolvesNames: false }),
        manualCredentials: () => ({ username: "manual-user", password: SECRET, origin: `http://127.0.0.1:${upstream.port}` }),
      });
      const output = await runSandboxed(`${CURL} -sS -m 10 http://203.0.113.10/manual ; echo run-done`);
      expect(output).toContain("UPSTREAM-OK");
      expect(upstream.requests).toEqual([
        { line: "GET http://203.0.113.10/manual HTTP/1.1", authorization: `Basic ${Buffer.from(`manual-user:${SECRET}`).toString("base64")}` },
      ]);
      expect(output).not.toContain(SECRET);
    } finally {
      await upstream.close();
    }
  }, 60_000);

  it("system: follows a PAC answer per destination, skipping SOCKS and falling back past a dead proxy", async (context) => {
    await requireNativeCase(context);
    const upstream = await standInUpstream();
    const dead = await deadPort();
    const asked: string[] = [];
    try {
      await startSandbox({
        settings: () => ({ ...DEFAULT_UPSTREAM_PROXY }),
        resolveProxy: async (url) => {
          asked.push(url);
          return url.includes("203.0.113.10")
            ? `SOCKS5 127.0.0.1:1080; PROXY 127.0.0.1:${dead}; PROXY 127.0.0.1:${upstream.port}`
            : "SOCKS5 127.0.0.1:1080";
        },
      });
      const output = await runSandboxed(`${CURL} -sS -m 10 http://203.0.113.10/pac ; ${CURL} -sS -m 10 http://203.0.113.11/socks-only ; echo run-done`);
      expect(output).toContain("UPSTREAM-OK");
      expect(output).toContain("the system proxy settings offer no route the sandbox can use");
      expect(upstream.requests).toEqual([{ line: "GET http://203.0.113.10/pac HTTP/1.1" }]);
      expect(asked).toEqual(["http://203.0.113.10/", "http://203.0.113.11/"]);
    } finally {
      await upstream.close();
    }
  }, 60_000);
});

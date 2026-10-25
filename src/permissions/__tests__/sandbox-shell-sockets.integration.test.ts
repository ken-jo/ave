import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { SandboxManager, type SandboxAskContext } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { TEST_SHELL_EGRESS_CONTEXT } from "../../__tests__/support/egress-fixture.js";

async function execute(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

function listen(server: Server, address: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (typeof address === "number") server.listen(address, "127.0.0.1", resolve);
    else server.listen(address, resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(async () => { if (isAsrtSandboxActive()) await resetAsrtSandbox(); });

describe.skipIf(shouldSkipNativeSandboxTests())("host shell socket boundaries", () => {
  it("refuses Unix sockets and direct TCP while an ordinary command succeeds", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-sockets-")));
    const socket = join(root, "host.sock");
    const unixServer = createServer((_request, response) => response.end("host-unix-visible"));
    const tcpServer = createServer((_request, response) => response.end("host-tcp-visible"));
    await listen(unixServer, socket);
    await listen(tcpServer, 0);
    const address = tcpServer.address();
    if (address === null || typeof address === "string") throw new Error("TCP fixture has no port");
    const tcpUrl = `http://127.0.0.1:${address.port}/`;
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined, context: TEST_SHELL_EGRESS_CONTEXT });
    try {
      // Positive controls prove the endpoints are reachable before confinement.
      expect((await execute(["/usr/bin/curl", "--silent", "--show-error", "--max-time", "2", "--unix-socket", socket, "http://localhost/"])).output).toContain("host-unix-visible");
      expect((await execute(["/usr/bin/curl", "--silent", "--show-error", "--max-time", "2", "--noproxy", "*", tcpUrl])).output).toContain("host-tcp-visible");
      // A worker may need a shared socket grant. It must never widen shells.
      await initializeRequiredSandbox({ allowedDomains: [], strictAllowlist: false, allowUnixSocketDirs: [root], weakening: { allowAllUnixSockets: true } }, async () => false);
      const wrap = (command: string) => wrapToolCommand(command, {
        commandId: invocation.token, denyUnixSockets: true,
        filesystem: { allowWrite: [root] },
      });
      const ordinary = await wrap("printf sandbox-ready");
      const positive = await execute(ordinary.argv, ordinary.env);
      expect(positive.code, positive.output).toBe(0);
      expect(positive.output).toContain("sandbox-ready");
      const unix = await wrap(`/usr/bin/curl --silent --show-error --max-time 2 --unix-socket ${shellQuote(socket)} http://localhost/`);
      const unixResult = await execute(unix.argv, unix.env);
      expect(unixResult.code, unixResult.output).not.toBe(0);
      expect(unixResult.output).not.toContain("host-unix-visible");
      const tcp = await wrap(`/usr/bin/curl --silent --show-error --max-time 2 --noproxy '*' ${shellQuote(tcpUrl)}`);
      const tcpResult = await execute(tcp.argv, tcp.env);
      expect(tcpResult.code, tcpResult.output).not.toBe(0);
      expect(tcpResult.output).not.toContain("host-tcp-visible");
    } finally {
      invocation.release();
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
      await Promise.all([close(unixServer), close(tcpServer)]);
      await cleanupTmpDir(root);
    }
  });
});

function attributedProxyUrl(wrapped: { argv: readonly string[]; env: NodeJS.ProcessEnv }): URL {
  const source = [wrapped.env.HTTP_PROXY ?? "", ...wrapped.argv].join("\n");
  const spelling = /(http:\/\/srt\.[^'"\s:@]+:[^'"\s@]+@[^'"\s/]+)/u.exec(source)?.[1];
  if (spelling === undefined) throw new Error("Wrapped invocation carries no attributed proxy URL");
  return new URL(spelling);
}

async function requestRetiredListener(endpoint: { port?: number; socketPath?: string }, proxy: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    const send = (): void => {
      const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
      socket.write(`GET http://203.0.113.10/ HTTP/1.1\r\nHost: 203.0.113.10\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    };
    const socket = endpoint.port !== undefined ? connect(endpoint.port, "127.0.0.1", send) : connect(endpoint.socketPath!, send);
    let result = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("Retired listener did not refuse")));
    socket.on("data", (data: Buffer) => { result += data.toString("latin1"); });
    socket.once("close", () => resolve(result));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT"].includes(error.code ?? "")) resolve(result);
      else reject(error);
    });
  });
}

describe.skipIf(shouldSkipNativeSandboxTests())("native invocation proxy identity", () => {
  it("allows its own attributed request, refuses foreign credentials and listeners, and closes on release", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-listener-identity-")));
    const received: string[] = [];
    const upstream = createServer((request, response) => {
      received.push(request.url ?? "");
      response.end("approved-proxy-response");
    });
    await listen(upstream, 0);
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("Proxy fixture has no port");
    const route = `http://127.0.0.1:${address.port}`;
    const asked: Array<{ host: string; context: SandboxAskContext | undefined }> = [];
    const first = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: "first", context: TEST_SHELL_EGRESS_CONTEXT });
    const second = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: "second", context: TEST_SHELL_EGRESS_CONTEXT });
    try {
      await initializeRequiredSandbox({ allowedDomains: [], strictAllowlist: false, upstreamProxy: { http: route, https: route } }, async ({ host }, context) => {
        asked.push({ host, context });
        return true;
      });
      const request = "/usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '' http://203.0.113.10/";
      const wrap = (command: string, token: string) => wrapToolCommand(command, { commandId: token, denyUnixSockets: true, filesystem: { allowWrite: [root] } });
      const firstWrap = await wrap(request, first.token);
      const firstProxy = attributedProxyUrl(firstWrap);
      const firstListener = await SandboxManager.openInvocationListener(first.token);
      const secondWrap = await wrap(request, second.token);
      const secondProxy = attributedProxyUrl(secondWrap);
      const firstResult = await execute(firstWrap.argv, firstWrap.env);
      expect(firstResult.code, firstResult.output).toBe(0);
      expect(firstResult.output).toContain("approved-proxy-response");
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every(({ context }) => context?.identity === "listener" && context.attributionKey === first.token)).toBe(true);
      expect(asked.some(({ context }) => context?.phase === "name")).toBe(true);
      expect(asked.some(({ context }) => context?.phase === "resolved")).toBe(true);
      asked.length = 0;
      const secondResult = await execute(secondWrap.argv, secondWrap.env);
      expect(secondResult.code, secondResult.output).toBe(0);
      expect(asked.every(({ context }) => context?.identity === "listener" && context.attributionKey === second.token)).toBe(true);
      expect(asked.length).toBeGreaterThan(0);
      asked.length = 0;
      const stolen = new URL(secondProxy);
      stolen.username = firstProxy.username;
      const foreignToken = await wrap(`/usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '' --proxy ${shellQuote(stolen.href)} http://203.0.113.10/`, second.token);
      const mismatch = await execute(foreignToken.argv, foreignToken.env);
      expect(mismatch.code, mismatch.output).not.toBe(0);
      expect(asked).toEqual([]);
      // An invocation cannot access a different listener even with its credential.
      const foreignListener = await wrap(`/usr/bin/curl --fail --silent --show-error --max-time 3 --noproxy '' --proxy ${shellQuote(firstProxy.href)} http://203.0.113.10/`, second.token);
      const unreachable = await execute(foreignListener.argv, foreignListener.env);
      expect(unreachable.code, unreachable.output).not.toBe(0);
      expect(asked).toEqual([]);
      expect(received).toHaveLength(2);
      first.release();
      expect(await requestRetiredListener(firstListener, firstProxy)).not.toContain("200");
      await expect(SandboxManager.openInvocationListener(first.token)).rejects.toThrow(/has ended/u);
      await expect(wrap("true", first.token)).rejects.toThrow(/has ended/u);
      expect(asked).toEqual([]);
    } finally {
      first.release(); second.release();
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
      await close(upstream);
      await cleanupTmpDir(root);
    }
  });
});

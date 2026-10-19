/**
 * The bun patch on @anthropic-ai/sandbox-runtime is dist JavaScript edited by
 * hand. A version bump that re-rolls it can apply cleanly and still drop a
 * piece, and nothing else notices: the terminal's own-tty grant degrades to a
 * plain deny, the ask callback loses the attribution key that tells a plugin
 * worker's connection from a shell's, or an invocation loses the listener
 * that identifies it. So each symbol the patch adds is
 * asserted on the INSTALLED package, the bytes Ave actually loads, on every OS
 * the suite runs on.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SandboxAskCallback,
  SandboxAskContext,
  SandboxManager,
} from "@anthropic-ai/sandbox-runtime";

const repo = process.cwd();
const PACKAGE = "@anthropic-ai/sandbox-runtime";
const installed = join(repo, "node_modules", ...PACKAGE.split("/"));
const sandboxDir = join(installed, "dist", "sandbox");

function readInstalled(relativePath: string): string {
  return readFileSync(join(installed, relativePath), "utf-8");
}

/** The source of one top-level function in a dist file, through the next one. */
function functionBody(source: string, signature: RegExp): string {
  const start = source.search(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function /u);
  return next === -1 ? rest : rest.slice(0, next);
}

// Type-level half of the check: `check:typecheck-tests` fails if the patched
// declarations are missing. The callback must stay assignable with one
// parameter (existing callers) and must see the context with two.
const oneParameter: SandboxAskCallback = async ({ host }) => host === "example.com";
const twoParameters: SandboxAskCallback = async (_params, context?: SandboxAskContext) =>
  context?.attributionKey === "token" && context.identity === "listener";
type WrapOptions = NonNullable<Parameters<typeof SandboxManager.wrapWithSandbox>[4]>;
const ttysOption: WrapOptions["ttys"] = ["/dev/ttys001"];

/** The documentation address every `*.example.invalid` test name resolves to. */
const TEST_ADDRESS = "203.0.113.10";

/**
 * The proxy resolves each destination name once, before asking; test names
 * answer with a documentation address so the callback and dial are reached.
 */
async function testResolver(name: string): Promise<Array<{ address: string; family: number }>> {
  if (name.endsWith(".example.invalid")) return [{ address: TEST_ADDRESS, family: 4 }];
  const { lookup } = await import("node:dns/promises");
  return lookup(name, { all: true });
}

beforeEach(async () => {
  const { SandboxManager: manager } = await import("@anthropic-ai/sandbox-runtime");
  manager.setDestinationResolverForTesting(testResolver);
});
afterEach(async () => {
  const { SandboxManager: manager } = await import("@anthropic-ai/sandbox-runtime");
  manager.setDestinationResolverForTesting(undefined);
  manager.setListenerQuarantineForTesting(undefined);
});

describe("patched @anthropic-ai/sandbox-runtime", () => {
  it("installs the version the patch is keyed to, with the patch file present", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
      patchedDependencies: Record<string, string>;
    };
    const version = pkg.dependencies[PACKAGE];
    const patchPath = pkg.patchedDependencies[`${PACKAGE}@${version}`];
    expect(patchPath, "patchedDependencies has no entry for the pinned version").toBeTypeOf("string");
    expect(existsSync(join(repo, patchPath))).toBe(true);
    expect((JSON.parse(readInstalled("package.json")) as { version: string }).version).toBe(version);
  });

  it("exports assertPtySlavePaths, which accepts pty slaves and refuses anything else", async () => {
    const macos = (await import(pathToFileURL(join(sandboxDir, "macos-sandbox-utils.js")).href)) as {
      assertPtySlavePaths?: (ttys: readonly unknown[]) => void;
    };
    expect(macos.assertPtySlavePaths).toBeTypeOf("function");
    expect(() => macos.assertPtySlavePaths?.(["/dev/ttys001", "/dev/ttys1000"])).not.toThrow();
    for (const bad of ["/dev/ttys*", "/dev/ttys01", "/dev/pts/3", "/dev/ttys001\n", 7]) {
      expect(() => macos.assertPtySlavePaths?.([bad])).toThrow(/is not a pty slave device/u);
    }
    expect(readInstalled("dist/sandbox/macos-sandbox-utils.d.ts")).toMatch(
      /export declare function assertPtySlavePaths\(ttys: readonly string\[\]\): void;/u,
    );
  });

  it("threads ttys into the macOS profile as file-ioctl literals", () => {
    const macos = readInstalled("dist/sandbox/macos-sandbox-utils.js");
    const profile = functionBody(macos, /\nfunction generateSandboxProfile\(/u);
    expect(profile).toMatch(/allowPty, ttys = \[\],/u);
    expect(profile).toContain("(allow file-ioctl (literal ${escapePath(device)}))");
    const wrap = functionBody(macos, /\nexport function wrapCommandWithSandboxMacOS\(/u);
    expect(wrap).toMatch(/allowPty, ttys = \[\],/u);
    expect(wrap).toMatch(/assertPtySlavePaths\(ttys\);/u);
    expect(wrap).toMatch(/\n\s+ttys,\n/u);
  });

  it("validates ttys at both manager entry points and hands them to the macOS wrap", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    expect(manager).toMatch(/import \{ assertPtySlavePaths, [^}]*\} from '\.\/macos-sandbox-utils\.js';/u);
    for (const entry of [/\nasync function wrapWithSandbox\(/u, /\nasync function wrapWithSandboxArgv\(/u]) {
      expect(functionBody(manager, entry)).toContain("assertPtySlavePaths(options?.ttys ?? []);");
    }
    expect(manager).toContain("ttys: options?.ttys,");
    expect(readInstalled("dist/sandbox/sandbox-manager.d.ts")).toMatch(/\n\s+ttys\?: readonly string\[\];\n/u);
  });

  it("passes the decoded attribution key to the ask callback", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    const filter = functionBody(manager, /\nasync function filterNetworkRequest\(/u);
    // The same `encodedCommand` the deny path hands recordOutboundDeny.
    expect(filter).toMatch(/recordOutboundDeny\(host, port, reason, encodedCommand\)/u);
    // Decoded once; the per-command lists (0.0.80) are looked up by the same key.
    expect(filter).toMatch(
      /const attributionKey = encodedCommand\s+\? decodeSandboxedCommand\(encodedCommand\)\s+: undefined;/u,
    );
    expect(filter).toMatch(/commandNetworkListsByKey\.get\(attributionKey\)/u);
    expect(filter).toMatch(/await sandboxAskCallback\(\{ host, port \}, \{ attributionKey, identity, addresses: addresses\.map\(a => a\.address\) \}\)/u);
    // Only an invocation listener's filter says 'listener'; the shared front
    // end's default is the forgeable username.
    expect(filter.startsWith("async function filterNetworkRequest(port, host, sandboxAskCallback, encodedCommand, explain, identity = 'username', addresses = [])")).toBe(true);
    // 0.0.80 allows only on a literal `true` (#591); the patch must not loosen it.
    expect(filter).toMatch(/if \(answer === true\)/u);
    // Ave runs non-strict with an empty allowlist, so the callback is the gate:
    // without one, and when it throws, the request is refused.
    expect(filter).toMatch(/if \(!sandboxAskCallback\) \{\n[^\n]*\n\s+return denied\('host is not on the allow list'\);/u);
    expect(filter).toMatch(/catch \(error\) \{\n[\s\S]{0,200}?return denied\('permission prompt failed'\);\n\s+\}\n\}/u);
    const schemas = readInstalled("dist/sandbox/sandbox-schemas.d.ts");
    expect(schemas).toMatch(
      /export type SandboxAskContext = \{\s+attributionKey: string \| undefined;\s+\/\*\*[\s\S]*?\*\/\s+identity: 'listener' \| 'username';\s+\/\*\*[\s\S]*?\*\/\s+addresses: readonly string\[\];\s+\};/u,
    );
    expect(schemas).toMatch(
      /export type SandboxAskCallback = \(params: NetworkHostPattern, context\?: SandboxAskContext\) => Promise<boolean \| \{\s+allow: false;\s+reason: string;\s+\}>;/u,
    );
    expect(readInstalled("dist/index.d.ts")).toMatch(/export type \{ SandboxAskCallback, SandboxAskContext,/u);
  });

  it("types the callback so one-parameter callers still fit and two-parameter callers see the key", async () => {
    const params = { host: "example.com", port: 443 };
    await expect(oneParameter(params)).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: "token", identity: "listener", addresses: [] })).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: "token", identity: "username", addresses: [] })).resolves.toBe(false);
    await expect(twoParameters(params, { attributionKey: undefined, identity: "username", addresses: [] })).resolves.toBe(false);
    expect(ttysOption).toEqual(["/dev/ttys001"]);
  });

  it("adds invocation listeners: exported, bounded, never reopened, refused with allowLocalBinding", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    expect(manager).toMatch(/\n\s+openInvocationListener,\n\s+closeInvocationListener,\n/u);
    expect(manager).toMatch(/\nconst MAX_INVOCATION_LISTENERS = \d+;/u);
    const open = functionBody(manager, /\nasync function openInvocationListener\(/u);
    expect(open).toMatch(/if \(retiredInvocationKeys\.has\(key\)\)/u);
    expect(open).toMatch(/if \(invocationListeners\.size >= MAX_INVOCATION_LISTENERS\)/u);
    // macOS: a loopback port the wrap's profile alone may reach.
    expect(open).toMatch(/await listenOn\(mux\.server, 0, '127\.0\.0\.1'\);/u);
    const filter = functionBody(manager, /\nfunction invocationListenerFilter\(/u);
    expect(filter).toMatch(/if \(lane\.ended\)\s+return denied\('invocation ended'\);/u);
    expect(filter).toMatch(/if \(encodedCommand !== lane\.encodedKey\)/u);
    expect(filter).toMatch(/localDestinationReason\(host, port\)/u);
    expect(filter).toMatch(/const resolved = await resolveDestination\(host, port\);/u);
    expect(filter).toMatch(/filterNetworkRequest\(port, host, sandboxAskCallback, lane\.encodedKey, explain, 'listener', resolved\.addresses\)/u);
    expect(filter).toMatch(/pinDestination\(socket, host, port, resolved\.addresses\);/u);
    const close = functionBody(manager, /\nfunction closeInvocationListener\(/u);
    // An ended macOS listener keeps its port (tombstone) until reset().
    expect(close).toMatch(/lane\.mux\.server\.on\('connection', socket => socket\.destroy\(\)\);/u);
    const forWrap = functionBody(manager, /\nfunction invocationListenerForWrap\(/u);
    expect(forWrap).toMatch(/if \(getAllowLocalBinding\(\)\) \{/u);
    expect(manager).toMatch(/httpProxyPort: needsNetworkProxy \? \(lane\?\.port \?\? getProxyPort\(\)\) : undefined,/u);
    expect(manager).toMatch(/\? \(lane\?\.socketPath \?\? getLinuxHttpSocketPath\(\)\)/u);
    const declarations = readInstalled("dist/sandbox/sandbox-manager.d.ts");
    expect(declarations).toMatch(/\n\s+openInvocationListener\(commandId: string\): Promise<\{/u);
    expect(declarations).toMatch(/\n\s+closeInvocationListener\(commandId: string, options\?: \{/u);
  });

  it("hides the proxy's socket directory in every Linux wrap and keeps proxy backends in it", () => {
    const linux = readInstalled("dist/sandbox/linux-sandbox-utils.js");
    const wrap = functionBody(linux, /\nexport async function wrapCommandWithSandboxLinux\(/u);
    expect(wrap).toMatch(/bwrapArgs\.push\('--dev', '\/dev'\);\s+(?:\/\/[^\n]*\n\s+)*if \(privateSocketDir\) \{\s+bwrapArgs\.push\('--tmpfs', privateSocketDir\);/u);
    expect(wrap).toMatch(/bwrapArgs\.push\('--bind', httpSocketPath, httpSocketPath\);\s+\}\s+\}/u);
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    expect(manager).toMatch(/backendSocketDir: getPlatform\(\) === 'windows' \? undefined : ensurePrivateSocketDir\(\),/u);
    expect(manager).toMatch(/const socketPath = joinPath\(ensurePrivateSocketDir\(\), /u);
    expect(manager).toMatch(/\n\s+privateSocketDir,\n/u);
    expect(readInstalled("dist/sandbox/mux-proxy.js")).toContain("const path = unixSocketPath(opts.backendSocketDir);");
  });

  it("quarantines an ended macOS listener's port and never hands it out again", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    expect(manager).toMatch(/\nconst INVOCATION_LISTENER_QUARANTINE_MS = \d+ \* 60 \* 1000;/u);
    const close = functionBody(manager, /\nfunction closeInvocationListener\(/u);
    expect(close).toMatch(/retiredListenerPorts\.add\(lane\.port\);/u);
    const open = functionBody(manager, /\nasync function openInvocationListener\(/u);
    expect(open).toMatch(/if \(!retiredListenerPorts\.has\(lane\.port\)\)\s+break;/u);
  });

  it("denies process-info on other processes and the kern.procargs sysctls in the macOS profile", () => {
    const profile = functionBody(readInstalled("dist/sandbox/macos-sandbox-utils.js"), /\nfunction generateSandboxProfile\(/u);
    const allowSame = profile.indexOf("'(allow process-info* (target same-sandbox))',");
    const denyOthers = profile.indexOf("'(deny process-info* (target others))',");
    const denyProcargs = profile.indexOf("'(deny sysctl-read (sysctl-name-prefix \"kern.procargs\"))',");
    expect(allowSame).toBeGreaterThanOrEqual(0);
    expect(denyOthers).toBeGreaterThan(allowSame);
    expect(denyProcargs).toBeGreaterThan(allowSame);
  });
});

/**
 * Behavioural half: through the real proxy, the key a wrap's proxy username
 * names reaches the ask callback's second argument. The proxy URL (with the
 * per-process credential) is read out of the wrapped command and used only
 * inside this process.
 */
describe.runIf(process.platform === "darwin" || process.platform === "linux")("ask callback attribution through the proxy", () => {
  /**
   * CONNECT `destination` through a host-side proxy front end (a port, or a
   * Linux socket path); `proxy` gives only the credential.
   */
  async function connectThrough(
    front: number | string,
    proxy: URL,
    username: string,
    destination = "unlisted.example.invalid:443",
  ): Promise<string> {
    const { connect } = await import("node:net");
    const authorization = Buffer.from(`${username}:${decodeURIComponent(proxy.password)}`).toString("base64");
    return new Promise((resolve, reject) => {
      const onConnect = (): void => {
        socket.write(
          `CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n`
            + `Proxy-Authorization: Basic ${authorization}\r\n\r\n`,
        );
      };
      const socket = typeof front === "number" ? connect(front, "127.0.0.1", onConnect) : connect(front, onConnect);
      let head = "";
      socket.setTimeout(10_000, () => socket.destroy(new Error("proxy did not answer")));
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString("latin1");
        if (head.includes("\r\n")) socket.end();
      });
      socket.on("close", () => resolve(head.split("\r\n")[0] ?? ""));
      socket.on("error", (error: NodeJS.ErrnoException) => {
        // A refused or reset connection is the answer for an ended listener
        // (macOS keeps the port and drops the socket; Linux removes the path).
        if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT"].includes(error.code ?? "")) resolve("");
        else reject(error);
      });
    });
  }

  async function initializeOrSkip(
    test: { skip: (note: string) => void },
    asked: Array<{ host: string; context: SandboxAskContext | undefined }>,
    network: { allowLocalBinding?: boolean } = {},
  ): Promise<typeof import("@anthropic-ai/sandbox-runtime").SandboxManager | undefined> {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    try {
      await SandboxManager.initialize(
        {
          network: { allowedDomains: [], deniedDomains: [], ...network },
          filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        },
        async ({ host }, context) => {
          asked.push({ host, context });
          return false;
        },
      );
      return SandboxManager;
    } catch (error) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
      test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
      return undefined;
    }
  }

  function proxyUrlIn(wrapped: string): URL {
    const spelled = /(http:\/\/srt\.[^'"\s:@]+:[^'"\s@]+@[^'"\s/]+)/u.exec(wrapped)?.[1];
    expect(spelled, "wrapped command carries no attributed proxy URL").toBeTypeOf("string");
    return new URL(spelled!);
  }

  function frontOf(listener: { port?: number; socketPath?: string }): number | string {
    const front = listener.port ?? listener.socketPath;
    expect(front).toBeDefined();
    return front!;
  }

  it("passes the wrap's commandId, and undefined for the bare username", async (test) => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const asked: Array<SandboxAskContext | undefined> = [];
    try {
      await SandboxManager.initialize(
        { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
        async (_params, context) => {
          asked.push(context);
          return false;
        },
      );
    } catch (error) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
      test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
    }
    try {
      const commandId = "0123456789abcdef0123456789abcdef";
      const wrapped = await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId });
      // `'HTTP_PROXY=http://…'` on macOS, `--setenv HTTP_PROXY 'http://…'` on Linux.
      const spelled = /(http:\/\/srt\.[^'"\s:@]+:[^'"\s@]+@[^'"\s/]+)/u.exec(wrapped)?.[1];
      expect(spelled, "wrapped command carries no attributed proxy URL").toBeTypeOf("string");
      const proxy = new URL(spelled!);
      expect(proxy.username.startsWith("srt.")).toBe(true);
      // On Linux the URL names the relay inside the sandbox's network
      // namespace; the host side listens on the proxy's own port.
      const port = SandboxManager.getProxyPort();
      expect(port).toBeTypeOf("number");
      expect(await connectThrough(port!, proxy, decodeURIComponent(proxy.username))).toMatch(/^HTTP\/1\.1 403/u);
      expect(await connectThrough(port!, proxy, "srt")).toMatch(/^HTTP\/1\.1 403/u);
      expect(asked).toEqual([
        { attributionKey: commandId, identity: "username", addresses: [TEST_ADDRESS] },
        { attributionKey: undefined, identity: "username", addresses: [TEST_ADDRESS] },
      ]);
    } finally {
      await SandboxManager.reset();
    }
  });

  it("attributes a listener's connections from the listener, and refuses another key, a hop and an ended listener", async (test) => {
    const asked: Array<{ host: string; context: SandboxAskContext | undefined }> = [];
    const SandboxManager = await initializeOrSkip(test, asked);
    if (SandboxManager === undefined) return;
    try {
      const first = "a".repeat(16) + "0123456789abcdef";
      const second = "b".repeat(16) + "0123456789abcdef";
      const firstListener = await SandboxManager.openInvocationListener(first);
      const secondListener = await SandboxManager.openInvocationListener(second);
      expect(await SandboxManager.openInvocationListener(first)).toEqual(firstListener);
      if (process.platform === "darwin") {
        expect(firstListener.port).toBeTypeOf("number");
        expect(firstListener.port).not.toBe(secondListener.port);
      } else {
        expect(firstListener.socketPath).toBeTypeOf("string");
        expect(firstListener.socketPath).not.toBe(secondListener.socketPath);
      }
      const wrapped = await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId: first });
      const proxy = proxyUrlIn(wrapped);
      if (process.platform === "darwin") {
        // The profile pins this invocation's own port, not the shared one.
        expect(wrapped).toContain(`localhost:${firstListener.port}`);
        expect(wrapped).not.toContain(`localhost:${SandboxManager.getProxyPort()}`);
      } else {
        expect(wrapped).toContain(firstListener.socketPath);
      }
      const ownName = decodeURIComponent(proxy.username);
      const firstFront = frontOf(firstListener);
      // Its own key on its own listener: asked, as the listener's.
      expect(await connectThrough(firstFront, proxy, ownName)).toMatch(/^HTTP\/1\.1 403/u);
      expect(asked).toEqual([{ host: "unlisted.example.invalid", context: { attributionKey: first, identity: "listener", addresses: [TEST_ADDRESS] } }]);
      // Another key on this listener, and this key on another's: never asked.
      // The proxy username is `srt.` plus the base64 of the commandId.
      expect(ownName).toBe(`srt.${Buffer.from(first).toString("base64")}`);
      const secondName = `srt.${Buffer.from(second).toString("base64")}`;
      expect(await connectThrough(firstFront, proxy, secondName)).toMatch(/^HTTP\/1\.1 403/u);
      expect(await connectThrough(frontOf(secondListener), proxy, ownName)).toMatch(/^HTTP\/1\.1 403/u);
      // A hop through its own listener onto a proxy front end: refused before
      // the callback, for the shared port and (macOS) the other listener's.
      const hops = [`127.0.0.1:${SandboxManager.getProxyPort()}`, `localhost:${SandboxManager.getProxyPort()}`];
      if (secondListener.port !== undefined) hops.push(`127.0.0.1:${secondListener.port}`, `[::1]:${secondListener.port}`);
      for (const hop of hops) {
        expect(await connectThrough(firstFront, proxy, ownName, hop), hop).toMatch(/^HTTP\/1\.1 403/u);
      }
      expect(asked).toHaveLength(1);
      // Ended: refused, its port kept (macOS), never reopened or wrapped again.
      SandboxManager.closeInvocationListener(first);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await connectThrough(firstFront, proxy, ownName)).not.toMatch(/^HTTP\/1\.1 200/u);
      expect(asked).toHaveLength(1);
      await expect(SandboxManager.openInvocationListener(first)).rejects.toThrow(/has ended/u);
      await expect(
        SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId: first }),
      ).rejects.toThrow(/has ended/u);
      if (process.platform === "darwin") {
        // The tombstone still holds the port, so no later listener gets it.
        const { createServer } = await import("node:net");
        const probe = createServer();
        const bound = await new Promise<string>((resolve) => {
          probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
          probe.listen(firstListener.port, "127.0.0.1", () => resolve("bound"));
        });
        if (bound === "bound") probe.close();
        expect(bound).toBe("EADDRINUSE");
      }
    } finally {
      await SandboxManager.reset();
    }
  });

  it("refuses to wrap an invocation listener when allowLocalBinding is set", async (test) => {
    const SandboxManager = await initializeOrSkip(test, [], { allowLocalBinding: true });
    if (SandboxManager === undefined) return;
    try {
      const commandId = "c".repeat(16) + "0123456789abcdef";
      await SandboxManager.openInvocationListener(commandId);
      await expect(
        SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }),
      ).rejects.toThrow(/allowLocalBinding cannot be combined with an invocation listener/u);
    } finally {
      await SandboxManager.reset();
    }
  });

  /** A stand-in upstream proxy: answers every CONNECT 200 and keeps the tunnel open. */
  async function fakeUpstream(): Promise<{ port: number; connects: string[]; close: () => Promise<void> }> {
    const { createServer } = await import("node:net");
    const connects: string[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", (chunk: Buffer) => {
        connects.push(chunk.toString("latin1").split("\r\n")[0] ?? "");
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("no upstream port");
    return {
      port: address.port,
      connects,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** A resolver whose answer for `name` is the next of `answers` on each call (the last one repeats). */
  function rebinding(name: string, answers: string[]): { resolver: typeof testResolver; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      resolver: async (asked) => {
        if (asked !== name) return testResolver(asked);
        const address = answers[Math.min(calls, answers.length - 1)]!;
        calls += 1;
        return [{ address, family: address.includes(":") ? 6 : 4 }];
      },
    };
  }

  /** Send one plain-HTTP request through a proxy front end; resolves to the status line. */
  async function plainHttpThrough(front: number | string, proxy: URL, username: string, url: string): Promise<string> {
    const { connect } = await import("node:net");
    const authorization = Buffer.from(`${username}:${decodeURIComponent(proxy.password)}`).toString("base64");
    const host = new URL(url).host;
    return new Promise((resolve, reject) => {
      const onConnect = (): void => {
        socket.write(`GET ${url} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic ${authorization}\r\nConnection: close\r\n\r\n`);
      };
      const socket = typeof front === "number" ? connect(front, "127.0.0.1", onConnect) : connect(front, onConnect);
      let head = "";
      socket.setTimeout(10_000, () => socket.destroy(new Error("proxy did not answer")));
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString("latin1");
        if (head.includes("\r\n")) socket.end();
      });
      socket.on("close", () => resolve(head.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
  }

  it("with an upstream proxy, CONNECTs to the address it vetted, never the name, so a rebinding name cannot reach this host", async (test) => {
    const upstream = await fakeUpstream();
    const asked: Array<{ host: string; context: SandboxAskContext | undefined }> = [];
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    try {
      try {
        await SandboxManager.initialize(
          {
            network: {
              allowedDomains: [],
              deniedDomains: [],
              parentProxy: { http: `http://127.0.0.1:${upstream.port}`, https: `http://127.0.0.1:${upstream.port}` },
            },
            filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
          },
          async ({ host }, context) => {
            asked.push({ host, context });
            return true;
          },
        );
      } catch (error) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
        test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
        return;
      }
      const commandId = "d".repeat(16) + "0123456789abcdef";
      const listener = await SandboxManager.openInvocationListener(commandId);
      const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
      const name = `srt.${Buffer.from(commandId).toString("base64")}`;
      const front = frontOf(listener);
      const proxyPort = SandboxManager.getProxyPort()!;
      // A name that answers a public address to the check and this host's
      // loopback to any later lookup (the upstream's, or a second one here).
      const rebind = rebinding("rebind.example.test", ["198.51.100.7", "127.0.0.1"]);
      SandboxManager.setDestinationResolverForTesting(rebind.resolver);
      expect(await connectThrough(front, proxy, name, `rebind.example.test:${proxyPort}`)).toMatch(/^HTTP\/1\.1 200/u);
      expect(upstream.connects).toEqual([`CONNECT 198.51.100.7:${proxyPort} HTTP/1.1`]);
      expect(rebind.calls()).toBe(1);
      expect(asked).toEqual([{
        host: "rebind.example.test",
        context: { attributionKey: commandId, identity: "listener", addresses: ["198.51.100.7"] },
      }]);
      // A name that resolves to this host now: refused before asking or forwarding.
      SandboxManager.setDestinationResolverForTesting(rebinding("local.example.test", ["127.0.0.1"]).resolver);
      expect(await connectThrough(front, proxy, name, `local.example.test:${proxyPort}`)).toMatch(/^HTTP\/1\.1 403/u);
      // A name that does not resolve here: nothing could be pinned, so refused.
      SandboxManager.setDestinationResolverForTesting(async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      });
      expect(await connectThrough(front, proxy, name, "split.example.test:443")).toMatch(/^HTTP\/1\.1 403/u);
      // Plain HTTP by name through the upstream: the absolute-form target
      // would let the upstream resolve it, so it is refused; a literal goes.
      SandboxManager.setDestinationResolverForTesting(testResolver);
      expect(await plainHttpThrough(front, proxy, name, "http://plain.example.invalid/")).toMatch(/^HTTP\/1\.1 403/u);
      expect(upstream.connects).toHaveLength(1);
      // Refused before the callback: nobody is asked about a request that cannot be sent.
      expect(asked.map((a) => a.host)).toEqual(["rebind.example.test"]);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });

  it("dials the address it vetted on the direct path, without resolving the name again", async (test) => {
    const { createServer } = await import("node:net");
    const canary = createServer((socket) => socket.end("CANARY\n"));
    await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
    const canaryPort = (canary.address() as import("node:net").AddressInfo).port;
    const asked: Array<{ host: string; context: SandboxAskContext | undefined }> = [];
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    try {
      try {
        // An IP rule lets a name use this loopback address (the guard refuses
        // loopback for a name otherwise), so the pinned dial has a target.
        await SandboxManager.initialize(
          {
            network: { allowedDomains: [`127.0.0.1:${canaryPort}`], deniedDomains: [] },
            filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
          },
          async ({ host }, context) => {
            asked.push({ host, context });
            return true;
          },
        );
      } catch (error) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
        test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
        return;
      }
      const commandId = "f".repeat(16) + "0123456789abcdef";
      const listener = await SandboxManager.openInvocationListener(commandId);
      const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
      const rebind = rebinding("pin.example.test", ["127.0.0.1", "198.51.100.9"]);
      SandboxManager.setDestinationResolverForTesting(rebind.resolver);
      const name = `srt.${Buffer.from(commandId).toString("base64")}`;
      expect(await connectThrough(frontOf(listener), proxy, name, `pin.example.test:${canaryPort}`)).toMatch(/^HTTP\/1\.1 200/u);
      expect(rebind.calls()).toBe(1);
      expect(asked).toEqual([{
        host: "pin.example.test",
        context: { attributionKey: commandId, identity: "listener", addresses: ["127.0.0.1"] },
      }]);
    } finally {
      await SandboxManager.reset();
      await new Promise<void>((resolve) => canary.close(() => resolve()));
    }
  });

  it.runIf(process.platform === "darwin")("keeps an ended listener's port while its process group lives, and releases it once the group is empty", async (test) => {
    const SandboxManager = await initializeOrSkip(test, []);
    if (SandboxManager === undefined) return;
    const { spawn } = await import("node:child_process");
    const { createServer } = await import("node:net");
    const group = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const bindable = async (port: number): Promise<boolean> => {
      const probe = createServer();
      const bound = await new Promise<boolean>((resolve) => {
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (bound) await new Promise<void>((resolve) => probe.close(() => resolve()));
      return bound;
    };
    try {
      SandboxManager.setListenerQuarantineForTesting(100);
      const commandId = "9".repeat(16) + "0123456789abcdef";
      const listener = await SandboxManager.openInvocationListener(commandId);
      SandboxManager.closeInvocationListener(commandId, { processGroup: group.pid });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await bindable(listener.port!)).toBe(false);
      process.kill(-group.pid!, "SIGKILL");
      await new Promise((resolve) => group.once("exit", resolve));
      const deadline = Date.now() + 3_000;
      let released = false;
      while (!released && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        released = await bindable(listener.port!);
      }
      expect(released).toBe(true);
    } finally {
      if (group.exitCode === null && group.signalCode === null) process.kill(-group.pid!, "SIGKILL");
      await SandboxManager.reset();
    }
  });

  it("closes an invocation's open tunnels to a destination on request", async (test) => {
    const upstream = await fakeUpstream();
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const { connect } = await import("node:net");
    try {
      try {
        await SandboxManager.initialize(
          {
            network: {
              allowedDomains: ["kept.example.invalid"],
              deniedDomains: [],
              parentProxy: { http: `http://127.0.0.1:${upstream.port}`, https: `http://127.0.0.1:${upstream.port}` },
            },
            filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
          },
          async () => false,
        );
      } catch (error) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
        test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
        return;
      }
      const commandId = "e".repeat(16) + "0123456789abcdef";
      const listener = await SandboxManager.openInvocationListener(commandId);
      const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
      const authorization = Buffer.from(`srt.${Buffer.from(commandId).toString("base64")}:${decodeURIComponent(proxy.password)}`).toString("base64");
      const front = frontOf(listener);
      const tunnel = typeof front === "number" ? connect(front, "127.0.0.1") : connect(front);
      const closed = new Promise<void>((resolve) => tunnel.once("close", () => resolve()));
      tunnel.on("error", () => {});
      await new Promise<void>((resolve) => {
        tunnel.once("data", () => resolve());
        tunnel.write(`CONNECT kept.example.invalid:443 HTTP/1.1\r\nHost: kept.example.invalid:443\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
      });
      expect(SandboxManager.closeInvocationConnections([commandId], "other.example.invalid", 443)).toBe(0);
      expect(SandboxManager.closeInvocationConnections([commandId], "KEPT.example.invalid", 443)).toBe(1);
      await closed;
      expect(SandboxManager.closeInvocationConnections([commandId], "kept.example.invalid", 443)).toBe(0);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });
});

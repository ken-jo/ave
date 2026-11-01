/** The bun patch on @anthropic-ai/sandbox-runtime is dist JavaScript edited by hand. A version bump that re-rolls it can apply cleanly and still drop a piece, and nothing else notices: the terminal's own-tty grant degrades to a plain deny, the ask callback loses
 * the attribution key that tells a plugin worker's connection from a shell's, or an invocation loses the listener that identifies it. So each symbol the patch adds is asserted on the INSTALLED package, the bytes Ave actually loads, on every OS the suite runs on. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Test seams: imported by file path, never from the package entry (see the export-surface case below).
import {
  setDestinationResolverForTesting,
  setListenerQuarantineForTesting,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
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

// Type-level half of the check: `check:typecheck-tests` fails if the patched declarations are missing. The
// callback must stay assignable with one parameter (existing callers) and must see the context with two.
const oneParameter: SandboxAskCallback = async ({ host }) => host === "example.com";
const twoParameters: SandboxAskCallback = async (_params, context?: SandboxAskContext) =>
  context?.attributionKey === "token" && context.identity === "listener";
type WrapOptions = NonNullable<Parameters<typeof SandboxManager.wrapWithSandbox>[4]>;
const ttysOption: WrapOptions["ttys"] = ["/dev/ttys001"];

/** The documentation address every `*.example.invalid` test name resolves to. */
const TEST_ADDRESS = "203.0.113.10";

/** The proxy resolves each destination name once, before asking; test names answer with a documentation address so the callback and dial are reached. */
async function testResolver(name: string): Promise<Array<{ address: string; family: number }>> {
  if (name.endsWith(".example.invalid")) return [{ address: TEST_ADDRESS, family: 4 }];
  const { lookup } = await import("node:dns/promises");
  return lookup(name, { all: true });
}

beforeEach(() => {
  setDestinationResolverForTesting(testResolver);
});
afterEach(() => {
  setDestinationResolverForTesting(undefined);
  setListenerQuarantineForTesting(undefined);
});

describe("patched @anthropic-ai/sandbox-runtime", () => {
  it("retains transport failures as a separate response and violation path", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    expect(manager).toContain("if (plan.failure !== undefined) throw plan.failure;");
    expect(manager).toContain("fail network-outbound");
    expect(manager).toContain("resolution.failure ?? new ProxyTransportError('dns'");
    const failure = readInstalled("dist/sandbox/proxy-failure.js");
    expect(failure).toContain("kind === 'timeout' ? 504 : 502");
    expect(failure).toContain("X-Proxy-Error: transport-");
    expect(failure).toContain("X-Proxy-Reason:");
    expect(readInstalled("dist/sandbox/proxy-failure.d.ts")).toContain("ProxyFailureKind");
    for (const proxy of ["http-proxy", "socks-proxy"]) {
      expect(readInstalled(`dist/sandbox/${proxy}.js`)).toContain("options.onTransportFailure?.");
      expect(readInstalled(`dist/sandbox/${proxy}.d.ts`)).toContain("onTransportFailure?");
    }
    expect(readInstalled("dist/sandbox/parent-proxy.js").match(/code: 'ETIMEDOUT'/g)).toHaveLength(3);
  });

  it("keeps non-device writes caller-owned and denies shell Unix sockets despite worker grants", () => {
    const runtime = readInstalled("dist/sandbox/sandbox-utils.js");
    const writes = functionBody(runtime, /\nexport function getDefaultWritePaths\(/u);
    expect(writes).toContain("'/dev/null'");
    expect(writes).not.toContain(".npm");
    expect(writes).not.toContain(".claude");
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    expect(manager).toContain("allowUnixSockets: options?.denyUnixSockets ? [] : getAllowUnixSockets(),");
    expect(manager.match(/allowAllUnixSockets: options\?\.denyUnixSockets \? false : getAllowAllUnixSockets\(\),/gu)).toHaveLength(2);
    expect(readInstalled("dist/sandbox/sandbox-manager.d.ts")).toContain("denyUnixSockets?: boolean;");
  });

  it("mounts Linux mandatory Git controls only when they exist", () => {
    const linux = readInstalled("dist/sandbox/linux-sandbox-utils.js");
    expect(functionBody(linux, /\nfunction gitControlExists\(/u)).toMatch(/error\?\.code === 'ENOENT' \|\| error\?\.code === 'ENOTDIR'/u);
    expect(linux).toContain("if (gitControlExists(hooksPath))");
    expect(linux).toContain("if (gitControlExists(configPath))");
    expect(linux).toContain("if (lower[at] !== '.git' || gitControlExists(denyPath))");
  });

  it("records exclusive mount creations and deletes only a quarantined matching identity", () => {
    const linux = readInstalled("dist/sandbox/linux-sandbox-utils.js");
    expect(linux).toContain("const bwrapMountPoints = new Map();");
    const create = functionBody(linux, /\nfunction createOwnedMountPoint\(/u);
    expect(create).toContain("fs.openSync(entry, 'wx', 0o444)");
    expect(create).toContain("fs.fstatSync(fd, { bigint: true })");
    expect(create).toContain("identity = publishOwnedDirectory(entry)");
    expect(create).toContain("identity = { dev: stat.dev, ino: stat.ino, kind, fd }");
    expect(create).toContain("bwrapMountPoints.set(dest, identity)");
    // Directories: identity from a descriptor on a private name, then moved onto an exclusive reservation.
    expect(functionBody(linux, /\nfunction directoryIdentity\(/u))
      .toContain("fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW");
    expect(functionBody(linux, /\nfunction directoryIdentity\(/u))
      .toContain("kind: MountPointKind.Directory, fd");
    const retire = functionBody(linux, /\nfunction releaseMountPointIdentity\(/u);
    expect(retire).toContain("identity.fd = undefined");
    expect(retire).toContain("fs.closeSync(fd)");
    const publish = functionBody(linux, /\nfunction publishOwnedDirectory\(/u);
    expect(publish).toContain("identity = directoryIdentity(staged)");
    expect(publish).toContain("fs.mkdirSync(entry, { mode: 0o700 })");
    expect(publish).toContain("fs.renameSync(staged, entry)");
    expect(functionBody(linux, /\nfunction sameMountPointIdentity\(/u))
      .toContain("stat.dev === identity.dev && stat.ino === identity.ino");
    // Cleanup: move to a private name, check there, delete only that.
    const remove = functionBody(linux, /\nfunction removeOwnedEntry\(/u);
    expect(remove).toContain("fs.renameSync(entry, quarantine)");
    expect(remove).toContain("const moved = fs.lstatSync(quarantine, { bigint: true })");
    expect(remove).toContain("fs.rmdirSync(quarantine)");
    expect(remove).toContain("fs.unlinkSync(quarantine)");
    expect(remove).not.toContain("fs.rmdirSync(entry)");
    expect(remove).not.toContain("fs.unlinkSync(entry)");
    const restore = functionBody(linux, /\nfunction restoreQuarantined\(/u);
    expect(restore).toContain("fs.linkSync(quarantine, entry)");
    const cleanup = functionBody(linux, /\nexport function cleanupBwrapMountPoints\(/u);
    expect(cleanup).toContain("removeOwnedEntry(mountPoint, identity)");
    expect(cleanup).toContain("removeOwnedEntry(emptyMountSourceDir, emptyMountSourceIdentity)");
    expect(cleanup).not.toContain("fs.statSync(");
    expect(cleanup).not.toContain("fs.rmdirSync(");
    expect(cleanup).not.toContain("fs.unlinkSync(");
    expect(linux).not.toContain("bwrapMountPoints.add(");
  });

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

  it("folds each macOS rule's sibling path filters into one regex", () => {
    const macos = readInstalled("dist/sandbox/macos-sandbox-utils.js");
    expect(functionBody(macos, /\nfunction renderRule\(/u)).toContain(
      "...(pathFilterCompaction ? compactPathFilters(filters) : [...filters]).map(f => `  ${f}`),",
    );
    expect(functionBody(macos, /\nexport function compactPathFilters\(/u)).toMatch(/SBPL_STRING_MAX_BYTES/u);
    expect(readInstalled("dist/sandbox/macos-sandbox-utils.d.ts")).toMatch(
      /export declare function compactPathFilters\(filters: Iterable<string>\): string\[\];/u,
    );
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

  it("passes the decoded attribution key to the ask callback, by name first and resolved only after a name allow", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    const byName = functionBody(manager, /\nasync function decideByName\(/u);
    // The same `encodedCommand` the deny path hands recordOutboundDeny.
    expect(byName).toMatch(/recordOutboundDeny\(host, port, reason, encodedCommand\)/u);
    // Decoded once; the per-command lists are looked up by the same key.
    expect(byName).toMatch(
      /const attributionKey = encodedCommand\s+\? decodeSandboxedCommand\(encodedCommand\)\s+: undefined;/u,
    );
    expect(byName).toMatch(/commandNetworkListsByKey\.get\(attributionKey\)/u);
    expect(byName).toMatch(/askSandboxCallback\(sandboxAskCallback, host, port, \{ attributionKey, identity, phase: 'name' \}, denied\)/u);
    // Nothing in the name phase resolves or routes.
    expect(byName).not.toMatch(/planDestination|resolveAddresses|routesFor|destinationResolver/u);
    // Only an invocation listener's filter says 'listener'; the shared front end's default is the forgeable username.
    expect(byName.startsWith("async function decideByName(port, host, sandboxAskCallback, encodedCommand, explain, identity = 'username')")).toBe(true);
    // Ave runs non-strict with an empty allowlist, so the callback is the gate: without one the request is refused.
    expect(byName).toMatch(/if \(!sandboxAskCallback\) \{\n[^\n]*\n\s+return denied\('host is not on the allow list'\);/u);
    const resolved = functionBody(manager, /\nasync function confirmResolvedDestination\(/u);
    expect(resolved).toMatch(/phase: 'resolved',\s+addresses: plan\.addresses\.map\(a => a\.address\),\s+resolution: plan\.viaUpstream \? 'upstream' : 'pinned',/u);
    const ask = functionBody(manager, /\nasync function askSandboxCallback\(/u);
    // The runtime allows only on a literal `true`; the patch must not loosen it.
    expect(ask).toMatch(/if \(answer === true\)/u);
    // When it throws, the request is refused.
    expect(ask).toMatch(/catch \(error\) \{\n[\s\S]{0,200}?return denied\('permission prompt failed'\);\n\s+\}\n\}/u);
    const decide = functionBody(manager, /\nasync function decideDestination\(/u);
    // Order: name phase, then the plan (routes and DNS), then the resolved phase.
    const order = ["decideByName(", "planDestination(", "confirmResolvedDestination("].map((call) => decide.indexOf(call));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(decide).toMatch(/if \(byName === 'deny'\)\s+return undefined;/u);
    expect(decide).toContain("if (byName === 'ask' && decisionClass !== approvedClass)");
    const schemas = readInstalled("dist/sandbox/sandbox-schemas.d.ts");
    expect(schemas).toMatch(/export type SandboxAskContext = SandboxAskNameContext \| SandboxAskResolvedContext;/u);
    expect(schemas).toMatch(/export type SandboxAskNameContext = SandboxAskIdentity & \{\s+phase: 'name';\s+\};/u);
    expect(schemas).toMatch(
      /export type SandboxAskResolvedContext = SandboxAskIdentity & \{\s+phase: 'resolved';\s+\/\*\*[\s\S]*?\*\/\s+addresses: readonly string\[\];\s+\/\*\*[\s\S]*?\*\/\s+resolution: 'pinned' \| 'upstream';\s+\};/u,
    );
    expect(schemas).toMatch(
      /export type SandboxAskCallback = \(params: NetworkHostPattern, context\?: SandboxAskContext\) => Promise<boolean \| \{\s+allow: false;\s+reason: string;\s+\}>;/u,
    );
    expect(readInstalled("dist/index.d.ts")).toMatch(/export type \{ SandboxAskCallback, SandboxAskContext, SandboxAskNameContext, SandboxAskResolvedContext,/u);
  });

  it("lets a Windows embedder run the proxy without srt-win, and then refuses srt-win wraps", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    const steps = functionBody(manager, /\nasync function initializeSteps\(/u);
    // The external-confinement branch comes first and the srt-win block is its else.
    expect(steps).toMatch(
      /if \(getPlatform\(\) === 'windows' &&\s+runtimeConfig\.windows\?\.externalConfinement === 'embedder'\) \{[\s\S]*?\}\s+else if \(getPlatform\(\) === 'windows'\) \{\s+\/\/ Resolve once/u,
    );
    // initialize() checks dependencies before those steps; that check must not demand srt-win either, or the proxy never starts where it is needed.
    const deps = functionBody(manager, /\nfunction checkDependenciesCommon\(/u);
    expect(deps).toMatch(
      /else if \(platform === 'windows' &&\s+config\?\.windows\?\.externalConfinement === 'embedder'\) \{[\s\S]*?return \{ done: \{ errors, warnings \} \};\s+\}\s+else if \(platform === 'windows'\) \{\s+let srtWin;/u,
    );
    const argv = functionBody(manager, /\nasync function wrapWithSandboxArgv\(/u);
    const refusal = argv.search(/config\?\.windows\?\.externalConfinement === 'embedder'\) \{\s+\/\/ Ave patch[^\n]*\n[^\n]*\n\s+throw new Error\('wrapWithSandboxArgv\(\) is unavailable/u);
    expect(refusal, "wrapWithSandboxArgv does not refuse under external confinement").toBeGreaterThanOrEqual(0);
    // Before any srt-win work in the Windows branch.
    expect(refusal).toBeLessThan(argv.indexOf("waitForNetworkInitialization()"));
  });

  it("types the callback so one-parameter callers still fit and two-parameter callers see the key", async () => {
    const params = { host: "example.com", port: 443 };
    await expect(oneParameter(params)).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: "token", identity: "listener", phase: "resolved", addresses: [], resolution: "pinned" })).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: "token", identity: "listener", phase: "name" })).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: "token", identity: "username", phase: "name" })).resolves.toBe(false);
    await expect(twoParameters(params, { attributionKey: undefined, identity: "username", phase: "name" })).resolves.toBe(false);
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
    expect(filter).toMatch(/const resolved = await decideDestination\(port, host, sandboxAskCallback, lane\.encodedKey, explain, 'listener', plainHttp\);/u);
    expect(filter).toMatch(/pinDestination\(socket, host, port, resolved\);/u);
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

/** Behavioural half: through the real proxy, the key a wrap's proxy username names reaches the ask callback's second
 * argument. The proxy URL (with the per-process credential) is read out of the wrapped command and used only inside this process. */
describe.runIf(process.platform === "darwin" || process.platform === "linux")("ask callback attribution through the proxy", () => {
  /** CONNECT `destination` through a host-side proxy front end (a port, or a Linux socket path); `proxy` gives only the credential. */
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
        // A refused or reset connection is the answer for an ended listener (macOS keeps the port and drops the socket; Linux removes the path).
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

  /** Exchange actual SOCKS5 username/password and CONNECT frames through the invocation front end. */
  async function socksThrough(
    front: number | string,
    proxy: URL,
    username: string,
    host: string,
    port: number,
    password = decodeURIComponent(proxy.password),
  ): Promise<{ authentication: number; reply?: number }> {
    const { connect } = await import("node:net");
    const socket = typeof front === "number" ? connect(front, "127.0.0.1") : connect(front);
    socket.on("error", () => {});
    socket.setTimeout(10_000, () => socket.destroy(new Error("SOCKS exchange timed out")));
    const read = async (length: number): Promise<Buffer> => {
      for (;;) {
        const bytes = socket.read(length) as Buffer | null;
        if (bytes !== null) {
          if (bytes.length !== length) throw new Error("SOCKS exchange ended early");
          return bytes;
        }
        if (socket.destroyed || socket.readableEnded) throw new Error("SOCKS exchange ended early");
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            socket.off("readable", readable);
            socket.off("close", closed);
            socket.off("error", failed);
          };
          const readable = (): void => { cleanup(); resolve(); };
          const closed = (): void => { cleanup(); reject(new Error("SOCKS exchange ended early")); };
          const failed = (error: Error): void => { cleanup(); reject(error); };
          socket.once("readable", readable);
          socket.once("close", closed);
          socket.once("error", failed);
        });
      }
    };
    try {
      socket.write(Buffer.from([5, 1, 2]));
      expect(await read(2)).toEqual(Buffer.from([5, 2]));
      const user = Buffer.from(username);
      const pass = Buffer.from(password);
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await read(2);
      expect(auth[0]).toBe(1);
      const authentication = auth[1]!;
      if (authentication !== 0) return { authentication };
      const name = Buffer.from(host);
      const destinationPort = Buffer.alloc(2);
      destinationPort.writeUInt16BE(port);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, destinationPort]));
      const head = await read(4);
      expect(head[0]).toBe(5);
      expect(head[2]).toBe(0);
      const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await read(1))[0]! : undefined;
      if (addressLength === undefined) throw new Error("SOCKS reply has an unknown address kind");
      await read(addressLength + 2);
      return { authentication, reply: head[1]! };
    } finally {
      socket.destroy();
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

  /** The resolved-phase asks: what a destination resolved to and how it is reached, asked only after a
   * name-phase allow. A refusal the proxy makes before that (a route, an address) shows up as no resolved ask. */
  function resolvedAsks(asked: Array<{ host: string; context: SandboxAskContext | undefined }>): Array<{ host: string; context: SandboxAskContext | undefined }> {
    return asked.filter((entry) => entry.context?.phase === "resolved");
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
      // On Linux the URL names the relay inside the sandbox's network namespace; the host side listens on the proxy's own port.
      const port = SandboxManager.getProxyPort();
      expect(port).toBeTypeOf("number");
      expect(await connectThrough(port!, proxy, decodeURIComponent(proxy.username))).toMatch(/^HTTP\/1\.1 403/u);
      expect(await connectThrough(port!, proxy, "srt")).toMatch(/^HTTP\/1\.1 403/u);
      // Refused by name: never resolved, never asked again.
      expect(asked).toEqual([
        { attributionKey: commandId, identity: "username", phase: "name" },
        { attributionKey: undefined, identity: "username", phase: "name" },
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
      expect(asked).toEqual([{ host: "unlisted.example.invalid", context: { attributionKey: first, identity: "listener", phase: "name" } }]);
      // Another key on this listener, and this key on another's: never asked. The proxy username is `srt.` plus the base64 of the commandId.
      expect(ownName).toBe(`srt.${Buffer.from(first).toString("base64")}`);
      const secondName = `srt.${Buffer.from(second).toString("base64")}`;
      expect(await connectThrough(firstFront, proxy, secondName)).toMatch(/^HTTP\/1\.1 403/u);
      expect(await connectThrough(frontOf(secondListener), proxy, ownName)).toMatch(/^HTTP\/1\.1 403/u);
      // A hop through its own listener onto a proxy front end: refused before the callback, for the shared port and (macOS) the other listener's.
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

  /** A stand-in upstream proxy: answers every CONNECT 200 and keeps the tunnel open, except a
   * CONNECT whose authority is in `disconnect`, closed without an HTTP answer (a transport failure). */
  async function fakeUpstream(disconnect: readonly string[] = []): Promise<{ port: number; connects: string[]; close: () => Promise<void> }> {
    const { createServer } = await import("node:net");
    const connects: string[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", (chunk: Buffer) => {
        const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
        connects.push(line);
        const authority = line.split(" ")[1] ?? "";
        if (disconnect.includes(authority)) socket.destroy();
        else if (!line.startsWith("CONNECT ")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        else socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
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
      // A name that answers a public address to the check and this host's loopback to any later lookup (the upstream's, or a second one here).
      const rebind = rebinding("rebind.example.test", ["198.51.100.7", "127.0.0.1"]);
      setDestinationResolverForTesting(rebind.resolver);
      expect(await connectThrough(front, proxy, name, `rebind.example.test:${proxyPort}`)).toMatch(/^HTTP\/1\.1 200/u);
      expect(upstream.connects).toEqual([`CONNECT 198.51.100.7:${proxyPort} HTTP/1.1`]);
      expect(rebind.calls()).toBe(1);
      expect(resolvedAsks(asked)).toEqual([{
        host: "rebind.example.test",
        context: { attributionKey: commandId, identity: "listener", phase: "resolved", addresses: ["198.51.100.7"], resolution: "pinned" },
      }]);
      // A name that resolves to this host now: refused before asking or forwarding.
      setDestinationResolverForTesting(rebinding("local.example.test", ["127.0.0.1"]).resolver);
      expect(await connectThrough(front, proxy, name, `local.example.test:${proxyPort}`)).toMatch(/^HTTP\/1\.1 403/u);
      // A name that does not resolve here: nothing could be pinned, so refused.
      setDestinationResolverForTesting(async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      });
      expect(await connectThrough(front, proxy, name, "split.example.test:443")).toMatch(/^HTTP\/1\.1 403/u);
      // Plain HTTP by name through an upstream on this host that is not trusted to resolve names:
      // the absolute-form target would let it resolve the name, so it is refused; a literal goes.
      setDestinationResolverForTesting(testResolver);
      expect(await plainHttpThrough(front, proxy, name, "http://plain.example.invalid/")).toMatch(/^HTTP\/1\.1 403/u);
      expect(upstream.connects).toHaveLength(1);
      // Refused before the resolved phase: nobody confirms a request that cannot be sent.
      expect(resolvedAsks(asked).map((a) => a.host)).toEqual(["rebind.example.test"]);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });

  it("through an upstream proxy, tries each vetted address in turn (IPv4 first) until the upstream opens one", async (test) => {
    const proxyPort = 4443;
    // The upstream cannot reach the first IPv4 address; the next vetted one is tried.
    const upstream = await fakeUpstream([`198.51.100.7:${proxyPort}`]);
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
          async () => true,
        );
      } catch (error) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
        test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
        return;
      }
      const commandId = "7".repeat(16) + "0123456789abcdef";
      const listener = await SandboxManager.openInvocationListener(commandId);
      const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
      const name = `srt.${Buffer.from(commandId).toString("base64")}`;
      // The resolver answers IPv6 first; the upstream is tried with IPv4 first.
      setDestinationResolverForTesting(async (asked) => asked === "dual.example.test"
        ? [{ address: "2001:db8::7", family: 6 }, { address: "198.51.100.7", family: 4 }, { address: "198.51.100.8", family: 4 }]
        : testResolver(asked));
      expect(await connectThrough(frontOf(listener), proxy, name, `dual.example.test:${proxyPort}`)).toMatch(/^HTTP\/1\.1 200/u);
      expect(upstream.connects).toEqual([
        `CONNECT 198.51.100.7:${proxyPort} HTTP/1.1`,
        `CONNECT 198.51.100.8:${proxyPort} HTTP/1.1`,
      ]);
      // An upstream that reaches only IPv6: every IPv4 address fails, then the IPv6 one opens.
      upstream.connects.length = 0;
      setDestinationResolverForTesting(async (asked) => asked === "v6only.example.test"
        ? [{ address: "2001:db8::9", family: 6 }, { address: "198.51.100.7", family: 4 }]
        : testResolver(asked));
      expect(await connectThrough(frontOf(listener), proxy, name, `v6only.example.test:${proxyPort}`)).toMatch(/^HTTP\/1\.1 200/u);
      expect(upstream.connects).toEqual([
        `CONNECT 198.51.100.7:${proxyPort} HTTP/1.1`,
        `CONNECT [2001:db8::9]:${proxyPort} HTTP/1.1`,
      ]);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });

  /** Resolves like testResolver, except `*.corp.test` names, which do not resolve on this host. */
  async function corpResolver(name: string): Promise<Array<{ address: string; family: number }>> {
    if (name.endsWith(".corp.test")) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return testResolver(name);
  }

  /** Initialize with `parentProxy` and an asking callback; a listener and its proxy credential. */
  async function withUpstream(
    test: { skip: (note: string) => void },
    parentProxy: { http: string; https: string; resolvesNames?: boolean },
    answer: boolean,
  ): Promise<{
    SandboxManager: typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;
    asked: Array<{ host: string; context: SandboxAskContext | undefined }>;
    front: number | string;
    proxy: URL;
    name: string;
  } | undefined> {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const asked: Array<{ host: string; context: SandboxAskContext | undefined }> = [];
    try {
      await SandboxManager.initialize(
        { network: { allowedDomains: [], deniedDomains: [], parentProxy }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
        async ({ host }, context) => {
          asked.push({ host, context });
          // The name phase lets every destination on, so the resolved phase is what is tested.
          return context?.phase === "name" ? true : answer;
        },
      );
    } catch (error) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
      test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
      return undefined;
    }
    setDestinationResolverForTesting(corpResolver);
    const commandId = "6".repeat(16) + "0123456789abcdef";
    const listener = await SandboxManager.openInvocationListener(commandId);
    const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
    return { SandboxManager, asked, front: frontOf(listener), proxy, name: `srt.${Buffer.from(commandId).toString("base64")}` };
  }

  it("forwards a name this host cannot resolve to a remote upstream, as unverified (resolution: upstream)", async (test) => {
    // A documentation address: not this host, so the upstream counts as remote.
    const setup = await withUpstream(test, { http: "http://192.0.2.1:3128", https: "http://192.0.2.1:3128" }, false);
    if (setup === undefined) return;
    try {
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "intranet.corp.test:443")).toMatch(/^HTTP\/1\.1 403/u);
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "public.example.invalid:443")).toMatch(/^HTTP\/1\.1 403/u);
      expect(resolvedAsks(setup.asked)).toEqual([
        { host: "intranet.corp.test", context: { attributionKey: "6".repeat(16) + "0123456789abcdef", identity: "listener", phase: "resolved", addresses: [], resolution: "upstream" } },
        // A name this host resolves stays pinned, upstream or not.
        { host: "public.example.invalid", context: { attributionKey: "6".repeat(16) + "0123456789abcdef", identity: "listener", phase: "resolved", addresses: [TEST_ADDRESS], resolution: "pinned" } },
      ]);
    } finally {
      await setup.SandboxManager.reset();
    }
  });

  it("refuses a name this host cannot resolve when the upstream runs on this host, unless trusted to resolve names", async (test) => {
    const upstream = await fakeUpstream();
    const url = `http://127.0.0.1:${upstream.port}`;
    try {
      const refused = await withUpstream(test, { http: url, https: url }, true);
      if (refused === undefined) return;
      try {
        expect(await connectThrough(refused.front, refused.proxy, refused.name, "intranet.corp.test:443"))
          .toMatch(/^HTTP\/1\.1 403 .*upstream proxy on this host resolves names itself/u);
        expect(resolvedAsks(refused.asked)).toEqual([]);
        expect(upstream.connects).toEqual([]);
      } finally {
        await refused.SandboxManager.reset();
      }
      const trusted = await withUpstream(test, { http: url, https: url, resolvesNames: true }, true);
      if (trusted === undefined) return;
      try {
        expect(await connectThrough(trusted.front, trusted.proxy, trusted.name, "intranet.corp.test:443")).toMatch(/^HTTP\/1\.1 200/u);
        expect(await plainHttpThrough(trusted.front, trusted.proxy, trusted.name, "http://wiki.corp.test/")).toMatch(/^HTTP\/1\.1 200/u);
        // Forwarded by name: the upstream resolves it.
        expect(upstream.connects).toEqual(["CONNECT intranet.corp.test:443 HTTP/1.1", "GET http://wiki.corp.test/ HTTP/1.1"]);
        expect(resolvedAsks(trusted.asked).map((a) => [a.host, a.context?.phase === "resolved" ? a.context.resolution : undefined])).toEqual([
          ["intranet.corp.test", "upstream"],
          ["wiki.corp.test", "upstream"],
        ]);
      } finally {
        await trusted.SandboxManager.reset();
      }
    } finally {
      await upstream.close();
    }
  });

  it("judges the proxy the dial actually reached: a proxy name that resolves remote at the check and loopback at the dial is refused", async (test) => {
    const upstream = await fakeUpstream();
    const url = `http://proxy.rebind.test:${upstream.port}`;
    try {
      const setup = await withUpstream(test, { http: url, https: url }, true);
      if (setup === undefined) return;
      // The check (planDestination: the one route this destination takes) sees a remote address; the dial's lookup, the next call, gets this host's loopback.
      let calls = 0;
      setDestinationResolverForTesting(async (name) => {
        if (name !== "proxy.rebind.test") return corpResolver(name);
        calls += 1;
        return [{ address: calls <= 1 ? "198.51.100.50" : "127.0.0.1", family: 4 }];
      });
      try {
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "intranet.corp.test:443"))
          .toMatch(/^HTTP\/1\.1 403 .*upstream proxy on this host resolves names itself/u);
        expect(calls).toBe(2);
        calls = 0;
        expect(await plainHttpThrough(setup.front, setup.proxy, setup.name, "http://wiki.corp.test/"))
          .toMatch(/^HTTP\/1\.1 403/u);
        expect(calls).toBe(2);
        // Nothing was written to the proxy the dial reached.
        expect(upstream.connects).toEqual([]);
        expect(resolvedAsks(setup.asked).map((a) => (a.context?.phase === "resolved" ? a.context.resolution : undefined))).toEqual(["upstream", "upstream"]);
      } finally {
        await setup.SandboxManager.reset();
      }
    } finally {
      await upstream.close();
    }
  });

  it("counts an upstream named localhost or at one of this host's interface addresses as on this host", async (test) => {
    const { networkInterfaces } = await import("node:os");
    const own = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4")?.address;
    const urls = ["http://localhost:3128", "http://proxy.localhost:3128", ...(own === undefined ? [] : [`http://${own}:3128`])];
    if (own === undefined && process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("no non-loopback interface address here");
    for (const url of urls) {
      const setup = await withUpstream(test, { http: url, https: url }, true);
      if (setup === undefined) return;
      try {
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "intranet.corp.test:443"), url)
          .toMatch(/^HTTP\/1\.1 403 .*upstream proxy on this host resolves names itself/u);
        expect(resolvedAsks(setup.asked), url).toEqual([]);
      } finally {
        await setup.SandboxManager.reset();
      }
    }
  });

  it("keeps the test seams off SandboxManager and the package entry, and refuses them outside the test runner", async () => {
    const entry = await import("@anthropic-ai/sandbox-runtime");
    for (const seam of ["setDestinationResolverForTesting", "setListenerQuarantineForTesting"]) {
      expect(Object.keys(entry)).not.toContain(seam);
      expect(Object.keys(entry.SandboxManager)).not.toContain(seam);
      expect(seam in entry.SandboxManager).toBe(false);
    }
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env };
    delete env.VITEST;
    const script = `import(${JSON.stringify(pathToFileURL(join(sandboxDir, "sandbox-manager.js")).href)})`
      + ".then((m) => { for (const f of [m.setDestinationResolverForTesting, m.setListenerQuarantineForTesting]) {"
      + " try { f(undefined); console.log('allowed'); } catch (e) { console.log(String(e.message)); } } })";
    const out = execFileSync(process.execPath, ["-e", script], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
    expect(out.trim().split("\n")).toEqual([
      "setDestinationResolverForTesting is a test seam and is available only under the test runner",
      "setListenerQuarantineForTesting is a test seam and is available only under the test runner",
    ]);
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
        // An IP rule lets a name use this loopback address (the guard refuses loopback for a name otherwise), so the pinned dial has a target.
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
      setDestinationResolverForTesting(rebind.resolver);
      const name = `srt.${Buffer.from(commandId).toString("base64")}`;
      expect(await connectThrough(frontOf(listener), proxy, name, `pin.example.test:${canaryPort}`)).toMatch(/^HTTP\/1\.1 200/u);
      expect(rebind.calls()).toBe(1);
      expect(resolvedAsks(asked)).toEqual([{
        host: "pin.example.test",
        context: { attributionKey: commandId, identity: "listener", phase: "resolved", addresses: ["127.0.0.1"], resolution: "pinned" },
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
      setListenerQuarantineForTesting(100);
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

  /** An upstream that records each request's first line and its Proxy-Authorization header, and answers `status` to every request (`200` keeps a CONNECT tunnel open). */
  async function recordingUpstream(status: 200 | 403 | 407 | 502 | 503 | 504): Promise<{ port: number; requests: Array<{ line: string; authorization: string | undefined }>; close: () => Promise<void> }> {
    const { createServer } = await import("node:net");
    const requests: Array<{ line: string; authorization: string | undefined }> = [];
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let head = "";
      const onData = (chunk: Buffer): void => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        socket.removeListener("data", onData);
        const lines = head.split("\r\n");
        const authorization = lines.find((l) => /^proxy-authorization:/iu.test(l))?.replace(/^[^:]+:\s*/u, "");
        requests.push({ line: lines[0] ?? "", authorization });
        if (status === 407) socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"up\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        else if (status !== 200) socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        else if (!(lines[0] ?? "").startsWith("CONNECT ")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        else socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      };
      socket.on("data", onData);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    return {
      port,
      requests,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** A loopback port nothing listens on (bound, then released). */
  async function deadPort(): Promise<number> {
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  type Router = Parameters<typeof import("@anthropic-ai/sandbox-runtime").SandboxManager.setParentProxyRouter>[0];

  /** Ave's production shape: no static upstream, the route hook installed, every ask allowed. */
  async function withRouter(test: { skip: (note: string) => void }, router: Router) {
    const setup = await withUpstream(test, { http: "", https: "" }, true);
    if (setup === undefined) return undefined;
    setup.SandboxManager.setParentProxyRouter(router);
    return setup;
  }

  it("routes each destination by the router's answer, asked once per decision with the canonical host, port and scheme", async (test) => {
    const first = await recordingUpstream(200);
    const second = await recordingUpstream(200);
    const calls: Array<{ host: string; port: number; scheme: string }> = [];
    try {
      const setup = await withRouter(test, async (destination) => {
        calls.push(destination);
        const port = destination.host === "a.example.invalid" ? first.port : second.port;
        return { routes: [{ kind: "http", host: "127.0.0.1", port }] };
      });
      if (setup === undefined) return;
      try {
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "A.Example.Invalid.:443")).toMatch(/^HTTP\/1\.1 200/u);
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "b.example.invalid:8443")).toMatch(/^HTTP\/1\.1 200/u);
        expect(await plainHttpThrough(setup.front, setup.proxy, setup.name, `http://${TEST_ADDRESS}/x`)).toMatch(/^HTTP\/1\.1 200/u);
        expect(calls).toEqual([
          { host: "a.example.invalid", port: 443, scheme: "https" },
          { host: "b.example.invalid", port: 8443, scheme: "https" },
          { host: TEST_ADDRESS, port: 80, scheme: "http" },
        ]);
        // Pinned per destination: each name went to its own upstream as the vetted literal.
        expect(first.requests.map((r) => r.line)).toEqual([`CONNECT ${TEST_ADDRESS}:443 HTTP/1.1`]);
        expect(second.requests.map((r) => r.line)).toEqual([
          `CONNECT ${TEST_ADDRESS}:8443 HTTP/1.1`,
          `GET http://${TEST_ADDRESS}/x HTTP/1.1`,
        ]);
        expect(resolvedAsks(setup.asked).map((a) => (a.context?.phase === "resolved" ? a.context.resolution : undefined))).toEqual(["pinned", "pinned", "pinned"]);
      } finally {
        await setup.SandboxManager.reset();
      }
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("tries the routes in order: a proxy that refuses the connection hands over to the next", async (test) => {
    const good = await recordingUpstream(200);
    const dead = await deadPort();
    try {
      const setup = await withRouter(test, async () => ({
        routes: [{ kind: "http", host: "127.0.0.1", port: dead }, { kind: "http", host: "127.0.0.1", port: good.port }],
      }));
      if (setup === undefined) return;
      try {
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "fallback.example.invalid:443")).toMatch(/^HTTP\/1\.1 200/u);
        expect(await plainHttpThrough(setup.front, setup.proxy, setup.name, `http://${TEST_ADDRESS}/`)).toMatch(/^HTTP\/1\.1 200/u);
        expect(good.requests.map((r) => r.line)).toEqual([`CONNECT ${TEST_ADDRESS}:443 HTTP/1.1`, `GET http://${TEST_ADDRESS}/ HTTP/1.1`]);
      } finally {
        await setup.SandboxManager.reset();
      }
    } finally {
      await good.close();
    }
  });

  it.for([403, 407, 502, 503, 504] as const)("keeps HTTP %i final across addresses and routes", async (status, test) => {
    const refusing = await recordingUpstream(status);
    const next = await recordingUpstream(200);
    const setup = await withRouter(test, async () => ({ routes: [
      { kind: "http", host: "127.0.0.1", port: refusing.port },
      { kind: "http", host: "127.0.0.1", port: next.port },
      { kind: "direct" },
    ] }));
    try {
      if (setup === undefined) return;
      setDestinationResolverForTesting(async (name) => name === "multi.example.invalid"
        ? [{ address: "198.51.100.7", family: 4 }, { address: "198.51.100.8", family: 4 }, { address: "2001:db8::7", family: 6 }]
        : testResolver(name));
      const response = await connectThrough(setup.front, setup.proxy, setup.name, "multi.example.invalid:443");
      expect(response).toBe(status === 502 ? "HTTP/1.1 502 Bad Gateway" : status === 504 ? "HTTP/1.1 504 Gateway Timeout"
        : status === 407 ? "HTTP/1.1 403 upstream proxy requires authentication"
        : `HTTP/1.1 403 upstream proxy refused the connection (HTTP ${status})`);
      expect(refusing.requests.map(r => r.line)).toEqual(["CONNECT 198.51.100.7:443 HTTP/1.1"]);
      const plain = await plainHttpThrough(setup.front, setup.proxy, setup.name, "http://198.51.100.7/");
      expect(plain).toMatch(new RegExp(`^HTTP/1\\.1 ${status === 407 ? 403 : status} `, "u"));
      expect(refusing.requests).toHaveLength(2);
      expect(next.requests).toEqual([]);
    } finally {
      await setup?.SandboxManager.reset();
      await refusing.close();
      await next.close();
    }
  });

  it.each([false, true])("replans a held destination DNS decision from Off to Manual (plain HTTP: %s)", async (plainHttp) => {
    const { createServer } = await import("node:net");
    const { createUpstreamProxyRouter } = await import("../../src/permissions/upstream-proxy.js");
    const { DEFAULT_UPSTREAM_PROXY } = await import("../../src/shared/upstream-proxy.js");
    let directConnections = 0;
    const canary = createServer(socket => { directConnections++; socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"); });
    await new Promise<void>(resolve => canary.listen(0, "127.0.0.1", resolve));
    const port = (canary.address() as import("node:net").AddressInfo).port;
    const upstream = await recordingUpstream(200);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    let settings = { ...DEFAULT_UPSTREAM_PROXY, mode: "off" as "off" | "manual" };
    const router = createUpstreamProxyRouter({ settings: () => settings, manualCredentials: () => null, env: () => ({}) });
    const phases: Array<SandboxAskContext["phase"]> = [];
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    try {
      SandboxManager.setParentProxyRouter(router.router);
      await SandboxManager.initialize({ network: { allowedDomains: [`127.0.0.1:${port}`], deniedDomains: [], parentProxy: { http: "", https: "" } }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }, async (_params, context) => {
        if (context) phases.push(context.phase);
        return true;
      });
      const commandId = "3".repeat(32);
      const listener = await SandboxManager.openInvocationListener(commandId);
      const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
      setDestinationResolverForTesting(async name => {
        if (name !== "held.example.test") return testResolver(name);
        entered(); await held;
        return [{ address: "127.0.0.1", family: 4 }];
      });
      const user = `srt.${Buffer.from(commandId).toString("base64")}`;
      const pending = plainHttp
        ? plainHttpThrough(frontOf(listener), proxy, user, `http://held.example.test:${port}/`)
        : connectThrough(frontOf(listener), proxy, user, `held.example.test:${port}`);
      await started;
      settings = { ...settings, mode: "manual", manualUrl: `http://127.0.0.1:${upstream.port}`, resolvesNames: true };
      router.invalidate();
      SandboxManager.closeAllInvocationConnections();
      release();
      expect(await pending).toMatch(/^HTTP\/1\.1 200/u);
      expect(directConnections).toBe(0);
      expect(upstream.requests.map(r => r.line)).toEqual([plainHttp
        ? `GET http://held.example.test:${port}/ HTTP/1.1` : `CONNECT 127.0.0.1:${port} HTTP/1.1`]);
      expect(phases).toEqual(["name", "resolved"]);
    } finally {
      release();
      await SandboxManager.reset();
      await upstream.close();
      await new Promise<void>(resolve => canary.close(() => resolve()));
    }
  });

  it.each([
    ["name", false, 1], ["route", false, 1], ["resolved", false, 1], ["resolved", true, 2], ["proxy-dns", false, 1],
  ] as const)("replans pending %s work and only repeats a changed class (plain HTTP: %s)", async (stage, plainHttp, resolvedCount) => {
    const { createUpstreamProxyRouter } = await import("../../src/permissions/upstream-proxy.js");
    const { DEFAULT_UPSTREAM_PROXY } = await import("../../src/shared/upstream-proxy.js");
    const old = await recordingUpstream(200);
    const next = await recordingUpstream(200);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    let settings = { ...DEFAULT_UPSTREAM_PROXY, mode: stage === "route" ? "system" : stage === "proxy-dns" ? "manual" : "off", manualUrl: `http://old-proxy.example.test:${old.port}` } as import("../../src/shared/upstream-proxy.js").UpstreamProxySettings;
    let release!: () => void;
    let enter!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const phases: Array<SandboxAskContext["phase"]> = [];
    const router = createUpstreamProxyRouter({
      settings: () => settings, manualCredentials: () => null, env: () => ({}),
      resolveProxy: async () => { enter(); await hold; return "DIRECT"; },
    });
    try {
      SandboxManager.setParentProxyRouter(router.router);
      await SandboxManager.initialize({ network: { allowedDomains: [], deniedDomains: [], parentProxy: { http: "", https: "" } }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } }, async (_params, context) => {
        if (context) phases.push(context.phase);
        if (context?.phase === stage) { enter(); await hold; }
        return true;
      });
      const commandId = "4".repeat(32);
      const listener = await SandboxManager.openInvocationListener(commandId);
      const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
      setDestinationResolverForTesting(async name => {
        if (name === "old-proxy.example.test") { enter(); await hold; return [{ address: "127.0.0.1", family: 4 }]; }
        return testResolver(name);
      });
      const user = `srt.${Buffer.from(commandId).toString("base64")}`;
      const pending = plainHttp ? plainHttpThrough(frontOf(listener), proxy, user, "http://change.example.invalid/")
        : connectThrough(frontOf(listener), proxy, user, "change.example.invalid:443");
      await entered;
      settings = { ...settings, mode: "manual", manualUrl: `http://127.0.0.1:${next.port}`, resolvesNames: true };
      router.invalidate();
      release();
      expect(await pending).toMatch(/^HTTP\/1\.1 200/u);
      expect(old.requests).toEqual([]);
      expect(next.requests).toHaveLength(1);
      expect(phases.filter(phase => phase === "name")).toHaveLength(1);
      expect(phases.filter(phase => phase === "resolved")).toHaveLength(resolvedCount);
    } finally {
      release();
      await SandboxManager.reset();
      await old.close();
      await next.close();
    }
  });

  it("switches an authenticated SOCKS connection to the current upstream with its bound credentials", async (test) => {
    const { createUpstreamProxyRouter } = await import("../../src/permissions/upstream-proxy.js");
    const { DEFAULT_UPSTREAM_PROXY } = await import("../../src/shared/upstream-proxy.js");
    const old = await recordingUpstream(200);
    let next: Awaited<ReturnType<typeof recordingUpstream>> | undefined;
    let setup: Awaited<ReturnType<typeof withRouter>>;
    let pending: ReturnType<typeof socksThrough> | undefined;
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    try {
      next = await recordingUpstream(200);
      const oldOrigin = `http://old-proxy.example.test:${old.port}`;
      const nextOrigin = `http://127.0.0.1:${next.port}`;
      let settings = { ...DEFAULT_UPSTREAM_PROXY, mode: "manual" as const, manualUrl: oldOrigin };
      // Different throwaway credentials identify which service receives the handshake.
      let credentials = { username: "old-wire-user", password: "old-wire-only", origin: oldOrigin };
      const upstream = createUpstreamProxyRouter({ settings: () => settings, manualCredentials: () => credentials, env: () => ({}) });
      setup = await withRouter(test, upstream.router);
      if (setup === undefined) return;
      setDestinationResolverForTesting(async name => {
        if (name === "old-proxy.example.test") { enter(); await held; return [{ address: "127.0.0.1", family: 4 }]; }
        return testResolver(name);
      });
      pending = socksThrough(setup.front, setup.proxy, setup.name, "switch.example.invalid", 443);
      await Promise.race([entered, pending.then(() => { throw new Error("SOCKS exchange finished before the DNS hold"); })]);
      expect(old.requests).toHaveLength(0);
      expect(next.requests).toHaveLength(0);
      settings = { ...settings, manualUrl: nextOrigin };
      credentials = { username: "new-wire-user", password: "new-wire-only", origin: nextOrigin };
      // Keep this client open to exercise rerouting independently of tunnel closure.
      upstream.invalidate();
      release();
      expect(await pending).toEqual({ authentication: 0, reply: 0 });
      expect(old.requests).toHaveLength(0);
      expect(next.requests.map(request => request.line)).toEqual([`CONNECT ${TEST_ADDRESS}:443 HTTP/1.1`]);
      const expectedAuth = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
      expect(next.requests[0]?.authorization === expectedAuth).toBe(true);
      expect(setup.asked.map(ask => ask.context?.phase)).toEqual(["name", "resolved"]);
      expect(setup.asked.every(ask => ask.context?.identity === "listener")).toBe(true);
    } finally {
      release();
      await pending?.catch(() => {});
      try {
        await setup?.SandboxManager.reset();
      } finally {
        await Promise.all([old.close(), next?.close()]);
      }
    }
  });

  it.for(["bad-password", "foreign-invocation"] as const)("refuses SOCKS %s before route lookup or DNS", async (kind, test) => {
    let routes = 0;
    let resolutions = 0;
    const setup = await withRouter(test, async () => { routes++; return { routes: [{ kind: "direct" }] }; });
    if (setup === undefined) return;
    try {
      setDestinationResolverForTesting(async name => { resolutions++; return testResolver(name); });
      const user = kind === "foreign-invocation" ? `srt.${Buffer.from("f".repeat(32)).toString("base64")}` : setup.name;
      const password = `${kind === "bad-password" ? "invalid-" : ""}${decodeURIComponent(setup.proxy.password)}`;
      const result = await socksThrough(setup.front, setup.proxy, user, "refused.example.invalid", 443, password);
      expect(result).toEqual(kind === "bad-password" ? { authentication: 1 } : { authentication: 0, reply: 2 });
      expect(routes).toBe(0);
      expect(resolutions).toBe(0);
      expect(setup.asked).toHaveLength(0);
    } finally {
      await setup.SandboxManager.reset();
    }
  });

  it("ends at any HTTP answer from an upstream: neither a later proxy nor DIRECT carries what it refused", async (test) => {
    const refusing = await recordingUpstream(403);
    const gateway = await recordingUpstream(502);
    const next = await recordingUpstream(200);
    try {
      let routes: Array<{ kind: "direct" } | { kind: "http"; host: string; port: number }> = [];
      const setup = await withRouter(test, async () => ({ routes }));
      if (setup === undefined) return;
      try {
        routes = [{ kind: "http", host: "127.0.0.1", port: refusing.port }, { kind: "http", host: "127.0.0.1", port: next.port }];
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "blocked.example.invalid:443"))
          .toBe("HTTP/1.1 403 upstream proxy refused the connection (HTTP 403)");
        routes = [{ kind: "http", host: "127.0.0.1", port: gateway.port }, { kind: "http", host: "127.0.0.1", port: next.port }];
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "unreachable.example.invalid:443"))
          .toBe("HTTP/1.1 502 Bad Gateway");
        // `PROXY p; DIRECT`: the proxy's refusal is not bypassed by going direct.
        routes = [{ kind: "http", host: "127.0.0.1", port: refusing.port }, { kind: "direct" }];
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "blocked2.example.invalid:443"))
          .toBe("HTTP/1.1 403 upstream proxy refused the connection (HTTP 403)");
        expect(next.requests).toEqual([]);
        expect(refusing.requests.map((r) => r.line)).toEqual([`CONNECT ${TEST_ADDRESS}:443 HTTP/1.1`, `CONNECT ${TEST_ADDRESS}:443 HTTP/1.1`]);
        expect(JSON.stringify(setup.SandboxManager.getSandboxViolationStore().getViolations()))
          .toContain("upstream proxy refused the connection (HTTP 403)");
      } finally {
        await setup.SandboxManager.reset();
      }
    } finally {
      await refusing.close();
      await gateway.close();
      await next.close();
    }
  });

  it("refuses with 'upstream proxy requires authentication' on a 407, sends Basic credentials, and does not fall back", async (test) => {
    const wantsAuth = await recordingUpstream(407);
    const next = await recordingUpstream(200);
    try {
      const setup = await withRouter(test, async () => ({
        routes: [
          { kind: "http", host: "127.0.0.1", port: wantsAuth.port, auth: { username: "user", password: "p@ss:word" } },
          { kind: "http", host: "127.0.0.1", port: next.port },
        ],
      }));
      if (setup === undefined) return;
      const { getSandboxViolationStore } = setup.SandboxManager;
      try {
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "auth.example.invalid:443"))
          .toBe("HTTP/1.1 403 upstream proxy requires authentication");
        expect(await plainHttpThrough(setup.front, setup.proxy, setup.name, `http://${TEST_ADDRESS}/`)).toMatch(/^HTTP\/1\.1 403/u);
        const basic = `Basic ${Buffer.from("user:p@ss:word").toString("base64")}`;
        expect(wantsAuth.requests).toEqual([
          { line: `CONNECT ${TEST_ADDRESS}:443 HTTP/1.1`, authorization: basic },
          { line: `GET http://${TEST_ADDRESS}/ HTTP/1.1`, authorization: basic },
        ]);
        expect(next.requests).toEqual([]);
        // The refusal is recorded with the reason, never the credential.
        const recorded = JSON.stringify(getSandboxViolationStore().getViolations());
        expect(recorded).toContain("upstream proxy requires authentication");
        expect(recorded).not.toContain("p@ss");
        expect(recorded).not.toContain(Buffer.from("user:p@ss:word").toString("base64"));
      } finally {
        await setup.SandboxManager.reset();
      }
    } finally {
      await wantsAuth.close();
      await next.close();
    }
  });

  it("judges each route for a name this host cannot resolve: an untrusted proxy on this host is skipped, a trusted one after it is used", async (test) => {
    const untrusted = await recordingUpstream(200);
    const trusted = await recordingUpstream(200);
    try {
      const setup = await withRouter(test, async () => ({
        routes: [
          { kind: "direct" },
          { kind: "http", host: "127.0.0.1", port: untrusted.port },
          { kind: "http", host: "127.0.0.1", port: trusted.port, resolvesNames: true },
        ],
      }));
      if (setup === undefined) return;
      try {
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "intranet.corp.test:443")).toMatch(/^HTTP\/1\.1 200/u);
        expect(untrusted.requests).toEqual([]);
        expect(trusted.requests.map((r) => r.line)).toEqual(["CONNECT intranet.corp.test:443 HTTP/1.1"]);
        expect(resolvedAsks(setup.asked).map((a) => [a.host, a.context?.phase === "resolved" ? a.context.resolution : undefined, a.context?.phase === "resolved" ? a.context.addresses : undefined])).toEqual([["intranet.corp.test", "upstream", []]]);
      } finally {
        await setup.SandboxManager.reset();
      }
      // Without the trusted route nothing can carry the name: refused with the reason, nobody asked.
      const refused = await withRouter(test, async () => ({ routes: [{ kind: "direct" }, { kind: "http", host: "127.0.0.1", port: untrusted.port }] }));
      if (refused === undefined) return;
      try {
        expect(await connectThrough(refused.front, refused.proxy, refused.name, "intranet.corp.test:443"))
          .toMatch(/^HTTP\/1\.1 403 .*upstream proxy on this host resolves names itself/u);
        expect(resolvedAsks(refused.asked)).toEqual([]);
        expect(untrusted.requests).toEqual([]);
      } finally {
        await refused.SandboxManager.reset();
      }
    } finally {
      await untrusted.close();
      await trusted.close();
    }
  });

  it("ends at a policy refusal: a proxy that reaches this host at the dial is refused, and no later route carries the name", async (test) => {
    const first = await recordingUpstream(200);
    const second = await recordingUpstream(200);
    try {
      const setup = await withRouter(test, async () => ({
        routes: [
          { kind: "http", host: "proxy.rebind.test", port: first.port },
          { kind: "http", host: "127.0.0.1", port: second.port, resolvesNames: true },
        ],
      }));
      if (setup === undefined) return;
      // The plan sees the proxy name remote; the dial's lookup gets loopback.
      let calls = 0;
      setDestinationResolverForTesting(async (name) => {
        if (name !== "proxy.rebind.test") return corpResolver(name);
        calls += 1;
        return [{ address: calls <= 1 ? "198.51.100.50" : "127.0.0.1", family: 4 }];
      });
      try {
        expect(await connectThrough(setup.front, setup.proxy, setup.name, "intranet.corp.test:443"))
          .toMatch(/^HTTP\/1\.1 403 .*upstream proxy on this host resolves names itself/u);
        expect(calls).toBe(2);
        expect(first.requests).toEqual([]);
        expect(second.requests).toEqual([]);
      } finally {
        await setup.SandboxManager.reset();
      }
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("forwards a plain-HTTP request by name through a remote or trusted upstream as unverified, never through an untrusted local one", async (test) => {
    const trusted = await recordingUpstream(200);
    try {
      const remote = await withUpstream(test, { http: "", https: "" }, false);
      if (remote === undefined) return;
      try {
        remote.SandboxManager.setParentProxyRouter(async () => ({ routes: [{ kind: "http", host: "192.0.2.1", port: 3128 }] }));
        expect(await plainHttpThrough(remote.front, remote.proxy, remote.name, "http://named.example.invalid/")).toMatch(/^HTTP\/1\.1 403/u);
        expect(resolvedAsks(remote.asked)).toEqual([{
          host: "named.example.invalid",
          context: { attributionKey: "6".repeat(16) + "0123456789abcdef", identity: "listener", phase: "resolved", addresses: [TEST_ADDRESS], resolution: "upstream" },
        }]);
      } finally {
        await remote.SandboxManager.reset();
      }
      const local = await withUpstream(test, { http: "", https: "" }, true);
      if (local === undefined) return;
      try {
        local.SandboxManager.setParentProxyRouter(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: trusted.port }] }));
        expect(await plainHttpThrough(local.front, local.proxy, local.name, "http://named.example.invalid/")).toMatch(/^HTTP\/1\.1 403/u);
        expect(JSON.stringify(local.SandboxManager.getSandboxViolationStore().getViolations()))
          .toContain("a plain-HTTP request by name is not forwarded to it");
        expect(trusted.requests).toEqual([]);
        local.SandboxManager.setParentProxyRouter(async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: trusted.port, resolvesNames: true }] }));
        expect(await plainHttpThrough(local.front, local.proxy, local.name, "http://named.example.invalid/")).toMatch(/^HTTP\/1\.1 200/u);
        // By name: the upstream resolves it, as the card was told.
        expect(trusted.requests.map((r) => r.line)).toEqual(["GET http://named.example.invalid/ HTTP/1.1"]);
        expect(resolvedAsks(local.asked).map((a) => (a.context?.phase === "resolved" ? a.context.resolution : undefined))).toEqual(["upstream"]);
      } finally {
        await local.SandboxManager.reset();
      }
    } finally {
      await trusted.close();
    }
  });

  it("closes every open tunnel on closeAllInvocationConnections (an upstream setting change)", async (test) => {
    const upstream = await recordingUpstream(200);
    try {
      const setup = await withRouter(test, async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: upstream.port }] }));
      if (setup === undefined) return;
      try {
        const { connect } = await import("node:net");
        const authorization = Buffer.from(`${setup.name}:${decodeURIComponent(setup.proxy.password)}`).toString("base64");
        const destination = "open.example.invalid:443";
        const socket = typeof setup.front === "number" ? connect(setup.front, "127.0.0.1") : connect(setup.front);
        socket.on("error", () => {});
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        const opened = new Promise<string>((resolve) => {
          let head = "";
          socket.on("data", (chunk: Buffer) => {
            head += chunk.toString("latin1");
            if (head.includes("\r\n\r\n")) resolve(head.split("\r\n")[0] ?? "");
          });
        });
        socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
        expect(await opened).toMatch(/^HTTP\/1\.1 200/u);
        expect(setup.SandboxManager.closeAllInvocationConnections()).toBe(1);
        await closed;
        expect(setup.SandboxManager.closeAllInvocationConnections()).toBe(0);
      } finally {
        await setup.SandboxManager.reset();
      }
    } finally {
      await upstream.close();
    }
  });

  it("drops a route that names one of the proxy's own listeners, and refuses a plain-HTTP name through a proxy route", async (test) => {
    let listenerPort = 0;
    const setup = await withRouter(test, async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: listenerPort }] }));
    if (setup === undefined) return;
    try {
      listenerPort = setup.SandboxManager.getProxyPort()!;
      expect(listenerPort).toBeTypeOf("number");
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "hop.example.invalid:443")).toBe("HTTP/1.1 403 sandbox proxy listener");
      expect(await plainHttpThrough(setup.front, setup.proxy, setup.name, "http://hop.example.invalid/")).toMatch(/^HTTP\/1\.1 403/u);
      expect(resolvedAsks(setup.asked)).toEqual([]);
    } finally {
      await setup.SandboxManager.reset();
    }
  });

  it("decides by name before any lookup: a destination refused by name costs no DNS query and no route lookup", async (test) => {
    const upstream = await recordingUpstream(200);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const asked: Array<{ host: string; context: SandboxAskContext | undefined }> = [];
    const resolved: string[] = [];
    const routed: string[] = [];
    try {
      try {
        await SandboxManager.initialize(
          { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
          async ({ host }, context) => {
            asked.push({ host, context });
            // What Ave's callback does for an unattributed connection, a worker off its list, asks turned off or no one to ask: refused by name.
            if (context?.phase === "name" && !host.startsWith("allowed.")) return { allow: false, reason: "refused by name" };
            return true;
          },
        );
      } catch (error) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw error;
        test.skip(`sandbox-runtime cannot initialize here: ${String(error)}`);
        return;
      }
      setDestinationResolverForTesting(async (name) => {
        resolved.push(name);
        return [{ address: TEST_ADDRESS, family: 4 }];
      });
      SandboxManager.setParentProxyRouter(async (destination) => {
        routed.push(destination.host);
        return { routes: [{ kind: "http", host: "127.0.0.1", port: upstream.port }] };
      });
      const commandId = "d".repeat(16) + "0123456789abcdef";
      const listener = await SandboxManager.openInvocationListener(commandId);
      const proxy = proxyUrlIn(await SandboxManager.wrapWithSandbox("true", undefined, undefined, undefined, { commandId }));
      const name = `srt.${Buffer.from(commandId).toString("base64")}`;
      const front = frontOf(listener);
      expect(await connectThrough(front, proxy, name, "deny-exfil.secretdata.example:443")).toBe("HTTP/1.1 403 refused by name");
      expect(await plainHttpThrough(front, proxy, name, "http://deny-exfil2.secretdata.example/")).toMatch(/^HTTP\/1\.1 403/u);
      expect(resolved).toEqual([]);
      expect(routed).toEqual([]);
      // An allowed name is resolved and routed once, after its name phase.
      expect(await connectThrough(front, proxy, name, "allowed.example.invalid:443")).toMatch(/^HTTP\/1\.1 200/u);
      expect(resolved).toEqual(["allowed.example.invalid"]);
      expect(routed).toEqual(["allowed.example.invalid"]);
      expect(upstream.requests.map((r) => r.line)).toEqual([`CONNECT ${TEST_ADDRESS}:443 HTTP/1.1`]);
      expect(asked.map((a) => [a.host, a.context?.phase])).toEqual([
        ["deny-exfil.secretdata.example", "name"],
        ["deny-exfil2.secretdata.example", "name"],
        ["allowed.example.invalid", "name"],
        ["allowed.example.invalid", "resolved"],
      ]);
    } finally {
      await SandboxManager.reset();
      await upstream.close();
    }
  });

  it.for(["ETIMEDOUT", "ESOCKETTIMEDOUT"])("classifies a %s route lookup as timeout without dialing", async (code, test) => {
    const setup = await withRouter(test, async () => { throw Object.assign(new Error("route lookup timed out"), { code }); });
    if (setup === undefined) return;
    try {
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "x.example.invalid:443")).toBe("HTTP/1.1 504 Gateway Timeout");
      const lines = setup.SandboxManager.getSandboxViolationStore().getViolations().map((row) => row.line);
      expect(lines).toContain("fail network-outbound x.example.invalid:443 (timeout: upstream proxy lookup timed out)");
      expect(resolvedAsks(setup.asked)).toEqual([]);
    } finally {
      await setup.SandboxManager.reset();
    }
  });

  it("refuses when the router throws, answers a malformed route or no route (with its reason); never asks it for loopback", async (test) => {
    let answer: () => Promise<Awaited<ReturnType<NonNullable<Router>>>> = async () => { throw new Error("pac failed"); };
    let calls = 0;
    const setup = await withRouter(test, async () => {
      calls += 1;
      return answer();
    });
    if (setup === undefined) return;
    try {
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "x.example.invalid:443")).toBe("HTTP/1.1 502 Bad Gateway");
      expect(JSON.stringify(setup.SandboxManager.getSandboxViolationStore().getViolations())).toContain("fail network-outbound x.example.invalid:443 (routing: upstream proxy lookup failed)");
      answer = async () => ({ routes: [{ kind: "socks5" } as never] });
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "x.example.invalid:443")).toBe("HTTP/1.1 403 upstream proxy lookup answered a malformed route");
      answer = async () => ({ routes: [], reason: "the system proxy offers only SOCKS" });
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "x.example.invalid:443")).toBe("HTTP/1.1 403 the system proxy offers only SOCKS");
      answer = async () => ({ routes: [] });
      expect(await connectThrough(setup.front, setup.proxy, setup.name, "x.example.invalid:443")).toBe("HTTP/1.1 403 no usable route to the destination");
      expect(calls).toBe(4);
      expect(resolvedAsks(setup.asked)).toEqual([]);
      // Loopback is always direct: the router is not asked (the ask callback is).
      const local = await recordingUpstream(200);
      try {
        expect(await plainHttpThrough(setup.front, setup.proxy, setup.name, `http://127.0.0.1:${local.port}/`)).toMatch(/^HTTP\/1\.1 200/u);
        expect(local.requests.map((r) => r.line)).toEqual(["GET / HTTP/1.1"]);
      } finally {
        await local.close();
      }
      expect(calls).toBe(4);
    } finally {
      await setup.SandboxManager.reset();
    }
  });

  it("exports setParentProxyRouter on SandboxManager, typed, and clears it on reset", () => {
    const manager = readInstalled("dist/sandbox/sandbox-manager.js");
    expect(manager).toMatch(/\n\s+closeInvocationConnections,\n\s+closeAllInvocationConnections,\n\s+setParentProxyRouter,\n/u);
    expect(functionBody(manager, /\nasync function reset\(/u)).toMatch(/parentProxyRouter = undefined;/u);
    const declarations = readInstalled("dist/sandbox/sandbox-manager.d.ts");
    expect(declarations).toMatch(/\n\s+setParentProxyRouter\(router: ParentProxyRouter \| undefined\): void;/u);
    expect(readInstalled("dist/index.d.ts")).toMatch(/ParentProxyRoute, ParentProxyRouter \} from '\.\/sandbox\/sandbox-manager\.js';/u);
    // The proxies dial through the pinned routes, not the static parentProxy.
    expect(readInstalled("dist/sandbox/http-proxy.js")).toMatch(/upstream = await options\.openRoute\(socket, hostname, port, auth\.encodedCommand\);/u);
    expect(readInstalled("dist/sandbox/socks-proxy.js")).toMatch(/options\.openRoute\(conn\.socket, host, port, encodedCommand\)/u);
  });
});

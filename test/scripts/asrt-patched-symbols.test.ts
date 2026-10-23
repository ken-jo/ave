/** Installed runtime contract checks for every carried patch boundary. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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

describe("installed sandbox runtime patch", () => {
  it("records exclusive mount creations and deletes only a quarantined matching identity", () => {
    const linux = readInstalled("dist/sandbox/linux-sandbox-utils.js");
    expect(linux).toContain("const bwrapMountPoints = new Map();");
    const create = functionBody(linux, /\nfunction createOwnedMountPoint\(/u);
    expect(create).toContain("fs.openSync(entry, 'wx', 0o444)");
    expect(create).toContain("fs.fstatSync(fd, { bigint: true })");
    expect(create).toContain("identity = publishOwnedDirectory(entry)");
    expect(create).toContain("identity = { dev: stat.dev, ino: stat.ino, kind, fd }");
    expect(create).toContain("bwrapMountPoints.set(dest, identity)");
    // Directories: identity from a descriptor on a private name, then moved
    // onto an exclusive reservation.
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
    // Decoded once; the per-command lists (0.0.80) are looked up by the same key.
    expect(byName).toMatch(
      /const attributionKey = encodedCommand\s+\? decodeSandboxedCommand\(encodedCommand\)\s+: undefined;/u,
    );
    expect(byName).toMatch(/commandNetworkListsByKey\.get\(attributionKey\)/u);
    expect(byName).toMatch(/askSandboxCallback\(sandboxAskCallback, host, port, \{ attributionKey, identity, phase: 'name' \}, denied\)/u);
    // Nothing in the name phase resolves or routes.
    expect(byName).not.toMatch(/planDestination|resolveAddresses|routesFor|destinationResolver/u);
    // Only an invocation listener's filter says 'listener'; the shared front
    // end's default is the forgeable username.
    expect(byName.startsWith("async function decideByName(port, host, sandboxAskCallback, encodedCommand, explain, identity = 'username')")).toBe(true);
    // Ave runs non-strict with an empty allowlist, so the callback is the gate:
    // without one the request is refused.
    expect(byName).toMatch(/if \(!sandboxAskCallback\) \{\n[^\n]*\n\s+return denied\('host is not on the allow list'\);/u);
    const resolved = functionBody(manager, /\nasync function confirmResolvedDestination\(/u);
    expect(resolved).toMatch(/phase: 'resolved',\s+addresses: plan\.addresses\.map\(a => a\.address\),\s+resolution: plan\.viaUpstream \? 'upstream' : 'pinned',/u);
    const ask = functionBody(manager, /\nasync function askSandboxCallback\(/u);
    // 0.0.80 allows only on a literal `true` (#591); the patch must not loosen it.
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
    // initialize() checks dependencies before those steps; that check must not
    // demand srt-win either, or the proxy never starts where it is needed.
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

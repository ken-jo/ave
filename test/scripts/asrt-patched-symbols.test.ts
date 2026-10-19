/**
 * The bun patch on @anthropic-ai/sandbox-runtime is dist JavaScript edited by
 * hand. A version bump that re-rolls it can apply cleanly and still drop a
 * piece, and nothing else notices: the terminal's own-tty grant degrades to a
 * plain deny, and the ask callback loses the attribution key that tells a
 * plugin worker's connection from a shell's. So each symbol the patch adds is
 * asserted on the INSTALLED package, the bytes Ave actually loads, on every OS
 * the suite runs on.
 */
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
  context?.attributionKey === "token";
type WrapOptions = NonNullable<Parameters<typeof SandboxManager.wrapWithSandbox>[4]>;
const ttysOption: WrapOptions["ttys"] = ["/dev/ttys001"];

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
    expect(filter).toMatch(/await sandboxAskCallback\(\{ host, port \}, \{ attributionKey \}\)/u);
    // 0.0.80 allows only on a literal `true` (#591); the patch must not loosen it.
    expect(filter).toMatch(/if \(answer === true\)/u);
    const schemas = readInstalled("dist/sandbox/sandbox-schemas.d.ts");
    expect(schemas).toMatch(/export type SandboxAskContext = \{\s+attributionKey: string \| undefined;\s+\};/u);
    expect(schemas).toMatch(
      /export type SandboxAskCallback = \(params: NetworkHostPattern, context\?: SandboxAskContext\) => Promise<boolean \| \{\s+allow: false;\s+reason: string;\s+\}>;/u,
    );
    expect(readInstalled("dist/index.d.ts")).toMatch(/export type \{ SandboxAskCallback, SandboxAskContext,/u);
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
    await expect(twoParameters(params, { attributionKey: "token" })).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: undefined })).resolves.toBe(false);
    expect(ttysOption).toEqual(["/dev/ttys001"]);
  });
});

/**
 * Behavioural half: through the real proxy, the key a wrap's proxy username
 * names reaches the ask callback's second argument. The proxy URL (with the
 * per-process credential) is read out of the wrapped command and used only
 * inside this process.
 */
describe.runIf(process.platform === "darwin" || process.platform === "linux")("ask callback attribution through the proxy", () => {
  /** CONNECT through the host-side proxy at `port`; `proxy` gives only the credential. */
  async function connectThrough(port: number, proxy: URL, username: string): Promise<string> {
    const { connect } = await import("node:net");
    const authorization = Buffer.from(`${username}:${decodeURIComponent(proxy.password)}`).toString("base64");
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "CONNECT unlisted.example.invalid:443 HTTP/1.1\r\nHost: unlisted.example.invalid:443\r\n"
            + `Proxy-Authorization: Basic ${authorization}\r\n\r\n`,
        );
      });
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
      expect(asked).toEqual([{ attributionKey: commandId }, { attributionKey: undefined }]);
    } finally {
      await SandboxManager.reset();
    }
  });
});

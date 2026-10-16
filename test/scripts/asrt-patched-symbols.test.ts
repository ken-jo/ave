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
    expect(filter).toMatch(
      /await sandboxAskCallback\(\{ host, port \}, \{\s+attributionKey: encodedCommand\s+\? decodeSandboxedCommand\(encodedCommand\)\s+: undefined,\s+\}\)/u,
    );
    const schemas = readInstalled("dist/sandbox/sandbox-schemas.d.ts");
    expect(schemas).toMatch(/export type SandboxAskContext = \{\s+attributionKey: string \| undefined;\s+\};/u);
    expect(schemas).toMatch(
      /export type SandboxAskCallback = \(params: NetworkHostPattern, context\?: SandboxAskContext\) => Promise<boolean>;/u,
    );
    expect(readInstalled("dist/index.d.ts")).toMatch(/export type \{ SandboxAskCallback, SandboxAskContext,/u);
  });

  it("types the callback so one-parameter callers still fit and two-parameter callers see the key", async () => {
    const params = { host: "example.com", port: 443 };
    await expect(oneParameter(params)).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: "token" })).resolves.toBe(true);
    await expect(twoParameters(params, { attributionKey: undefined })).resolves.toBe(false);
    expect(ttysOption).toEqual(["/dev/ttys001"]);
  });
});

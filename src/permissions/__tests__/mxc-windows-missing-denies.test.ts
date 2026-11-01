import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { getDefaultSensitiveWriteDenyPaths, getProtectedReadDenyFloor } from "../asrt-sandbox.js";
import { buildMandatorySandboxWritePolicy } from "../sandbox-write-policy.js";
import { buildMxcShellRequest, isWindowsPathAtOrUnder, mxcRequestArgs, powerShellMxcCommandLine, rankMxcFilesystem, resolveHostWxcExecPath } from "../mxc-windows.js";

afterEach(() => vi.restoreAllMocks());

describe("missing deny parents", () => {
  const root = String.raw`C:\Users\alice\work`;
  const policy = (denies: string[]) => ({ allowWrite: [root], allowRead: [], denyRead: denies, denyWrite: [], protectedFloor: [] });
  const exists = (path: string) => isWindowsPathAtOrUnder(root, path);

  it("raises nested denies and preserves a superset of their denied paths", () => {
    const original = [win32.join(root, "a", "b", ".ssh"), win32.join(root, "a", "other")];
    const grants = rankMxcFilesystem(policy(original), exists);
    expect(grants.denied).toEqual([win32.join(root, "a")]);
    for (const deny of original) for (const probe of [deny, win32.join(deny, "child"), win32.join(deny.toUpperCase(), "future", "secret")]) {
      expect(grants.denied.some((raised) => isWindowsPathAtOrUnder(probe, raised)), probe).toBe(true);
    }
  });

  it("keeps a missing leaf unchanged", () => {
    const deny = win32.join(root, ".vscode");
    expect(rankMxcFilesystem(policy([deny]), exists).denied).toEqual([deny]);
  });

  it("names a directory-form deny without its trailing separator", () => {
    const deny = win32.join(root, "routine");
    expect(rankMxcFilesystem(policy([`${deny}\\`]), () => true).denied).toEqual([deny]);
  });

  it("keeps a present deny unchanged", () => {
    const deny = win32.join(root, "a", "b", ".ssh");
    expect(rankMxcFilesystem(policy([deny]), () => true).denied).toEqual([deny]);
  });

  it("fails closed if a grant disappears and raising would deny its root", () => {
    let rootChecks = 0;
    const deny = win32.join(root, "a", "b");
    const racedExists = (path: string) => path === root ? ++rootChecks === 1 : isWindowsPathAtOrUnder(win32.dirname(root), path);
    expect(() => rankMxcFilesystem(policy([deny]), racedExists)).toThrow(/^Windows sandbox policy cannot raise/);
  });

  it("fails closed when the raised component is outside every writable grant", () => {
    const readonly = String.raw`C:\Users\bob`;
    expect(() => rankMxcFilesystem({ ...policy([win32.join(readonly, "a", "b")]), allowRead: [readonly] },
      (path) => exists(path) || isWindowsPathAtOrUnder(readonly, path))).toThrow(/^Windows sandbox policy cannot raise/);
  });
});

describe.skipIf(process.platform !== "win32")("native missing deny parents", () => {
  it("starts with no denies, a missing leaf, nested denies and mandatory workspace denies", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    await requireMxcCapability(context.skip);
    const launcher = await resolveHostWxcExecPath();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "example-mxc-missing-")));
    const home = join(directory, "alice");
    mkdirSync(home);
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([home]);
    const sensitive = getDefaultSensitiveWriteDenyPaths();
    const mandatory = buildMandatorySandboxWritePolicy([directory], undefined, sensitive);
    const workspaceDenies = [...sensitive, ...mandatory.denyWrite.map((entry) => typeof entry === "string" ? entry : entry.path)];
    const floor = getProtectedReadDenyFloor();
    try {
      expect(existsSync(join(directory, ".claude"))).toBe(false);
      expect(existsSync(join(directory, ".idea"))).toBe(false);
      writeFileSync(join(directory, "routine"), "");
      for (const [label, denies] of [["none", []], ["leaf", [join(directory, ".vscode")]], ["file in directory form", [`${join(directory, "routine")}\\`]],
        ["nested", [join(directory, "a", "b", ".ssh")]], ["workspace", workspaceDenies]] as const) {
        // A floor row in directory form over a placeholder file, as `~/.ave/routine` can be.
        const floorRow = label === "file in directory form";
        const grants = rankMxcFilesystem({ allowWrite: [directory], allowRead: [], denyRead: floorRow ? denies : [],
          denyWrite: floorRow ? [] : denies, protectedFloor: label === "workspace" ? floor : [] }, existsSync);
        const request = buildMxcShellRequest({ commandLine: powerShellMxcCommandLine(process.env.SystemRoot!, "exit 0"), cwd: directory, grants,
          env: { SYSTEMROOT: process.env.SystemRoot!, LOCALAPPDATA: directory }, proxyUrl: "http://127.0.0.1:9", timeoutMs: TOOL_TIMEOUT_POLICY.shellDefaultMs });
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
          execFile(launcher, mxcRequestArgs(request, launcher), { cwd: win32.dirname(launcher), windowsHide: true,
            timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs }, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") { reject(error); return; }
            resolveResult({ code: error?.code as number | undefined ?? 0, stdout, stderr });
          });
        });
        expect(result.code, `${label}: ${JSON.stringify(result)}`).toBe(0);
        const relative = (paths: readonly string[]) => paths.filter((path) => isWindowsPathAtOrUnder(path, directory))
          .map((path) => win32.relative(directory, path));
        console.info(`MXC deny evidence ${JSON.stringify({ label, before: relative([...denies, ...(label === "workspace" ? floor : [])]), after: relative(grants.denied) })}`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, TOOL_TIMEOUT_POLICY.shellDefaultMs * 5 + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
});

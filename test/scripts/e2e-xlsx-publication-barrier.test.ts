import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageWindowsPathKindHelper } from "../../src/__tests__/support/bundled-skill-resources.js";
import { configureHostResources } from "../../src/main/host-resources.js";
import { hostScriptInvocationReadPaths, hostScriptRuntimePaths, hostScriptWriteDenyPaths, isVerifiedHostScript } from "../../src/main/host-script-runtime.js";
import { resolveRuntimePathsFromModuleUrl } from "../../src/main/main-paths.js";
import { windowsPathKindHelperIn } from "../../src/main/windows-path-kind-launcher.js";
import { rankMxcFilesystem } from "../../src/permissions/mxc-windows.js";
import { PermissionManager } from "../../src/permissions/permission-manager.js";
import { shellQuote } from "../../src/lib/shell-resolver.js";
import { shellPolicyModel } from "../../src/tools/mxc-shell-launch.js";
import { normalizePowerShellAstSummary, POWER_SHELL_AST_PARSER } from "../../src/tools/powershell-ast.js";
import { preparePowerShellLaunch } from "../../src/tools/powershell-launch.js";
import { buildSafeChildEnv } from "../../src/tools/safe-env.js";
import { findShellPathPolicyViolation } from "../../src/tools/shell-path-policy.js";
import { awaitedHostScriptCommand, findPowerShellAstPathViolation, powerShellHostScriptReadPaths, resolvePowerShellExecutable } from "../../src/tools/shell-tools.js";
import { fileSystemIo, type FixtureBuildIo, prepareWorkbookPublicationBuild, renderWorkbookCommand } from "../e2e/ui/xlsx-publication-barrier.js";

let root: string;
let checkout: string;
let sharedScript: string;
let sharedManifest: string;
let producerBytes: Buffer;
let manifestBytes: Buffer;

beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "workbook-publication-")));
  checkout = join(root, "checkout");
  const scripts = join(checkout, "dist", "skill-scripts");
  mkdirSync(join(checkout, "dist", "src", "main"), { recursive: true });
  writeFileSync(join(checkout, "dist", "src", "main", "main.js"), "export {};\n");
  writeFileSync(join(checkout, "dist", "src", "preload.cjs"), "\"use strict\";\n");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(checkout, "resources"));
  stageWindowsPathKindHelper(join(checkout, "resources"));
  sharedScript = join(scripts, "edit-xlsx.cjs");
  await build({ entryPoints: [resolve("src/skills/xlsx-edit-cli.ts")], outfile: sharedScript,
    bundle: true, platform: "node", format: "cjs", target: "node22", minify: true, logLevel: "silent" });
  producerBytes = readFileSync(sharedScript);
  sharedManifest = join(scripts, "manifest.json");
  manifestBytes = Buffer.from(`${JSON.stringify({ version: 1,
    scripts: { "edit-xlsx.cjs": createHash("sha256").update(producerBytes).digest("hex") } })}\n`);
  writeFileSync(sharedManifest, manifestBytes);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function expectSharedBuildUsable(): void {
  expect(readFileSync(sharedScript)).toEqual(producerBytes);
  expect(readFileSync(sharedManifest)).toEqual(manifestBytes);
  configureHostResources({ resourcePath: join(checkout, "resources"), isPackaged: false });
  expect(isVerifiedHostScript(sharedScript)).toBe(true);
}

function leftoverBuilds(): string[] {
  const outputs = join(checkout, "test-results");
  return existsSync(outputs) ? readdirSync(outputs) : [];
}

function faultyIo(fault: (operation: keyof FixtureBuildIo, path: string) => boolean): FixtureBuildIo {
  return {
    copy: (source, target) => { if (fault("copy", target)) throw new Error(`copy fault ${target}`); fileSystemIo.copy(source, target); },
    write: (path, bytes) => { if (fault("write", path)) throw new Error(`write fault ${path}`); fileSystemIo.write(path, bytes); },
    remove: (path) => { if (fault("remove", path)) throw new Error(`remove fault ${path}`); fileSystemIo.remove(path); },
  };
}

describe("workbook publication build", () => {
  it("holds the real producer after journal cells and preserves strict script admission and publication", async () => {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(join(home, "document-observation"), { recursive: true });
    const workbookPath = join(workspace, "values.xlsx");
    const requestPath = join(workspace, "edits.json");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Existing", 12]]), "Values");
    const original = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    writeFileSync(workbookPath, original);
    writeFileSync(requestPath, JSON.stringify({ sheet: 0, edits: [{ cell: "A1", value: "Changed" }, { cell: "B1", value: 84 }] }));
    const fixture = prepareWorkbookPublicationBuild(checkout, workspace);
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      expect(readFileSync(fixture.scriptPath).subarray(-producerBytes.length)).toEqual(producerBytes);
      const { projectRoot } = resolveRuntimePathsFromModuleUrl(pathToFileURL(fixture.mainEntry).href);
      expect(projectRoot).toBe(fixture.root);
      configureHostResources({ resourcePath: join(projectRoot, "resources"), isPackaged: false });
      expect(hostScriptRuntimePaths()?.bundledScriptsDirectory).toBe(dirname(fixture.scriptPath));
      const argv = fixture.argv(process.execPath, workbookPath, requestPath);
      const allowRead = hostScriptInvocationReadPaths(argv, { ELECTRON_RUN_AS_NODE: "1" });
      expect(allowRead).toContain(fixture.scriptPath);
      if (process.platform === "win32") {
        const helper = windowsPathKindHelperIn(join(fixture.root, "resources"));
        const denyWrite = hostScriptWriteDenyPaths();
        const grants = rankMxcFilesystem(shellPolicyModel({
          allowRead, allowWrite: [workspace], denyWrite, denyRead: [], protectedFloor: [],
        }), existsSync);
        expect(grants.readonly).toContain(helper);
        expect(denyWrite).toContain(helper);
        expect(grants.readwrite).not.toContain(helper);
        expect([...grants.readonly, ...grants.readwrite].filter(grant => win32.parse(grant).root === grant)).toEqual([]);
      }
      const command = `ELECTRON_RUN_AS_NODE=1 ${argv.map(shellQuote).join(" ")}`;
      expect(findShellPathPolicyViolation(command, workspace, workspace, [], true)).toBeNull();
      const permissions = new PermissionManager(join(root, "permissions.json"));
      permissions.setMode("strict");
      permissions.setRules([]);
      expect(permissions.checkDetailed("bash", "builtin", "shell", null, {
        ruleSubject: { kind: "shell", dialect: "bash", command, cwd: workspace },
        shellExecution: { runsSandboxed: true }, sessionId: "workbook-publication-session",
      })).toMatchObject({ decision: "ask" });
      const journalPath = join(home, "document-observation", "journal.jsonl");
      child = spawn(process.execPath, argv.slice(1), { env: { ...process.env,
        HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: "1", AVE_DOCUMENT_JOURNAL: journalPath }, stdio: "pipe" });
      closed = once(child, "close");
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", bytes => { stdout += bytes; });
      child.stderr?.on("data", bytes => { stderr += bytes; });
      await expect.poll(() => existsSync(fixture.readyPath)).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(readFileSync(workbookPath)).toEqual(original);
      const records = () => readFileSync(journalPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string });
      expect(records().map(record => record.kind)).toEqual(["begin", "cell", "cell"]);
      expectSharedBuildUsable();
      fixture.release();
      fixture.release();
      await closed;
      expect(child.exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ editedCells: 2, needsRecalculation: true, backup: null });
      expect(records().map(record => record.kind)).toEqual(["begin", "cell", "cell", "commit"]);
      expect(XLSX.read(readFileSync(workbookPath), { type: "buffer" }).Sheets.Values?.B1?.v).toBe(84);
      fixture.dispose();
      fixture.dispose();
      expect(existsSync(fixture.root)).toBe(false);
      expectSharedBuildUsable();
    } finally {
      fixture.release();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      if (closed) await closed;
      fixture.dispose();
    }
  });

  it.each([
    ["the build copy", "copy", join("dist", "src")],
    ["the resource copy", "copy", "resources"],
    ["the prelude install", "write", "edit-xlsx.cjs"],
    ["the manifest install", "write", "manifest.json"],
  ] as const)("leaves the shared build usable when %s fails", (_name, operation, suffix) => {
    const workspace = mkdtempSync(join(root, "install-fault-"));
    expect(() => prepareWorkbookPublicationBuild(checkout, workspace,
      faultyIo((kind, path) => kind === operation && path.endsWith(suffix)))).toThrow(`${operation} fault`);
    expect(leftoverBuilds()).toEqual([]);
    expectSharedBuildUsable();
  });

  it("leaves the shared build usable when launch, teardown or a worker fails", () => {
    const workspace = mkdtempSync(join(root, "lifecycle-fault-"));
    let launchedRoot = "";
    expect(() => {
      const launched = prepareWorkbookPublicationBuild(checkout, workspace);
      launchedRoot = launched.root;
      try { throw new Error("launch fault"); } finally { launched.dispose(); }
    }).toThrow("launch fault");
    expect(existsSync(launchedRoot)).toBe(false);
    expectSharedBuildUsable();

    const torn = prepareWorkbookPublicationBuild(checkout, workspace, faultyIo((kind) => kind === "remove"));
    expect(() => torn.dispose()).toThrow("remove fault");
    expectSharedBuildUsable();
    fileSystemIo.remove(torn.root);

    const abandoned = prepareWorkbookPublicationBuild(checkout, workspace);
    expectSharedBuildUsable();
    fileSystemIo.remove(abandoned.root);
    expect(leftoverBuilds()).toEqual([]);
  });

  it.runIf(process.platform === "win32")("keeps the exact helper grant through the parsed PowerShell command the E2E sends", () => {
    const workspace = mkdtempSync(join(root, "alice's workspace "));
    const fixture = prepareWorkbookPublicationBuild(checkout, workspace);
    try {
      configureHostResources({ resourcePath: join(fixture.root, "resources"), isPackaged: false });
      const source = renderWorkbookCommand("win32", fixture.argv(process.execPath, join(workspace, "alice's book.xlsx"), join(workspace, "edits.json")));
      const launch = preparePowerShellLaunch(POWER_SHELL_AST_PARSER, buildSafeChildEnv(), undefined, { hostShell: true });
      let reply: ReturnType<typeof spawnSync>;
      try {
        reply = spawnSync(resolvePowerShellExecutable(), launch.args, { input: source, env: launch.env, encoding: "utf8", windowsHide: true });
      } finally {
        launch.cleanup();
      }
      expect(reply.status, String(reply.stderr)).toBe(0);
      const ast = normalizePowerShellAstSummary(JSON.parse(String(reply.stdout)));
      const reads = powerShellHostScriptReadPaths(ast, source);
      expect(reads).toContain(fixture.scriptPath);
      expect(reads).toContain(windowsPathKindHelperIn(join(fixture.root, "resources")));
      const [invocation] = ast.commands;
      if (!invocation) throw new Error("The rendered command did not parse");
      expect(awaitedHostScriptCommand(source, invocation)).not.toBeNull();
      expect(findPowerShellAstPathViolation(ast, workspace, workspace, [], true, source)).toBeNull();
    } finally {
      fixture.dispose();
    }
  });
});

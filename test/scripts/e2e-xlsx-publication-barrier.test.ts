import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { boundedDiagnostic, fileSystemIo, type FixtureBuildIo, type OwnedApp, prepareWorkbookPublicationBuild, renderWorkbookCommand } from "../e2e/ui/xlsx-publication-barrier.js";

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
  mkdirSync(join(checkout, "build"));
  writeFileSync(join(checkout, "build", "icon.png"), "icon");
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
  const outputs = join(checkout, ".cache");
  return existsSync(outputs) ? readdirSync(outputs) : [];
}

function faultyIo(fault: (operation: keyof FixtureBuildIo, path: string) => boolean): FixtureBuildIo {
  return {
    canonical: (path) => { if (fault("canonical", path)) throw new Error(`canonical fault ${path}`); return fileSystemIo.canonical(path); },
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
      expect(readFileSync(join(projectRoot, "build", "icon.png"), "utf8")).toBe("icon");
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
    ["the root canonicalization", "canonical", ""],
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

  it.each(["../escape.cjs", "nested/inner.cjs", "Upper.cjs", "plain.js", "plainxcjs"])("refuses manifest key %s before any copy or write", (key) => {
    const malformed = join(root, `malformed-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`);
    mkdirSync(join(malformed, "dist", "skill-scripts"), { recursive: true });
    writeFileSync(join(malformed, "dist", "skill-scripts", "edit-xlsx.cjs"), producerBytes);
    writeFileSync(join(malformed, "dist", "skill-scripts", "manifest.json"), JSON.stringify({ version: 1,
      scripts: { "edit-xlsx.cjs": createHash("sha256").update(producerBytes).digest("hex"), [key]: "0".repeat(64) } }));
    const calls: string[] = [];
    const record = faultyIo((operation, path) => { calls.push(`${operation} ${path}`); return false; });
    expect(() => prepareWorkbookPublicationBuild(malformed, join(root, "workspace"), record)).toThrow("outside its directory");
    expect(calls).toEqual([]);
    expect(existsSync(join(malformed, ".cache"))).toBe(false);
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

  describe("owned app lifecycle", () => {
    const quick = { shutdownMs: 200, closeMs: 200, launchMs: 200 };
    const prepared = (io?: FixtureBuildIo) => prepareWorkbookPublicationBuild(checkout, mkdtempSync(join(root, "owned-")), io);
    const seededDirectories = () => [mkdtempSync(join(root, "profile-")), mkdtempSync(join(root, "home-"))];

    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly pid = 4242;
      readonly kills: unknown[][] = [];
      onKill = () => {};
      kill(...args: unknown[]): boolean { this.kills.push(args); this.onKill(); return true; }
      exit(): void { this.exitCode = 0; this.emit("exit", 0, null); }
      closePipes(): void { this.emit("close", 0, null); }
    }
    function fakeApp(onClose: (child: FakeChild) => Promise<void> = async (child) => { child.exit(); child.closePipes(); }) {
      const child = new FakeChild();
      const calls = { close: 0 };
      const app: OwnedApp = { close: () => { calls.close++; return onClose(child); }, process: () => child as unknown as ChildProcess };
      return { app, child, calls };
    }
    const never = () => new Promise<void>(() => {});

    it("acts only through the owned handles, so no numeric PID reaches a terminator", async () => {
      const source = readFileSync(new URL("../e2e/ui/xlsx-publication-barrier.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/taskkill|process\.kill|execFile|spawn/);
      const signals = vi.spyOn(process, "kill");
      try {
        const fixture = prepared();
        const seeds = seededDirectories();
        fixture.seeded(...seeds);
        const { app, child, calls } = fakeApp(never);
        child.onKill = () => { child.exit(); child.closePipes(); };
        fixture.own(app);
        const settled = await fixture.settle(quick);
        expect(calls.close).toBe(1);
        expect(child.kills).toEqual([[]]);
        expect(signals).not.toHaveBeenCalled();
        expect(settled.closed).toBe(true);
        expect(settled.failures.map(String)).toEqual([expect.stringContaining("Workbook app close exceeded 200 ms")]);
        for (const path of [fixture.root, ...seeds]) expect(existsSync(path)).toBe(false);
      } finally {
        signals.mockRestore();
      }
    });

    it("ends a real process through its child handle and removes the copy after close", async () => {
      const fixture = prepared();
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "pipe", windowsHide: true });
      fixture.own({ close: never, process: () => child });
      const settled = await fixture.settle({ ...quick, closeMs: 10_000 });
      expect(settled.closed).toBe(true);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(existsSync(fixture.root)).toBe(false);
      expectSharedBuildUsable();
    });

    it("removes the copy, profile and home after a graceful close", async () => {
      const fixture = prepared();
      const seeds = seededDirectories();
      fixture.seeded(...seeds);
      const { app, child } = fakeApp();
      fixture.own(app);
      expect(await fixture.settle(quick)).toEqual({ closed: true, failures: [] });
      expect(child.kills).toEqual([]);
      for (const path of [fixture.root, ...seeds]) expect(existsSync(path)).toBe(false);
    });

    it("keeps and reports every path when the parent exits but its pipes stay open", async () => {
      const fixture = prepared();
      const seeds = seededDirectories();
      fixture.seeded(...seeds);
      const { app, child } = fakeApp(async (exited) => { exited.exit(); });
      fixture.own(app);
      const settled = await fixture.settle(quick);
      expect(child.kills).toEqual([]);
      expect(settled.closed).toBe(false);
      expect(String(settled.failures.at(-1))).toContain(
        `paths retained because the owned app did not close: ${[fixture.root, ...seeds].join(", ")}`);
      for (const path of [fixture.root, ...seeds]) expect(existsSync(path)).toBe(true);
      for (const path of [fixture.root, ...seeds]) fileSystemIo.remove(path);
    });

    it("completes within its deadlines when a diagnostic and the close both stall", async () => {
      const started = Date.now();
      expect(await boundedDiagnostic(() => new Promise<string>(() => {}), "fallback", 50)).toBe("fallback");
      expect(await boundedDiagnostic(() => Promise.reject(new Error("renderer gone")), "fallback", 50)).toBe("fallback");
      const fixture = prepared();
      const seeds = seededDirectories();
      fixture.seeded(...seeds);
      const { app, child } = fakeApp(never);
      fixture.own(app);
      const settled = await fixture.settle(quick);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(child.kills).toEqual([[]]);
      expect(settled.closed).toBe(false);
      expect(settled.failures.map(String)).toEqual([
        expect.stringContaining("Workbook app close exceeded 200 ms"),
        expect.stringContaining("Workbook app pipe closure exceeded 200 ms"),
        expect.stringContaining(`the owned app did not close: ${[fixture.root, ...seeds].join(", ")}`),
      ]);
      for (const path of [fixture.root, ...seeds]) expect(existsSync(path)).toBe(true);
      for (const path of [fixture.root, ...seeds]) fileSystemIo.remove(path);
    });

    it("removes the copy, profile and home after a startup failure whose app closed", async () => {
      const fixture = prepared();
      const seeds = seededDirectories();
      const { app } = fakeApp();
      await expect(fixture.launch(async () => {
        fixture.seeded(...seeds);
        fixture.own(app);
        await app.close();
        throw new Error("first window failed");
      })).rejects.toThrow("first window failed");
      expect(await fixture.settle(quick)).toEqual({ closed: true, failures: [] });
      for (const path of [fixture.root, ...seeds]) expect(existsSync(path)).toBe(false);
    });

    it("keeps and reports every path when a launch supplied no owned app", async () => {
      const fixture = prepared();
      const seeds = seededDirectories();
      await expect(fixture.launch(async () => { fixture.seeded(...seeds); throw new Error("launch refused"); })).rejects.toThrow("launch refused");
      const settled = await fixture.settle(quick);
      expect(settled.closed).toBe(false);
      expect(String(settled.failures.at(-1))).toContain(`the launch supplied no owned app: ${[fixture.root, ...seeds].join(", ")}`);
      for (const path of [fixture.root, ...seeds]) fileSystemIo.remove(path);
    });

    it("keeps every path after a startup timeout, then closes and reports the late arrival", async () => {
      const fixture = prepared();
      const seeds = seededDirectories();
      let arrive = () => {};
      const arrived = new Promise<void>((resolve) => { arrive = resolve; });
      const { app, child, calls } = fakeApp();
      const launching = fixture.launch(async () => { fixture.seeded(...seeds); await arrived; fixture.own(app); }, 50);
      await expect(launching).rejects.toThrow("Workbook app startup exceeded 50 ms");
      const settled = await fixture.settle(quick);
      expect(settled.closed).toBe(false);
      expect(settled.failures.map(String)).toEqual([expect.stringContaining("Workbook app launch settlement exceeded 200 ms"),
        expect.stringContaining(`the launch is still in progress: ${[fixture.root, ...seeds].join(", ")}`)]);
      for (const path of [fixture.root, ...seeds]) expect(existsSync(path)).toBe(true);
      arrive();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const late = await fixture.late();
      expect(late.map(String)).toEqual([expect.stringContaining("arrived after its fixture was settled")]);
      expect(calls.close).toBe(1);
      expect(child.exitCode).toBe(0);
      for (const path of [fixture.root, ...seeds]) fileSystemIo.remove(path);
    });

    it.each([
      ["succeeded", undefined],
      ["failed", (kind: keyof FixtureBuildIo) => kind === "remove"],
    ] as const)("closes and reports an arrival after removal %s", async (_name, fault) => {
      const fixture = prepared(fault ? faultyIo(fault) : undefined);
      const settled = await fixture.settle(quick);
      expect(settled.closed).toBe(true);
      expect(settled.failures.map(String)).toEqual(fault ? [`Error: Workbook fixture path left at ${fixture.root}`] : []);
      const { app, child, calls } = fakeApp();
      expect(() => fixture.own(app)).toThrow("arrived after its fixture was settled");
      expect((await fixture.late()).map(String)).toEqual([expect.stringContaining("arrived after its fixture was settled")]);
      expect(calls.close).toBe(1);
      expect(child.exitCode).toBe(0);
      expect(existsSync(fixture.root)).toBe(fault !== undefined);
      expectSharedBuildUsable();
      fileSystemIo.remove(fixture.root);
    });
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

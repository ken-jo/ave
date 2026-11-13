import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build } from "esbuild";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { configureHostResources } from "../../src/main/host-resources.js";
import { hostScriptInvocationReadPaths } from "../../src/main/host-script-runtime.js";
import { PermissionManager } from "../../src/permissions/permission-manager.js";
import { shellQuote } from "../../src/lib/shell-resolver.js";
import { findShellPathPolicyViolation } from "../../src/tools/shell-path-policy.js";
import { prepareWorkbookPublicationBarrier } from "../e2e/ui/xlsx-publication-barrier.js";

describe("workbook publication barrier", () => {
  it("holds the real producer after journal cells and preserves strict script admission and publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "workbook-publication-"));
    const resources = join(root, "resources");
    const scripts = join(resources, "skill-scripts");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(workspace);
    mkdirSync(join(home, "document-observation"), { recursive: true });
    const producer = join(scripts, "edit-xlsx.cjs");
    await build({ entryPoints: [resolve("src/skills/xlsx-edit-cli.ts")], outfile: producer,
      bundle: true, platform: "node", format: "cjs", target: "node22", minify: true, logLevel: "silent" });
    const producerBytes = readFileSync(producer);
    const manifestPath = join(scripts, "manifest.json");
    const originalManifest = Buffer.from(`${JSON.stringify({ version: 1,
      scripts: { "edit-xlsx.cjs": createHash("sha256").update(producerBytes).digest("hex") } })}\n`);
    writeFileSync(manifestPath, originalManifest);
    const workbookPath = join(workspace, "values.xlsx");
    const requestPath = join(workspace, "edits.json");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Existing", 12]]), "Values");
    const original = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    writeFileSync(workbookPath, original);
    writeFileSync(requestPath, JSON.stringify({ sheet: 0, edits: [{ cell: "A1", value: "Changed" }, { cell: "B1", value: 84 }] }));
    const barrier = prepareWorkbookPublicationBarrier(scripts, workspace);
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      expect(readFileSync(barrier.scriptPath).subarray(-producerBytes.length)).toEqual(producerBytes);
      configureHostResources({ resourcePath: resources, isPackaged: true });
      const argv = [process.execPath, barrier.scriptPath, workbookPath, requestPath, barrier.readyPath, barrier.releasePath];
      expect(hostScriptInvocationReadPaths(argv, { ELECTRON_RUN_AS_NODE: "1" })).toContain(barrier.scriptPath);
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
      await expect.poll(() => existsSync(barrier.readyPath)).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(readFileSync(workbookPath)).toEqual(original);
      const records = () => readFileSync(journalPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string });
      expect(records().map(record => record.kind)).toEqual(["begin", "cell", "cell"]);
      barrier.release();
      barrier.release();
      await closed;
      expect(child.exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ editedCells: 2, needsRecalculation: true, backup: null });
      expect(records().map(record => record.kind)).toEqual(["begin", "cell", "cell", "commit"]);
      expect(XLSX.read(readFileSync(workbookPath), { type: "buffer" }).Sheets.Values?.B1?.v).toBe(84);
      expect(readFileSync(producer)).toEqual(producerBytes);
      barrier.restore();
      barrier.restore();
      expect(readFileSync(manifestPath)).toEqual(originalManifest);
      expect(existsSync(barrier.scriptPath)).toBe(false);
      expect(basename(barrier.scriptPath)).toMatch(/^xlsx-publication-[a-f0-9]+\.cjs$/);
    } finally {
      barrier.release();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      if (closed) await closed;
      barrier.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

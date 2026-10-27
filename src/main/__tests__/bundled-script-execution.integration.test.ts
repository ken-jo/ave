import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { cleanupAsrtSandboxAfterCommand, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox, resetAsrtSandbox, wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import { liveEgressInvocationCount, openEgressInvocation } from "../../permissions/egress-invocations.js";
import { createSandboxProcessHome, sandboxProcessHomesInUse } from "../../permissions/sandbox-process-home.js";
import { createSandboxActionDirectory } from "../../permissions/sandbox-action-directory.js";
import { sandboxPrivateBase } from "../../shared/sandbox-private-paths.js";
import { resolveShell, shellQuote } from "../../lib/shell-resolver.js";
import { buildSafeChildEnv, buildSandboxedChildEnv } from "../../tools/safe-env.js";
import { prepareMxcShellLaunch, type MxcShellLaunch } from "../../tools/mxc-shell-launch.js";
import { win32SystemBinary } from "../../shared/windows-system-path.js";
import {
  __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  setActiveSandboxCapability, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate,
} from "../../permissions/sandbox-capability.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { parseTableDocument } from "../../tools/table-document-reader.js";
import { configureHostResources } from "../host-resources.js";
import { hostScriptRuntimePaths } from "../host-script-runtime.js";
import { runWorkbookScript } from "../bundled-script-execution.js";

describe("native bundled document execution", () => {
  it("edits and inspects the shipped workbook bundle and confines action writes", async context => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-native-workbook-")));
    const staging = createSandboxActionDirectory();
    const directory = staging.path;
    const workbookPath = join(directory, "workbook.xlsx");
    const requestPath = join(directory, "request.json");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Budget", 12]]), "Sheet");
    writeFileSync(workbookPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
    try {
      if (process.platform === "win32") {
        const started = await requireMxcCapability(context.skip);
        await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } });
        const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: false,
          mxc: { state: "available" }, windowsBuild: started.windowsBuild, srtWinReady: false });
        setWindowsSandboxSubstrate(substrate, mxcShellCapability());
        setActiveSandboxCapability(windowsProxyOnlyCapability(substrate));
      } else {
        await initializeAsrtSandbox({ allowedDomains: [] });
        setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
          reason: "Native startup workload succeeded", confines: { filesystem: true, process: true, network: true } });
      }
      setShellSandboxRequestedAtBoot(true);
      configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
      writeFileSync(requestPath, JSON.stringify({ sheet: 0, cell: "B1" }));
      expect(JSON.parse((await runWorkbookScript(directory, "inspect")).stdout)).toEqual({ value: 12, formula: false });
      writeFileSync(requestPath, JSON.stringify({ sheet: 0, edits: [{ cell: "B1", value: 84 }] }));
      await runWorkbookScript(directory, "edit");
      const parsed = await parseTableDocument(readFileSync(workbookPath), "xlsx", 0);
      expect(parsed.sheet.rows).toEqual([["Budget", "84"]]);
      expect(parsed.needsRecalculation).toBe(true);
      writeFileSync(requestPath, JSON.stringify({ sheet: 0, cell: "B1" }));
      expect(JSON.parse((await runWorkbookScript(directory, "inspect")).stdout)).toEqual({ value: 84, formula: false });

      const originalWorkbook = readFileSync(workbookPath);
      const windows = process.platform === "win32";
      const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;
      const attack = windows
        ? `try { [IO.File]::WriteAllText(${quotePowerShell(workbookPath)},'tampered'); 'write-allowed' } catch { 'write-denied' }; try { [IO.File]::ReadAllText(${quotePowerShell(workbookPath)}) | Out-Null; 'read-allowed' } catch { 'read-denied' }`
        : `if printf tampered > ${shellQuote(workbookPath)}; then printf 'write-allowed\\n'; else printf 'write-denied\\n'; fi; if cat ${shellQuote(workbookPath)} >/dev/null; then printf 'read-allowed\\n'; else printf 'read-denied\\n'; fi`;
      const attackerHome = createSandboxProcessHome();
      const attacker = openEgressInvocation({ kind: "shell", toolName: windows ? "powershell" : "bash", toolUseId: undefined,
        context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "unavailable" } });
      let attackerMxc: MxcShellLaunch | undefined;
      let attackerWrapped: Awaited<ReturnType<typeof wrapToolCommand>> | undefined;
      let refusalOutput: string;
      try {
        const filesystem = {
          allowWrite: [realpathSync.native(sandboxPrivateBase()), realpathSync.native(tmpdir()), attackerHome.path],
          allowRead: [realpathSync.native(sandboxPrivateBase()), realpathSync.native(tmpdir()), attackerHome.path],
          denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyPaths(),
        };
        let argv: readonly string[];
        let env: Record<string, string>;
        if (windows) {
          const executable = win32SystemBinary("WindowsPowerShell/v1.0/powershell.exe");
          attackerMxc = await prepareMxcShellLaunch({ egressToken: attacker.token,
            commandLine: `"${executable}" -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(attack, "utf16le").toString("base64")}`,
            cwd: root, filesystem, env: buildSafeChildEnv({ ...attackerHome.env }), exists: existsSync,
            timeoutMs: TOOL_TIMEOUT_POLICY.shellDefaultMs });
          argv = attackerMxc.argv;
          env = buildSafeChildEnv();
        } else {
          attackerWrapped = await wrapToolCommand(attack, { commandId: attacker.token, filesystem,
            binShell: resolveShell("bash").cmd, denyUnixSockets: true });
          argv = attackerWrapped.argv;
          env = buildSandboxedChildEnv(attackerWrapped.env, { ...attackerHome.env });
        }
        const refused = spawnSync(argv[0]!, [...argv.slice(1)], { shell: false, env, encoding: "utf8",
          cwd: windows ? win32.dirname(argv[0]!) : root, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs });
        expect(refused.error).toBeUndefined();
        expect(refused.status).toBe(0);
        refusalOutput = refused.stdout;
      } finally {
        await attackerMxc?.release();
        attacker.release();
        if (attackerWrapped) { await cleanupAsrtSandboxAfterCommand(); await attackerWrapped.cleanupCompleted; }
        attackerHome.cleanup();
      }
      expect(refusalOutput).toContain("write-denied");
      expect(refusalOutput).toContain("read-denied");
      expect(refusalOutput).not.toContain("write-allowed");
      expect(refusalOutput).not.toContain("read-allowed");
      expect(readFileSync(workbookPath)).toEqual(originalWorkbook);

      const otherHome = createSandboxProcessHome();
      try {
        const secret = join(otherHome.path, "private.txt");
        writeFileSync(secret, "other action private bytes");
        const fixture = join(root, "resources");
        const scripts = join(fixture, "skill-scripts");
        mkdirSync(scripts, { recursive: true });
        const probe = join(scripts, "edit-xlsx.cjs");
        const runtime = hostScriptRuntimePaths()!.javascriptRuntime;
        writeFileSync(join(root, "source.xlsx"), "source document");
        const blocked = [join(root, "source.xlsx"), join(root, "source.xlsx.ave-bak"), join(root, "adjacent.tmp"),
          join(otherHome.path, "other-write.txt"), runtime, probe];
        const source = `const fs=require('node:fs');const blocked=${JSON.stringify(blocked)};const results=blocked.map(path=>{try{const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT);fs.closeSync(fd);return 'allowed'}catch(error){return error.code}});try{fs.readFileSync(${JSON.stringify(secret)});results.push('read-allowed')}catch(error){results.push(error.code)};fs.writeFileSync('owned.txt','owned');console.log(JSON.stringify(results));`;
        writeFileSync(probe, source);
        writeFileSync(join(scripts, "manifest.json"), JSON.stringify({ version: 1,
          scripts: { "edit-xlsx.cjs": createHash("sha256").update(source).digest("hex") } }));
        configureHostResources({ resourcePath: fixture, isPackaged: true });
        const results = JSON.parse((await runWorkbookScript(directory, "edit")).stdout) as string[];
        expect(results).toHaveLength(7);
        for (const result of results) expect(result).toMatch(/^(EACCES|EPERM|EROFS|ENOENT)$/);
        expect(readFileSync(join(directory, "owned.txt"), "utf8")).toBe("owned");
        expect(readFileSync(join(root, "source.xlsx"), "utf8")).toBe("source document");
        expect(readFileSync(probe, "utf8")).toBe(source);
        expect(readFileSync(secret, "utf8")).toBe("other action private bytes");

        // Capture the bundle generation first; a later byte change never becomes executable authority.
        writeFileSync(probe, `${source}\n// changed after verification\n`);
        await expect(runWorkbookScript(directory, "edit")).rejects.toMatchObject({ code: "integrity" });

        if (process.platform !== "win32") {
          const descendantSource = "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log(child.pid);";
          writeFileSync(probe, descendantSource);
          writeFileSync(join(scripts, "manifest.json"), JSON.stringify({ version: 1,
            scripts: { "edit-xlsx.cjs": createHash("sha256").update(descendantSource).digest("hex") } }));
          configureHostResources({ resourcePath: fixture, isPackaged: true });
          const descendantPid = Number((await runWorkbookScript(directory, "edit")).stdout.trim());
          expect(Number.isInteger(descendantPid) && descendantPid > 1).toBe(true);
          expect(() => process.kill(descendantPid, 0)).toThrow();
        }

        const waitingSource = "require('node:fs').writeFileSync('ready.txt','ready');setInterval(()=>{},1000);";
        writeFileSync(probe, waitingSource);
        writeFileSync(join(scripts, "manifest.json"), JSON.stringify({ version: 1,
          scripts: { "edit-xlsx.cjs": createHash("sha256").update(waitingSource).digest("hex") } }));
        configureHostResources({ resourcePath: fixture, isPackaged: true });
        const controller = new AbortController();
        const running = runWorkbookScript(directory, "edit", controller.signal);
        const cancelled = expect(running).rejects.toMatchObject({ code: "execution", message: "Document action cancelled" });
        await vi.waitFor(() => expect(existsSync(join(directory, "ready.txt"))).toBe(true), {
          timeout: TOOL_TIMEOUT_POLICY.imagePreparationMs,
        });
        expect(liveEgressInvocationCount()).toBe(1);
        controller.abort();
        await cancelled;
      } finally { otherHome.cleanup(); }

      expect(liveEgressInvocationCount()).toBe(0);
      expect(sandboxProcessHomesInUse().size).toBe(0);
    } finally {
      await resetAsrtSandbox();
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetWindowsSandboxSubstrateForTest();
      configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
      staging.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
});

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate } from "../../permissions/sandbox-capability.js";
import { configureHostResources } from "../../main/host-resources.js";
import { hostScriptRuntimePaths } from "../../main/host-script-runtime.js";
import { BashTool, PowerShellTool } from "../shell-tools.js";
import { parseTableDocument } from "../table-document-reader.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn, setAgentObservationSink } from "../agent-observation-context.js";
import type { DocumentEditJournalRecord } from "../../shared/document-edit-journal.js";

const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Unsupported host tiers carry a per-test skip reason; integrity, probe and execution failures remain failures.
describe("native governed XLSX command", () => {
  it("passes the real shell policy and confines the shipped runtime command", async (testContext) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-xlsx-sandbox-")));
    const path = join(directory, "budget.xlsx");
    const request = join(directory, "edits.json");
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const runtime = hostScriptRuntimePaths()!;
    const script = join(runtime.bundledScriptsDirectory, "edit-xlsx.cjs");
    const originalScript = readFileSync(script);
    const originalRuntime = readFileSync(runtime.javascriptRuntime);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Budget", 12]]), "Sheet");
    writeFileSync(path, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
    writeFileSync(request, JSON.stringify({ sheet: 0, edits: [{ cell: "B1", value: 84 }] }));
    try {
      if (process.platform === "win32") {
        const started = await requireMxcCapability(testContext.skip);
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
      const windows = process.platform === "win32";
      const tool = windows ? new PowerShellTool() : new BashTool();
      const commandFor = (target: string) => windows
        ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${[runtime.javascriptRuntime, script, target, request].map(quotePowerShell).join(" ")}`
        : `ELECTRON_RUN_AS_NODE=1 ${[runtime.javascriptRuntime, script, target, request].map(shellQuote).join(" ")}`;
      const context = { cwd: directory, extraAllowedDirectories: [], metadata: {}, blockReadsOutsideWorkingDirectories: true,
        hostShellExecutionPlan: getHostShellExecutionPlan() };
      expect(context.hostShellExecutionPlan.mode).toBe("asrt");
      const timeoutSeconds = TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000;
      const records: DocumentEditJournalRecord[] = [];
      const leases: Array<{ finish(): Promise<void> }> = [];
      setAgentObservationSink({
        openJournal: (_identity, homePath) => {
          let finished: Promise<void> | undefined;
          const lease = {
            poll: () => {},
            finish: () => {
              if (!finished) {
                const lines = readFileSync(join(homePath, "document-observation", "journal.jsonl"), "utf8");
                records.push(...lines.trim().split("\n").map((line) => JSON.parse(line) as DocumentEditJournalRecord));
                finished = Promise.resolve();
              }
              return finished;
            },
            dispose: () => {},
          };
          leases.push(lease);
          return lease;
        },
        beforeMutation: async () => async () => {},
        finishInvocation: async () => { for (const lease of leases) await lease.finish(); },
        revokeInvocation: () => {},
        finishTurn: () => {},
      });
      const result = await runWithAgentObservationTurn({ sessionId: "sandbox-workbook-session", turnId: "sandbox-workbook-turn" }, () =>
        runWithAgentObservationInvocation({ sessionId: "sandbox-workbook-session", toolUseId: "sandbox-workbook-edit" }, () =>
          tool.execute({ command: commandFor(path), timeoutSeconds }, context),
        ),
      );
      setAgentObservationSink(undefined);
      expect(result.isError, result.output).toBe(false);
      expect(result.metadata?.sandboxed, result.output).toBe(true);
      const document = await parseTableDocument(readFileSync(path), "xlsx", 0);
      expect(document.sheet.rows).toEqual([["Budget", "84"]]);
      expect(document.needsRecalculation).toBe(true);
      expect(records.map((record) => record.kind)).toEqual(["begin", "cell", "commit"]);
      expect(records[0]).toMatchObject({ v: 1, kind: "begin", target: path });
      expect(records[1]).toMatchObject({ v: 1, kind: "cell", sheet: "Sheet", cell: "B1", before: "12", after: "84" });
      expect(records[2]).toMatchObject({ v: 1, kind: "commit" });
      const outside = join(directory, "..", "outside.xlsx");
      const denied = await tool.execute({ command: commandFor(outside), timeoutSeconds }, context);
      expect(denied.isError).toBe(true);
      expect(denied.output).toMatch(/Sandbox:/);
      const redirected = await tool.execute({ command: `${commandFor(path)} > ${windows ? quotePowerShell(outside) : shellQuote(outside)}`, timeoutSeconds }, context);
      expect(redirected.isError).toBe(true);
      const mutation = windows ? `Set-Content -LiteralPath ${quotePowerShell(script)} -Value changed`
        : `printf changed > ${shellQuote(script)}`;
      const protectedResult = await tool.execute({ command: mutation, timeoutSeconds }, { ...context, extraAllowedDirectories: [runtime.bundledScriptsDirectory] });
      expect(protectedResult.isError).toBe(true);
      expect(readFileSync(script)).toEqual(originalScript);
      expect(readFileSync(runtime.javascriptRuntime).equals(originalRuntime)).toBe(true);

      const fixtureResources = join(directory, "host");
      const protectedDirectory = join(fixtureResources, "skill-scripts");
      mkdirSync(protectedDirectory, { recursive: true });
      const probe = join(protectedDirectory, "write-probe.cjs");
      const source = "try { require('node:fs').writeFileSync(__filename, 'changed'); console.log('unexpected-write'); } catch (error) { console.log('write-denied:' + error.code); }";
      writeFileSync(probe, source);
      writeFileSync(join(protectedDirectory, "manifest.json"), JSON.stringify({ version: 1,
        scripts: { "write-probe.cjs": createHash("sha256").update(source).digest("hex") } }));
      configureHostResources({ resourcePath: fixtureResources, isPackaged: true });
      const probeCommand = windows
        ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${[runtime.javascriptRuntime, probe].map(quotePowerShell).join(" ")}`
        : `ELECTRON_RUN_AS_NODE=1 ${[runtime.javascriptRuntime, probe].map(shellQuote).join(" ")}`;
      const nativeWrite = await tool.execute({ command: probeCommand, timeoutSeconds }, context);
      expect(nativeWrite.isError, nativeWrite.output).toBe(false);
      expect(nativeWrite.metadata?.sandboxed).toBe(true);
      expect(nativeWrite.output).toMatch(/(?:^|\n)write-denied:(?:EACCES|EPERM|EROFS)(?:\n|$)/);
      expect(readFileSync(probe, "utf8")).toBe(source);
    } finally {
      setAgentObservationSink(undefined);
      await resetAsrtSandbox();
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetWindowsSandboxSubstrateForTest();
      rmSync(directory, { recursive: true, force: true });
    }
  }, TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
});

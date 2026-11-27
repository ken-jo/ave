import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildSkillScripts } from "../../../scripts/build-skill-scripts.mjs";
import { windowsPeImageDigest } from "../../../scripts/lib/windows-path-kind-image-digest.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../../permissions/asrt-sandbox.js";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { quotePowerShell } from "../../__tests__/support/powershell-literal.js";
import { mxcShellCapability, planWindowsSandbox, windowsProxyOnlyCapability } from "../../boot/steps/windows-sandbox-plan.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  getHostShellExecutionPlan, setActiveSandboxCapability, setContainerShellSubstrate, setShellSandboxRequestedAtBoot, setWindowsSandboxSubstrate } from "../../permissions/sandbox-capability.js";
import { configureHostResources } from "../../main/host-resources.js";
import { buildNativeShellSupervisor } from "../../__tests__/support/mxc-shell-supervisor-native.js";
import { detectHostMxcMacShellSupport } from "../../permissions/mxc-macos.js";
import { establishMxcRuntimeRoot } from "../../permissions/mxc-runtime-root.js";
import * as policyHome from "../../shared/policy-home.js";
import { hostScriptRuntimePaths } from "../../main/host-script-runtime.js";
import { windowsPathKindHelperIn } from "../../main/windows-path-kind-launcher.js";
import * as windowsPathFacts from "../../shared/windows-path-facts.js";
import { WINDOWS_WORKBOOK_IDENTITY_ENV, XLSX_EDIT_LIMITS } from "../../shared/xlsx-edit.js";
import * as mxcShellLaunch from "../mxc-shell-launch.js";
import { BashTool, PowerShellTool } from "../shell-tools.js";
import { parseTableDocument } from "../table-document-reader.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn, setAgentObservationSink } from "../agent-observation-context.js";
import type { DocumentEditJournalRecord } from "../../shared/document-edit-journal.js";

// Unsupported host tiers carry a per-test skip reason; integrity, probe and execution failures remain failures.
describe("native governed XLSX command", () => {
  it("passes the real shell policy and confines the shipped runtime command", async (testContext) => {
    // Native realpath matches the journal's target (8.3 TEMP names expand).
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-xlsx-sandbox-")));
    const path = join(directory, "budget.xlsx");
    const request = join(directory, "edits.json");
    // macOS shells run in the container, started by a supervisor bundled from this source (never a stale dist) whose
    // development layout also holds the host scripts the command runs.
    const mac = process.platform === "darwin";
    if (mac && process.arch !== "arm64") testContext.skip("The macOS shell container requires arm64");
    const supervisors: Array<Awaited<ReturnType<typeof buildNativeShellSupervisor>>> = [];
    const macResources = async () => {
      const supervisor = await buildNativeShellSupervisor();
      supervisors.push(supervisor);
      return supervisor.resources;
    };
    const testScripts = process.env.AVE_TEST_SKILL_SCRIPTS_DIR;
    const developmentScripts = testScripts ?? join(resolve("dist"), "skill-scripts");
    const windows = process.platform === "win32";
    const windowsBuild = windows ? realpathSync.native(mkdtempSync(join(tmpdir(), "ave-xlsx-pinned-build-"))) : undefined;
    const stageWindowsResources = (resourcePath: string) => {
      for (const binary of [join("mxc", process.arch, "wxc-exec.exe"), join("windows-path-kind", process.arch, "ave-path-kind.exe")]) {
        mkdirSync(dirname(join(resourcePath, binary)), { recursive: true });
        copyFileSync(resolve("resources", binary), join(resourcePath, binary));
      }
    };
    const hostResources = mac ? await macResources() : {
      resourcePath: windowsBuild ? join(windowsBuild, "resources") : testScripts ? resolve(testScripts, "../../resources") : resolve("resources"),
      isPackaged: false,
    };
    if (mac) cpSync(developmentScripts, join(hostResources.resourcePath, "..", "dist", "skill-scripts"), { recursive: true });
    if (windowsBuild) {
      stageWindowsResources(hostResources.resourcePath);
      const pin = windowsPeImageDigest(readFileSync(windowsPathKindHelperIn(hostResources.resourcePath)));
      await buildSkillScripts({ directory: join(windowsBuild, "dist", "skill-scripts") });
      vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", pin);
    }
    configureHostResources(hostResources);
    const runtime = hostScriptRuntimePaths()!;
    const script = join(runtime.bundledScriptsDirectory, "edit-xlsx.cjs");
    const originalScript = readFileSync(script);
    const originalRuntime = readFileSync(runtime.javascriptRuntime);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Budget", 12]]), "Sheet");
    let originalWorkbook = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    if (windows) {
      const zip = await JSZip.loadAsync(originalWorkbook);
      zip.file("xl/media/opaque.bin", Buffer.alloc(XLSX_EDIT_LIMITS.backupBytes));
      originalWorkbook = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
      expect(originalWorkbook.length).toBeGreaterThan(XLSX_EDIT_LIMITS.backupBytes);
    }
    writeFileSync(path, originalWorkbook);
    writeFileSync(request, JSON.stringify({ sheet: 0, edits: [{ cell: "B1", value: 84 }] }));
    try {
      if (process.platform === "win32") {
        vi.stubEnv(WINDOWS_WORKBOOK_IDENTITY_ENV, "caller fixture");
        const started = await requireMxcCapability(testContext.skip);
        // Anchor the credential floor to a fixture home: the stamp guard refuses real-account deny targets.
        const policyFixture = join(directory, "policy-home");
        mkdirSync(policyFixture);
        vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([policyFixture]);
        await initializeAsrtSandbox({ allowedDomains: [], windows: { externalConfinement: true } }, async () => false);
        const { substrate } = planWindowsSandbox({ shellRequested: true, workerRequested: false,
          mxc: { state: "available" }, windowsBuild: started.windowsBuild, srtWinReady: false });
        setWindowsSandboxSubstrate(substrate, mxcShellCapability());
        setActiveSandboxCapability(windowsProxyOnlyCapability(substrate));
      } else {
        // A container route takes its egress from the relay, which starts only with an ask callback; this command asks for none.
        await initializeAsrtSandbox({ allowedDomains: [] }, async () => false);
        setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform,
          reason: "Native startup workload succeeded", confines: { filesystem: true, process: true, network: true } });
      }
      setShellSandboxRequestedAtBoot(true);
      const proveMacContainer = async () => {
        establishMxcRuntimeRoot();
        const support = await detectHostMxcMacShellSupport(hostResourcesNow());
        expect(support).toEqual({ state: "available" });
        setContainerShellSubstrate(support);
      };
      let currentResources = hostResources;
      const hostResourcesNow = () => currentResources;
      if (mac) await proveMacContainer();
      const tool = windows ? new PowerShellTool() : new BashTool();
      const commandFor = (target: string, edits = request) => windows
        ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${[runtime.javascriptRuntime, script, target, edits].map(quotePowerShell).join(" ")}`
        : `ELECTRON_RUN_AS_NODE=1 ${[runtime.javascriptRuntime, script, target, request].map(shellQuote).join(" ")}`;
      const context = { cwd: directory, extraAllowedDirectories: [], metadata: {}, blockReadsOutsideWorkingDirectories: true,
        hostShellExecutionPlan: getHostShellExecutionPlan() };
      expect(context.hostShellExecutionPlan).toMatchObject({ mode: "asrt", ...(windows ? {} : { substrate: mac ? "mxc" : "asrt" }) });
      const timeoutSeconds = TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000;
      const records: DocumentEditJournalRecord[] = [];
      const leases: Array<{ finish(): Promise<void> }> = [];
      setAgentObservationSink({
        openJournal: (_identity, homePath) => {
          let finished: Promise<void> | undefined;
          const lease = {
            poll: () => {},
            // Mirrors DocumentJournalReader.poll (src/observation/journal-reader.ts:43-44): a never-created journal is no records.
            finish: () => {
              finished ??= (async () => {
                const journal = join(homePath, "document-observation", "journal.jsonl");
                try { lstatSync(journal); } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                  throw error;
                }
                records.push(...readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line) as DocumentEditJournalRecord));
              })();
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
      expect.soft(result.isError, result.output).toBe(false);
      expect.soft(result.metadata?.sandboxed, result.output).toBe(true);
      if (!result.isError) {
        const document = await parseTableDocument(readFileSync(path), "xlsx", 0);
        expect(document.sheet.rows).toEqual([["Budget", "84"]]);
        expect(document.needsRecalculation).toBe(true);
        expect(records.map((record) => record.kind)).toEqual(["begin", "cell", "commit"]);
        expect(records[0]).toMatchObject({ v: 1, kind: "begin", target: path });
        expect(records[1]).toMatchObject({ v: 1, kind: "cell", sheet: "Sheet", cell: "B1", before: "12", after: "84" });
        expect(records[2]).toMatchObject({ v: 1, kind: "commit" });
      }
      if (windows) {
        if (!result.isError) expect(readFileSync(`${path}.ave-bak`).equals(originalWorkbook)).toBe(true);
        const inHelperAncestor = join(hostResources.resourcePath, "ancestor.xlsx");
        const ancestorRequest = join(hostResources.resourcePath, "edits.json");
        writeFileSync(inHelperAncestor, originalWorkbook);
        copyFileSync(request, ancestorRequest);
        const ancestor = await tool.execute({ command: commandFor(inHelperAncestor, ancestorRequest), timeoutSeconds },
          { ...context, cwd: hostResources.resourcePath });
        expect.soft(ancestor.isError, ancestor.output).toBe(false);
        expect.soft(ancestor.metadata?.sandboxed, ancestor.output).toBe(true);
        if (!ancestor.isError) {
          expect(readFileSync(`${inHelperAncestor}.ave-bak`).equals(originalWorkbook)).toBe(true);
          const edited = await parseTableDocument(readFileSync(inHelperAncestor), "xlsx", 0);
          expect(edited.sheet.rows).toEqual([["Budget", "84"]]);
        }

        const target = join(directory, "gate.xlsx");
        writeFileSync(target, originalWorkbook);
        const prepareMxc = mxcShellLaunch.prepareMxcShellLaunch;
        const prepare = vi.spyOn(mxcShellLaunch, "prepareMxcShellLaunch");
        const readDacls = windowsPathFacts.readWindowsDacls;
        const workspaceNames = readdirSync(directory).sort();
        const refusals: Array<{
          name: string;
          dacl?: (facts: windowsPathFacts.WindowsDaclFacts) => windowsPathFacts.WindowsDaclFacts;
          unreadable?: true;
        }> = [
          { name: "explicit ACE", dacl: facts => ({ ...facts, dacl: { ...facts.dacl!, aces: facts.dacl!.aces.map(ace => ({ ...ace, flags: 0 })) } }) },
          { name: "protected DACL", dacl: facts => ({ ...facts, dacl: { ...facts.dacl!, protected: true } }) },
          { name: "foreign owner", dacl: facts => ({ ...facts, dacl: { ...facts.dacl!, owner: "S-1-5-18" } }) },
          { name: "mandatory label", dacl: facts => ({ ...facts, dacl: { ...facts.dacl!, sacl: { ...facts.dacl!.sacl!, integrityLabel: { sid: "S-1-16-4096", policy: 1, flags: 0 } } } }) },
          { name: "EFS", dacl: facts => ({ ...facts, attributes: facts.attributes | 0x4000 }) },
          { name: "dynamic access control", dacl: facts => ({ ...facts, dacl: { ...facts.dacl!, sacl: { ...facts.dacl!.sacl!, dynamicAccessControl: true } } }) },
          { name: "unreadable facts", unreadable: true },
          { name: "elevated token", dacl: facts => ({ ...facts, elevated: true }) },
          { name: "null DACL", dacl: facts => ({ ...facts, dacl: { ...facts.dacl!, nullDacl: true, aces: [] } }) },
          { name: "unusable file identity", unreadable: true, dacl: facts => ({ ...facts, fileIndex: "0x0000000000000000" }) },
        ];
        for (const refusal of refusals) {
          const dacl = vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation((paths, options) => {
            if (paths.length !== 1 || paths[0] !== target || !options?.parent) return readDacls(paths, options);
            if (refusal.unreadable && !refusal.dacl) throw new Error("Unreadable fixture");
            return readDacls(paths, options).map(facts => refusal.dacl ? refusal.dacl(facts) : facts);
          });
          prepare.mockClear();
          try {
            const denied = await tool.execute({ command: commandFor(target), timeoutSeconds }, context);
            expect.soft(denied.output, refusal.name).toContain(refusal.unreadable ? "[workbook-acl-unreadable]" : "[workbook-acl-differs]");
            expect.soft(denied.isError, refusal.name).toBe(true);
            expect.soft(prepare, refusal.name).toHaveBeenCalledTimes(1);
            expect.soft(readdirSync(directory).sort(), refusal.name).toEqual(workspaceNames);
            expect.soft(readFileSync(target).equals(originalWorkbook), refusal.name).toBe(true);
            if (!denied.isError) {
              rmSync(`${target}.ave-bak`, { force: true });
              writeFileSync(target, originalWorkbook);
            }
          } finally {
            dacl.mockRestore();
          }
        }

        const oldParent = join(directory, "old-parent");
        mkdirSync(oldParent);
        const icacls = join(process.env.SystemRoot!, "System32", "icacls.exe");
        execFileSync(icacls, [oldParent, "/grant", "*S-1-5-7:(OI)(R)"], { stdio: "ignore" });
        const oldPath = join(oldParent, "moved.xlsx");
        const movedPath = join(directory, "moved.xlsx");
        writeFileSync(oldPath, originalWorkbook);
        renameSync(oldPath, movedPath);
        const movedFacts = readDacls([movedPath], { parent: true })[0]!;
        expect(movedFacts.dacl?.aces).toContainEqual(expect.objectContaining({ sid: "S-1-5-7", flags: 0x10 }));
        expect(movedFacts.parent?.aces).not.toContainEqual(expect.objectContaining({ sid: "S-1-5-7", flags: expect.any(Number) }));
        const movedNames = readdirSync(directory).sort();
        prepare.mockClear();
        const moved = await tool.execute({ command: commandFor(movedPath), timeoutSeconds }, context);
        expect.soft(moved.output).toContain("[workbook-acl-differs]");
        expect.soft(moved.isError).toBe(true);
        expect.soft(prepare).toHaveBeenCalledTimes(1);
        expect.soft(readdirSync(directory).sort()).toEqual(movedNames);
        expect.soft(readFileSync(movedPath).equals(originalWorkbook)).toBe(true);
        for (const file of [movedPath, `${movedPath}.ave-bak`]) rmSync(file, { force: true });
        rmSync(oldParent, { recursive: true });

        const labelledParent = join(directory, "labelled-parent");
        const ffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
        const advapi = ffi.load("advapi32.dll");
        const kernel = ffi.load("kernel32.dll");
        const convert = advapi.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32_t, _Out_ void **, void *)");
        const attributes = ffi.struct("DirectorySecurityAttributes", { length: "uint32_t", descriptor: "void *", inherit: "int" });
        const create = kernel.func("int __stdcall CreateDirectoryW(str16, DirectorySecurityAttributes *)");
        const free = kernel.func("void * __stdcall LocalFree(void *)");
        const descriptor = [null];
        expect(convert("S:(ML;OI;NW;;;LW)", 1, descriptor, null)).toBe(1);
        try {
          expect(create(labelledParent, { length: ffi.sizeof(attributes), descriptor: descriptor[0], inherit: 0 })).toBe(1);
        } finally {
          free(descriptor[0]);
        }
        const unlabelled = join(labelledParent, "unlabelled.xlsx");
        renameSync(target, unlabelled);
        const labelledSibling = join(labelledParent, "new-file");
        writeFileSync(labelledSibling, "");
        expect(readDacls([labelledSibling], { access: true })[0]?.dacl?.sacl?.integrityLabel?.sid).toBe("S-1-16-4096");
        rmSync(labelledSibling);
        const [labelFacts] = readDacls([unlabelled], { parent: true, access: true });
        expect(labelFacts?.dacl?.sacl?.integrityLabel).toBeNull();
        expect(labelFacts?.parent?.sacl?.integrityLabel).toMatchObject({ sid: "S-1-16-4096", flags: 1 });
        const labelledNames = readdirSync(labelledParent);
        prepare.mockClear();
        const labelled = await tool.execute({ command: commandFor(unlabelled), timeoutSeconds }, context);
        expect.soft(labelled.output).toContain("[workbook-acl-differs]");
        expect.soft(labelled.isError).toBe(true);
        expect.soft(prepare).toHaveBeenCalledTimes(1);
        expect.soft(readdirSync(labelledParent)).toEqual(labelledNames);
        expect.soft(readFileSync(unlabelled).equals(originalWorkbook)).toBe(true);
        rmSync(unlabelled);
        rmSync(`${unlabelled}.ave-bak`, { force: true });
        rmSync(labelledParent, { recursive: true });
        writeFileSync(target, originalWorkbook);

        const redirectParent = join(directory, "redirect-parent");
        const parkedParent = join(directory, "parked-parent");
        const redirectWorkbook = join(redirectParent, "gate.xlsx");
        mkdirSync(redirectParent);
        writeFileSync(redirectWorkbook, originalWorkbook);
        let redirectedBeforePin = false;
        const access = vi.spyOn(windowsPathFacts, "readWindowsDacls").mockImplementation((paths, options) => {
          if (paths[0] === redirectWorkbook && options?.access) {
            renameSync(redirectParent, parkedParent);
            symlinkSync(directory, redirectParent, "junction");
            redirectedBeforePin = true;
          }
          return readDacls(paths, options);
        });
        try {
          prepare.mockClear();
          const redirected = await tool.execute({ command: commandFor(redirectWorkbook), timeoutSeconds }, context);
          expect.soft(redirectedBeforePin).toBe(true);
          expect.soft(redirected.output).toContain("[workbook-acl-differs]");
          expect.soft(redirected.isError).toBe(true);
          expect.soft(prepare).toHaveBeenCalledTimes(1);
          expect.soft(readdirSync(parkedParent)).toEqual(["gate.xlsx"]);
          expect.soft(readFileSync(join(parkedParent, "gate.xlsx")).equals(originalWorkbook)).toBe(true);
          expect.soft(readdirSync(directory).sort()).toEqual([...workspaceNames, "parked-parent", "redirect-parent"].sort());
          expect.soft(readFileSync(target).equals(originalWorkbook)).toBe(true);
        } finally {
          access.mockRestore();
          if (redirectedBeforePin) rmdirSync(redirectParent);
          rmSync(redirectedBeforePin ? parkedParent : redirectParent, { recursive: true });
        }

        prepare.mockClear();
        const computedCommand = commandFor(target).replace(quotePowerShell(target), "$env:WORKBOOK");
        const computed = await tool.execute({ command: computedCommand, timeoutSeconds }, context);
        expect.soft(computed.isError).toBe(true);
        expect.soft(prepare).toHaveBeenCalledTimes(1);
        expect.soft(readdirSync(directory).sort()).toEqual(workspaceNames);

        const replacement = join(directory, "replacement.xlsx");
        const retired = join(directory, "retired.xlsx");
        writeFileSync(replacement, originalWorkbook);
        const [approved] = readDacls([target], { parent: true });
        const identity = `${approved!.volumeSerialNumber}:${approved!.fileIndex}:${approved!.changeTime}`;
        let swapped = false;
        prepare.mockImplementation((options, lifecycle) => {
          if (options.env[WINDOWS_WORKBOOK_IDENTITY_ENV] !== undefined) {
            expect(options.env[WINDOWS_WORKBOOK_IDENTITY_ENV]).toBe(identity);
            renameSync(target, retired);
            renameSync(replacement, target);
            swapped = true;
          }
          return prepareMxc(options, lifecycle);
        });
        try {
          const stale = await tool.execute({ command: commandFor(target), timeoutSeconds }, context);
          expect.soft(swapped).toBe(true);
          expect.soft(stale.isError).toBe(true);
          expect.soft(stale.output).toContain("Workbook changed before publication");
          expect.soft(readdirSync(directory).sort()).toEqual([...workspaceNames, "retired.xlsx"].sort());
          expect.soft(readFileSync(target).equals(originalWorkbook)).toBe(true);
        } finally {
          prepare.mockRestore();
        }
      }
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

      // A packaged root keeps its scripts beside the resources; the macOS supervisor's development root beside its dist.
      const fixtureResources = mac ? (await macResources()).resourcePath : join(directory, "host");
      const protectedDirectory = mac ? join(fixtureResources, "..", "dist", "skill-scripts") : join(fixtureResources, "skill-scripts");
      mkdirSync(protectedDirectory, { recursive: true });
      const probe = join(protectedDirectory, "write-probe.cjs");
      // The escaped probe keeps the script ASCII; only its output is non-ASCII.
      const source = "console.log('utf8:\\u00e9\\ud55c\\uae00\\u{1f600}'); try { require('node:fs').writeFileSync(__filename, 'changed'); console.log('unexpected-write'); } catch (error) { console.log('write-denied:' + error.code); }";
      writeFileSync(probe, source);
      writeFileSync(join(protectedDirectory, "manifest.json"), JSON.stringify({ version: 1,
        scripts: { "write-probe.cjs": createHash("sha256").update(source).digest("hex") } }));
      if (windows) stageWindowsResources(fixtureResources);
      currentResources = { resourcePath: fixtureResources, isPackaged: !mac };
      configureHostResources(currentResources);
      if (mac) await proveMacContainer();
      const probeCommand = windows
        ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${[runtime.javascriptRuntime, probe].map(quotePowerShell).join(" ")}`
        : `ELECTRON_RUN_AS_NODE=1 ${[runtime.javascriptRuntime, probe].map(shellQuote).join(" ")}`;
      const nativeWrite = await tool.execute({ command: probeCommand, timeoutSeconds }, context);
      expect(nativeWrite.isError, nativeWrite.output).toBe(false);
      expect(nativeWrite.metadata?.sandboxed).toBe(true);
      expect(nativeWrite.output).toMatch(/(?:^|\n)write-denied:(?:EACCES|EPERM|EROFS)(?:\n|$)/);
      expect(nativeWrite.output).toMatch(/(?:^|\n)utf8:é한글\u{1f600}(?:\n|$)/u);
      expect(readFileSync(probe, "utf8")).toBe(source);
    } finally {
      setAgentObservationSink(undefined);
      await resetAsrtSandbox();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetWindowsSandboxSubstrateForTest();
      if (mac) setContainerShellSubstrate({ state: "unavailable", reason: "shell-start-failed" });
      for (const supervisor of supervisors) supervisor.dispose();
      if (windowsBuild) rmSync(windowsBuild, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  }, (TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs) * 3);
});
